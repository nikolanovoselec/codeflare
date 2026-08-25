#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NODE_SUITE_FILES } from '../../vitest.node-suite.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEIGHTS_PATH = fileURLToPath(new URL('./backend-test-weights.json', import.meta.url));

function collectTests(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTests(path, output);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      const repoPath = relative(ROOT, path).replaceAll('\\', '/');
      if (/\r|\n/.test(repoPath)) throw new Error(`test path contains a newline: ${JSON.stringify(repoPath)}`);
      output.push(repoPath);
    }
  }
  return output;
}

export function assignWeightedFiles(files, weights, groupCount) {
  if (!Number.isSafeInteger(groupCount) || groupCount < 1) throw new Error('group count must be a positive integer');
  if (new Set(files).size !== files.length) throw new Error('test file list contains duplicates');
  const knownWeights = Object.values(weights);
  if (knownWeights.length === 0 || knownWeights.some((weight) => !Number.isSafeInteger(weight) || weight < 1)) {
    throw new Error('test weights must be positive integers');
  }
  const unknownWeight = Math.max(...knownWeights);
  const groups = Array.from({ length: groupCount }, (_, index) => ({ index, weight: 0, files: [] }));
  for (const file of [...files].sort((left, right) => {
    const weightDelta = (weights[right] ?? unknownWeight) - (weights[left] ?? unknownWeight);
    return weightDelta || left.localeCompare(right);
  })) {
    groups.sort((left, right) => left.weight - right.weight || left.index - right.index);
    groups[0].files.push(file);
    groups[0].weight += weights[file] ?? unknownWeight;
  }
  return groups.sort((left, right) => left.index - right.index).map((group) => group.files.sort());
}

export function selectBackendGroup(group, weightDocument = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8'))) {
  const match = /^(\d+)\/(\d+)$/.exec(group ?? '');
  if (!match) throw new Error('group must use index/count syntax');
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) throw new Error('group index is out of range');
  const nodeFiles = new Set(NODE_SUITE_FILES);
  const files = collectTests(join(ROOT, 'src')).filter((file) => !nodeFiles.has(file));
  const groups = assignWeightedFiles(files, weightDocument.weights, count);
  if (groups[index - 1].length === 0) throw new Error(`weighted backend group ${group} is empty`);
  return groups[index - 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(`${selectBackendGroup(process.argv[2]).join('\n')}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
