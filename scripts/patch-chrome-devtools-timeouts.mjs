/** Codeflare image-owned derivative of the locked Chrome SDK; never run on live installations.
 * Exact original/final hashes guard page defaults and the remote WebSocket CDP budget.
 * Native browser-launch safeguards, licensing and other installed files are unchanged.
 * CI exercises the real SDK page and public remote protocol boundary.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const profiles = [
  {
    file: 'McpPage.js',
    original: 'd49b2666cb9c6c5b4d7b9130235c476cb8a3af580363ff224796d9dbde99538d',
    prepared: '12fc567d3cf0d36eb16b8e9e072ac2fdbd8355ddc235bbb6a5b49c7410d081bf',
    replacements: [
      ['const DEFAULT_TIMEOUT = 5_000;', 'const DEFAULT_TIMEOUT = 360_000;'],
      ['const NAVIGATION_TIMEOUT = 10_000;', 'const NAVIGATION_TIMEOUT = 360_000;'],
    ],
  },
  {
    file: 'BrowserManager.js',
    original: 'e8ad9ae18a6836a0e56771afbf453b4b9ea1d384b4b0db9fccca04300a9fa222',
    prepared: 'cce0a5a0edea5ef8a1264c881c4577d34bb273ac4ebf90f3849aa0fda05a93eb',
    replacements: [[
      '        if (wsEndpoint) {\n            connectOptions.browserWSEndpoint = wsEndpoint;',
      '        if (wsEndpoint) {\n            connectOptions.protocolTimeout = 360_000;\n            connectOptions.browserWSEndpoint = wsEndpoint;',
    ]],
  },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function prepareChromeTimeouts(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, 'package.json');
  const writes = [];
  const info = lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe Chrome SDK file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'chrome-devtools-mcp' || manifest.version !== '1.10.1') throw Error('Unreviewed Chrome SDK version');
  for (const profile of profiles) {
    const path = join(root, 'build/src', profile.file);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe Chrome SDK file');
    const original = readFileSync(path, 'utf8');
    if (sha256(original) === profile.prepared) continue;
    if (sha256(original) !== profile.original) throw Error(`Unreviewed Chrome SDK bytes: ${profile.file}`);
    let prepared = original;
    for (const [before, after] of profile.replacements) prepared = prepared.replace(before, after);
    if (sha256(prepared) !== profile.prepared) throw Error('Chrome SDK timeout transformation mismatch');
    writes.push({ path, prepared, hash: profile.prepared });
  }
  // Validate every reviewed artifact before changing either installed source.
  for (const { path, prepared, hash } of writes) {
    writeFileSync(path, prepared);
    if (sha256(readFileSync(path)) !== hash) throw Error('Chrome SDK prepared bytes mismatch');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: patch-chrome-devtools-timeouts.mjs <locked-package-directory>');
  prepareChromeTimeouts(process.argv[2]);
}
