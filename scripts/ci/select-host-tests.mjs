#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_TESTS = fileURLToPath(new URL('../../host/__tests__', import.meta.url));

export function selectHostGroup(group, directory = HOST_TESTS) {
  const match = /^([1-5])\/5$/.exec(group ?? '');
  if (!match) throw new Error('host group must be 1/5 through 5/5');
  const runnable = readdirSync(directory).filter(name => name.endsWith('.test.js')).sort();
  if (runnable.some(name => !/^[A-Za-z0-9._-]+\.test\.js$/.test(name))) {
    throw new Error('host test filename is unsafe for the executable file list');
  }
  const excluded = readFileSync(join(directory, 'ci-excluded.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const name of excluded) {
    if (!runnable.includes(name)) throw new Error(`excluded host test is not runnable: ${name}`);
  }
  const files = runnable.filter(name => !excluded.includes(name));
  const groups = Array.from({ length: 5 }, () => []);
  for (const [index, name] of files.entries()) {
    // Preserve Node v26.8.2 lib/internal/test_runner/runner.js's native rule:
    // index % shard.total === shard.index - 1. Override only these two files.
    // Run 44362862978: review enforcement 37.57s; extension warming 14.02s.
    const owner = name === 'enforce-review-spawn.test.js' ? 4
      : name === 'pi-lockstep.test.js' ? 1 : index % 5 + 1;
    groups[owner - 1].push(name);
  }
  if (groups.some(files => files.length === 0)) throw new Error('host group is empty');
  return groups[Number(match[1]) - 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(`${selectHostGroup(process.argv[2]).map(name => `host/__tests__/${name}`).join('\n')}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
