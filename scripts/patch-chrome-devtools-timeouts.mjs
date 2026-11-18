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
    original: 'ca0d99e9ea39443679ad7c82e4ea04a4e7c0e463280b35542084ed83f2c55e29',
    prepared: '02f6083e369f6cfb1a69c0ad8dfb00b6ad97106b78bdcdd11670b912694fb7f8',
    replacements: [
      ['const DEFAULT_TIMEOUT = 5_000;', 'const DEFAULT_TIMEOUT = 360_000;'],
      ['const NAVIGATION_TIMEOUT = 10_000;', 'const NAVIGATION_TIMEOUT = 360_000;'],
    ],
  },
  {
    file: 'BrowserManager.js',
    original: '0bab07f29d0ac272c7ae0994b331863119470c4d58b24d36d50397fc1de07709',
    prepared: 'f4fdc2302eeeff546f609ff2f6bf66698c487de2c04aa5f18d8ff814541fe881',
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
  if (manifest.name !== 'chrome-devtools-mcp' || manifest.version !== '1.13.0') throw Error('Unreviewed Chrome SDK version');
  for (const profile of profiles) {
    const path = join(root, 'out/Default/gen/src', profile.file);
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
