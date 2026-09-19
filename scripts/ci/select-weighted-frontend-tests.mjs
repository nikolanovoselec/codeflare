#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assignWeightedFiles } from './select-weighted-backend-tests.mjs';

const WEB_ROOT = fileURLToPath(new URL('../../web-ui', import.meta.url));
const TEST_ROOT = join(WEB_ROOT, 'src', '__tests__');
const WEIGHTS_PATH = fileURLToPath(new URL('./frontend-test-weights.json', import.meta.url));

function collectTests(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTests(path, output);
    else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx'))) {
      const webPath = relative(WEB_ROOT, path).replaceAll('\\', '/');
      if (/\r|\n/.test(webPath)) throw new Error(`test path contains a newline: ${JSON.stringify(webPath)}`);
      output.push(webPath);
    }
  }
  return output;
}

export function listFrontendTests() {
  return collectTests(TEST_ROOT).sort();
}

export function selectFrontendGroup(group, weightDocument = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8'))) {
  const match = /^(\d+)\/(\d+)$/.exec(group ?? '');
  if (!match) throw new Error('group must use index/count syntax');
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) throw new Error('group index is out of range');
  const groups = assignWeightedFiles(listFrontendTests(), weightDocument.weights, count, weightDocument.fileOverheadMs);
  if (groups[index - 1].length === 0) throw new Error(`weighted frontend group ${group} is empty`);
  return groups[index - 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(`${selectFrontendGroup(process.argv[2]).join('\n')}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
