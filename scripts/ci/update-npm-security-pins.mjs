#!/usr/bin/env node
// One weekly owner for npm pins Dependabot cannot see: image overlays and
// manifest overrides. Registry bytes are never executed by this updater.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strictSemverUpgrade } from './semver-forward.mjs';

export const SECURITY_PIN_OWNERS = Object.freeze({
  tar: { overlay: 'NODE_TAR' },
  'brace-expansion': { overlay: 'BRACE_EXPANSION', floor: 'BRACE_EXPANSION' },
  'undici-6': { package: 'undici', overlay: 'UNDICI_NPM' },
  'undici-7': { package: 'undici', overlay: 'UNDICI_IDE', floor: 'UNDICI_7' },
  'undici-8': { package: 'undici', floor: 'UNDICI_8' },
  pacote: { overlay: 'PACOTE' },
  'basic-ftp': { overlay: 'BASIC_FTP' },
  'follow-redirects': { overlay: 'FOLLOW_REDIRECTS' },
  'shell-quote': { overlay: 'SHELL_QUOTE' },
  'ip-address': { floor: 'IP_ADDRESS' },
  'body-parser': {},
  'fast-uri': {},
  hono: {},
  '@hono/node-server': {},
  protobufjs: {},
  ws: {},
});
const MANIFESTS = ['package.json', 'preseed/agents/pi/package.json', 'preseed/npm-tools/package.json',
  'preseed/agents/claude/browser-run-mcp/package.json', '.github/npm-tools/wrangler/package.json'];
const FLOOR_PATH = 'scripts/apply-npm-security-lock-pins.mjs';
const FLOOR_TEST = 'host/__tests__/npm-security-lock-pins.test.js';
const VERSION = /^\d+\.\d+\.\d+$/;
function one(source, pattern, replacement, label) {
  if ([...source.matchAll(new RegExp(pattern.source, 'g'))].length !== 1) throw new Error(`missing or ambiguous ${label}`);
  return source.replace(pattern, replacement);
}
function ownerFor(id) {
  if (!Object.hasOwn(SECURITY_PIN_OWNERS, id)) throw new Error(`unsupported security pin: ${id}`);
  return { ...SECURITY_PIN_OWNERS[id], package: SECURITY_PIN_OWNERS[id].package ?? id };
}

export function currentSecurityVersion(files, id) {
  const owner = ownerFor(id);
  if (owner.overlay) {
    const match = files.Dockerfile.match(new RegExp(`${owner.overlay}_VERSION="(\\d+\\.\\d+\\.\\d+)"`));
    if (!match) throw new Error(`missing ${id} overlay version`);
    return match[1];
  }
  if (owner.floor) {
    const match = files[FLOOR_PATH].match(new RegExp(`const ${owner.floor}_[\\d_]+ = Object.freeze\\(\\{\\s*version: ['"]([^'"]+)['"]`));
    if (!match) throw new Error(`missing ${id} security floor`);
    return match[1];
  }
  for (const path of MANIFESTS) {
    const version = JSON.parse(files[path]).overrides?.[owner.package];
    if (typeof version === 'string' && VERSION.test(version.replace(/^[~^]/, ''))) return version.replace(/^[~^]/, '');
  }
  throw new Error(`missing override for ${id}`);
}

export function updateNpmSecurityPins(files, id, current, candidate) {
  const owner = ownerFor(id);
  const { version, dist, engines, license } = candidate;
  if (!VERSION.test(current) || !VERSION.test(version) || !strictSemverUpgrade(current, version) ||
      current.split('.')[0] !== version.split('.')[0]) throw new Error('security bumps must advance within the pinned major');
  if (candidate.name !== owner.package || dist?.tarball !== `https://registry.npmjs.org/${owner.package}/-/${owner.package.split('/').at(-1)}-${version}.tgz` ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist?.integrity ?? '')) throw new Error('untrusted registry identity or SHA512 integrity');
  if (currentSecurityVersion(files, id) !== current) throw new Error('security pin changed during resolution');
  const next = { ...files };
  if (owner.overlay) {
    let source = one(files.Dockerfile, new RegExp(`${owner.overlay}_VERSION="${current.replaceAll('.', '\\.')}"`),
      `${owner.overlay}_VERSION="${version}"`, `${id} version`);
    source = one(source, new RegExp(`${owner.overlay}_SHA512="[a-f0-9]{128}"`),
      `${owner.overlay}_SHA512="${Buffer.from(dist.integrity.slice(7), 'base64').toString('hex')}"`, `${id} digest`);
    next.Dockerfile = source;
  }
  for (const path of MANIFESTS) {
    const manifest = JSON.parse(files[path]);
    let changed = false;
    for (const section of ['overrides']) {
      const old = manifest[section]?.[owner.package];
      if (typeof old !== 'string') continue;
      const match = old.match(/^([~^]?)(\d+\.\d+\.\d+)$/);
      // Never move another major (notably Undici 7 versus Undici 8), or
      // downgrade an already newer override merely to align an older overlay.
      if (!match || match[2].split('.')[0] !== version.split('.')[0] || !strictSemverUpgrade(match[2], version)) continue;
      manifest[section][owner.package] = match[1] + version;
      changed = true;
    }
    if (changed) next[path] = JSON.stringify(manifest, null, 2) + '\n';
  }
  if (owner.floor) {
    const pattern = new RegExp(`const (${owner.floor}_[\\d_]+) = Object.freeze\\(\\{[\\s\\S]*?\\n\\}\\);`);
    const match = files[FLOOR_PATH].match(pattern);
    if (!match) throw new Error(`missing ${id} floor`);
    const floorVersion = match[0].match(/version: ['"]([^'"]+)['"]/)?.[1];
    if (floorVersion && strictSemverUpgrade(floorVersion, version)) {
      const name = `${owner.floor.replace(/^UNDICI_[78]$/, 'UNDICI')}_${version.replaceAll('.', '_')}`;
      const pin = { version, resolved: dist.tarball, integrity: dist.integrity, license, ...(engines ? { engines } : {}) };
      if (typeof license !== 'string') throw new Error('registry license is missing');
      if (candidate.dependencies) pin.dependencies = candidate.dependencies;
      const block = `const ${name} = Object.freeze(${JSON.stringify(pin, null, 2).replace(/"([A-Za-z]+)":/g, '$1:')});`;
      next[FLOOR_PATH] = one(files[FLOOR_PATH], pattern, block, `${id} floor`).replaceAll(match[1], name);
      if (files[FLOOR_TEST]) {
        const oldIntegrity = match[0].match(/integrity: ['"]([^'"]+)['"]/)?.[1];
        if (!oldIntegrity) throw new Error('floor integrity is missing');
        next[FLOOR_TEST] = files[FLOOR_TEST]
          .replaceAll(`version: '${floorVersion}'`, `version: '${version}'`)
          .replaceAll(`https://registry.npmjs.org/${owner.package}/-/${owner.package.split('/').at(-1)}-${floorVersion}.tgz`, dist.tarball)
          .replaceAll(oldIntegrity, dist.integrity);
      }

    }
  }
  return next;
}

async function main() {
  const [id, command = 'resolve'] = process.argv.slice(2);
  const owner = ownerFor(id);
  const files = Object.fromEntries(['Dockerfile', FLOOR_PATH, FLOOR_TEST, ...MANIFESTS].map(path => [path, readFileSync(path, 'utf8')]));
  const current = currentSecurityVersion(files, id);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(owner.package)}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`registry metadata failed: ${response.status}`);
  const metadata = await response.json();
  const cutoff = Date.now() - 7 * 86400_000;
  const versions = Object.keys(metadata.versions ?? {}).filter(version => VERSION.test(version) &&
    version.split('.')[0] === current.split('.')[0] && Number.isFinite(Date.parse(metadata.time?.[version])) &&
    Date.parse(metadata.time[version]) < cutoff).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = versions.at(-1);
  if (!version || !strictSemverUpgrade(current, version)) {
    if (command === 'resolve') process.stdout.write(`skip=true\ncurrent=${current}\n`);
    return;
  }
  if (command === 'resolve') {
    process.stdout.write(`current=${current}\nlatest=${version}\n`);
    return;
  }
  if (command !== 'apply' || process.env.CUR !== current || process.env.LAT !== version) throw new Error('candidate changed since resolution');
  const next = updateNpmSecurityPins(files, id, current, metadata.versions[version]);
  // Calculate every destination before writing any change.
  for (const [path, source] of Object.entries(next)) if (source !== files[path]) writeFileSync(path, source);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
