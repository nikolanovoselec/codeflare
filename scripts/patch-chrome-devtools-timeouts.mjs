/** Codeflare image-owned derivative of the locked Chrome SDK; never run on live installations.
 * Upstream 1.10.1 exposes per-tool waits but no global base-default setting.
 * Change only two constants; exact original/final hashes fail closed on upstream drift.
 * License and every other installed file remain unchanged. CI exercises the real SDK page.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGINAL = 'd49b2666cb9c6c5b4d7b9130235c476cb8a3af580363ff224796d9dbde99538d';
const PREPARED = '12fc567d3cf0d36eb16b8e9e072ac2fdbd8355ddc235bbb6a5b49c7410d081bf';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function prepareChromeTimeouts(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, 'package.json');
  const path = join(root, 'build/src/McpPage.js');
  for (const file of [manifestPath, path]) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe Chrome SDK file');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'chrome-devtools-mcp' || manifest.version !== '1.10.1') throw Error('Unreviewed Chrome SDK version');
  const original = readFileSync(path, 'utf8');
  const hash = sha256(original);
  if (hash === PREPARED) return;
  if (hash !== ORIGINAL) throw Error('Unreviewed Chrome SDK page bytes');
  const prepared = original.replace('const DEFAULT_TIMEOUT = 5_000;', 'const DEFAULT_TIMEOUT = 360_000;')
    .replace('const NAVIGATION_TIMEOUT = 10_000;', 'const NAVIGATION_TIMEOUT = 360_000;');
  if (sha256(prepared) !== PREPARED) throw Error('Chrome SDK timeout transformation mismatch');
  writeFileSync(path, prepared);
  if (sha256(readFileSync(path)) !== PREPARED) throw Error('Chrome SDK prepared bytes mismatch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: patch-chrome-devtools-timeouts.mjs <locked-package-directory>');
  prepareChromeTimeouts(process.argv[2]);
}
