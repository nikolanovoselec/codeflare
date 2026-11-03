#!/usr/bin/env node
// Named image/CI pins only; no package manager or third-party binary execution.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strictSemverUpgrade } from './semver-forward.mjs';

const PINS = '.github/workflow-tool-pins.json';
const K6 = '.github/actions/install-k6/action.yml';
const PATHS = ['Dockerfile', PINS, K6];
export const IMAGE_PIN_IDS = Object.freeze(['go', 'rust', 'rclone', 'grpc', 'compress', 'github-cli', 'k6', 'trivy', 'ci-node-26', 'ci-node-22']);
const VERSION = /^\d+\.\d+\.\d+$/;
const HASH = /^[a-f0-9]{64}$/;
function once(source, pattern, replacement, label) {
  if ([...source.matchAll(new RegExp(pattern.source, [...new Set(`${pattern.flags}g`)].join('')))].length !== 1) throw new Error(`missing or ambiguous ${label}`);
  return source.replace(pattern, replacement);
}
function match(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, [...new Set(`${pattern.flags}g`)].join('')))];
  if (matches.length !== 1) throw new Error(`missing or ambiguous ${label}`);
  return matches[0];
}
export function currentImagePin(files, id) {
  const docker = files.Dockerfile;
  switch (id) {
    case 'go': return match(docker, /go(\d+\.\d+\.\d+)\.linux-amd64\.tar\.gz/, id)[1];
    case 'rust': return match(docker, /https:\/\/static\.rust-lang\.org\/dist\/(\d{4}-\d{2}-\d{2})\/rust-(\d+\.\d+\.\d+)-x86_64-unknown-linux-gnu\.tar\.xz/, id)[2];
    case 'rclone': return match(docker, /refs\/tags\/v(\d+\.\d+\.\d+) -o \/tmp\/rclone.tar.gz/, id)[1];
    case 'grpc': return match(docker, /google\.golang\.org\/grpc@v(\d+\.\d+\.\d+)/, id)[1];
    case 'compress': return match(docker, /github\.com\/klauspost\/compress@v(\d+\.\d+\.\d+)/, id)[1];
    case 'github-cli': return match(docker, /GH_VERSION="(\d+\.\d+\.\d+)"/, id)[1];
    case 'k6': return match(files[K6], /default: '(\d+\.\d+\.\d+)'/, id)[1];
    case 'trivy': return JSON.parse(files[PINS]).trivy.version;
    case 'ci-node-26':
    case 'ci-node-22': {
      return JSON.parse(files[PINS])[id].version;
    }
    default: throw new Error(`unsupported image pin: ${id}`);
  }
}
export function updateShadowImagePins(files, id, current, candidate) {
  const { version, sha256, date, ciSha256 } = candidate;
  if (!VERSION.test(current) || !VERSION.test(version) || !strictSemverUpgrade(current, version) || current.split('.')[0] !== version.split('.')[0]) {
    throw new Error('image bumps must advance within the pinned major');
  }
  if (id.startsWith('ci-node-') && current.split('.').slice(0, 2).join('.') !== version.split('.').slice(0, 2).join('.')) {
    throw new Error('explicit CI Node pins are patch-only; runtime/type contracts need separate review');
  }
  if (currentImagePin(files, id) !== current) throw new Error('pin changed since resolution');
  const next = { ...files };
  let docker = files.Dockerfile;
  if (['go', 'rust', 'github-cli', 'k6'].includes(id) && !HASH.test(sha256 ?? '')) throw new Error('an authoritative SHA256 is required');
  switch (id) {
    case 'go':
      docker = once(docker, /go\d+\.\d+\.\d+\.linux-amd64\.tar\.gz/, `go${version}.linux-amd64.tar.gz`, id);
      docker = once(docker, /[a-f0-9]{64}(?=  \/tmp\/go.tar.gz)/, sha256, `${id} checksum`);
      break;
    case 'rust': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('Rust publication date is required');
      const block = match(docker, /RUN curl -fsSL https:\/\/static\.rust-lang\.org\/dist\/[\s\S]*?(?=\nCOPY image\/impeccable)/, id)[0];
      const oldDate = match(block, /dist\/(\d{4}-\d{2}-\d{2})\/rust-/, id)[1];
      const updated = block.replaceAll(`rust-${current}-`, `rust-${version}-`).replace(`dist/${oldDate}/`, `dist/${date}/`);
      docker = docker.replace(block, once(updated, /[a-f0-9]{64}(?=  \/tmp\/rust.tar.xz)/, sha256, `${id} checksum`));
      break;
    }
    case 'rclone': {
      if (!HASH.test(ciSha256 ?? '')) throw new Error('rclone CI archive checksum is required');
      // GitHub codeload publishes no source-archive digest. Invalidate, never
      // reuse an old hash or silently bless unreviewed source compatibility.
      docker = docker.replaceAll(`rclone/tar.gz/refs/tags/v${current}`, `rclone/tar.gz/refs/tags/v${version}`)
        .replace(`patch-rclone-bisync.py /src/rclone ${current}`, `patch-rclone-bisync.py /src/rclone ${version}`)
        .replace(`fs.Version=v${current}-codeflare-bisync1`, `fs.Version=v${version}-codeflare-bisync1`);
      docker = once(docker, /[a-f0-9]{64}(?=  \/tmp\/rclone.tar.gz)/, 'NEEDS_UPDATE_SEE_PR_BODY', 'rclone source checksum');
      const pins = JSON.parse(files[PINS]);
      if (pins.rclone.version !== current) throw new Error('rclone image/CI version drift');
      pins.rclone = { version, sha256: ciSha256 };
      next[PINS] = JSON.stringify(pins, null, 2) + '\n';
      break;
    }
    case 'grpc': docker = once(docker, /google\.golang\.org\/grpc@v\d+\.\d+\.\d+/, `google.golang.org/grpc@v${version}`, id); break;
    case 'compress': docker = once(docker, /github\.com\/klauspost\/compress@v\d+\.\d+\.\d+/, `github.com/klauspost/compress@v${version}`, id); break;
    case 'github-cli':
      docker = once(docker, /GH_VERSION="[^"]+"/, `GH_VERSION="${version}"`, id);
      docker = once(docker, /GH_SHA256="[a-f0-9]{64}"/, `GH_SHA256="${sha256}"`, `${id} checksum`);
      break;
    case 'k6':
      next[K6] = once(once(files[K6], /default: '\d+\.\d+\.\d+'/, `default: '${version}'`, id), /default: '[a-f0-9]{64}'/, `default: '${sha256}'`, `${id} checksum`);
      break;
    case 'trivy':
      next[PINS] = JSON.stringify({ ...JSON.parse(files[PINS]), trivy: { version } }, null, 2) + '\n';
      break;
    case 'ci-node-26':
    case 'ci-node-22':
      next[PINS] = JSON.stringify({ ...JSON.parse(files[PINS]), [id]: { version } }, null, 2) + '\n';
      break;
    default: throw new Error(`unsupported image pin: ${id}`);
  }
  next.Dockerfile = docker;
  return next;
}
async function request(url, json = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'codeflare-shadow-pin-bot' } });
  if (!response.ok) throw new Error(`metadata request failed: ${response.status} ${url}`);
  return json ? response.json() : response.text();
}
function latestWithin(current, versions, patchOnly = false) {
  return versions.filter(version => VERSION.test(version) && version.split('.')[0] === current.split('.')[0] &&
    (!patchOnly || version.split('.').slice(0, 2).join('.') === current.split('.').slice(0, 2).join('.')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}
export async function resolveCandidate(id, current) {
  if (id === 'go') {
    const releases = await request('https://go.dev/dl/?mode=json&include=all', true);
    const version = latestWithin(current, releases.filter(value => value.stable).map(value => value.version.replace(/^go/, '')), true);
    const file = releases.find(value => value.version === `go${version}`)?.files.find(value => value.filename === `go${version}.linux-amd64.tar.gz`);
    if (!file) throw new Error('Go linux-amd64 release checksum missing');
    return { version, sha256: file.sha256 };
  }
  if (id === 'rust') {
    const manifest = await request('https://static.rust-lang.org/dist/channel-rust-stable.toml');
    const date = match(manifest, /^date = "([^"]+)"/m, 'Rust date')[1];
    const section = match(manifest, /\[pkg.rust.target.x86_64-unknown-linux-gnu\]\n([\s\S]*?)(?=\n\[)/, 'Rust target')[1];
    const url = match(section, /xz_url = "(https:\/\/static\.rust-lang\.org\/dist\/[^\"]+)"/, 'Rust archive')[1];
    const version = match(url, /rust-(\d+\.\d+\.\d+)-/, 'Rust version')[1];
    const sha256 = match(section, /xz_hash = "([a-f0-9]{64})"/, 'Rust digest')[1];
    if (!url.includes(`/dist/${date}/rust-${version}-x86_64-unknown-linux-gnu.tar.xz`)) throw new Error('Rust target identity mismatch');
    return { version, date, sha256 };
  }
  if (id === 'grpc' || id === 'compress') {
    const module = id === 'grpc' ? 'google.golang.org/grpc' : 'github.com/klauspost/compress';
    const versions = (await request(`https://proxy.golang.org/${module}/@v/list`)).trim().split('\n').map(value => value.replace(/^v/, ''));
    return { version: latestWithin(current, versions) };
  }
  if (id.startsWith('ci-node-')) {
    const releases = await request('https://nodejs.org/dist/index.json', true);
    return { version: latestWithin(current, releases.map(value => value.version.replace(/^v/, '')), true) };
  }
  const repo = { 'github-cli': 'cli/cli', rclone: 'rclone/rclone', k6: 'grafana/k6', trivy: 'aquasecurity/trivy' }[id];
  if (!repo) throw new Error(`unsupported release owner: ${id}`);
  const releases = await request(`https://api.github.com/repos/${repo}/releases?per_page=100`, true);
  const release = releases.filter(value => !value.draft && !value.prerelease)
    .filter(value => VERSION.test(value.tag_name.replace(/^v/, '')))
    .filter(value => value.tag_name.replace(/^v/, '').split('.')[0] === current.split('.')[0])
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name, undefined, { numeric: true }))[0];
  if (!release) throw new Error('no same-major release candidate');
  const version = release.tag_name.replace(/^v/, '');
  if (id === 'trivy') return { version };
  if (id === 'rclone') {
    const sums = await request(`https://downloads.rclone.org/v${version}/SHA256SUMS`);
    const ciSha256 = match(sums, new RegExp(`^([a-f0-9]{64})\\s+\\*?rclone-v${version.replaceAll('.', '\\.')}\\-linux-amd64\\.zip$`, 'm'), 'rclone CI archive digest')[1];
    return { version, ciSha256 };
  }
  const assetName = id === 'github-cli' ? `gh_${version}_linux_amd64.deb` : `k6-v${version}-linux-amd64.tar.gz`;
  const asset = release.assets.find(value => value.name === assetName);
  if (asset && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
    return { version, sha256: asset.digest.slice(7) };
  }
  // Older k6 release assets predate GitHub's digest field. Keep publisher
  // authentication using that same release's checksum asset, never a self-hash.
  if (id === 'k6' && asset && asset.digest == null) {
    const sumsName = `k6-v${version}-checksums.txt`;
    if (!release.assets.some(value => value.name === sumsName)) throw new Error('k6 publisher checksum asset missing');
    const sums = await request(`https://github.com/grafana/k6/releases/download/v${version}/${sumsName}`);
    const sha256 = match(sums, new RegExp(`^([a-f0-9]{64})\\s+\\*?${assetName.replaceAll('.', '\\.')}\\r?$`, 'm'), 'k6 publisher archive digest')[1];
    return { version, sha256 };
  }
  throw new Error(`authoritative GitHub digest missing for ${assetName}`);
}
async function main() {
  const [id, command = 'resolve'] = process.argv.slice(2);
  const files = Object.fromEntries(PATHS.map(path => [path, readFileSync(path, 'utf8')]));
  const current = currentImagePin(files, id);
  const candidate = await resolveCandidate(id, current);
  if (!candidate.version || !strictSemverUpgrade(current, candidate.version)) {
    if (command === 'resolve') process.stdout.write('skip=true\n');
    return;
  }
  if (command === 'resolve') { process.stdout.write(`current=${current}\nlatest=${candidate.version}\ncandidate=${JSON.stringify(candidate)}\n`); return; }
  if (command !== 'apply' || process.env.CUR !== current || process.env.CANDIDATE !== JSON.stringify(candidate)) throw new Error('candidate changed since resolution');
  const next = updateShadowImagePins(files, id, current, candidate);
  for (const [path, source] of Object.entries(next)) if (source !== files[path]) writeFileSync(path, source);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
