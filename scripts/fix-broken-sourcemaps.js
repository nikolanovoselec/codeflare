// @cloudflare/containers@0.1.0 ships .js.map files that reference TypeScript
// source files not included in the npm package. This causes Vite/Vitest to log
// "Sourcemap for X points to missing source files" warnings during test runs.
//
// This script strips the sourceMappingURL comments from the affected dist files
// so the broken sourcemaps are never loaded. Safe to re-run (idempotent).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const files = [
  'node_modules/@cloudflare/containers/dist/index.js',
  'node_modules/@cloudflare/containers/dist/lib/container.js',
  'node_modules/@cloudflare/containers/dist/lib/helpers.js',
  'node_modules/@cloudflare/containers/dist/lib/utils.js',
];

let fixed = 0;
for (const rel of files) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;

  const content = readFileSync(abs, 'utf8');
  const cleaned = content.replace(/\n?\/\/# sourceMappingURL=.*$/m, '');
  if (cleaned !== content) {
    writeFileSync(abs, cleaned);
    fixed++;
  }
}

if (fixed > 0) {
  console.log(`fix-broken-sourcemaps: stripped ${fixed} broken sourcemap reference(s) from @cloudflare/containers`);
}
