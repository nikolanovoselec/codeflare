#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function resolveProjectRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('/review repository root is unavailable.');
  }

  return execFileSync('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function main() {
  if (process.argv.length !== 3) {
    process.stderr.write('ERROR: /review repository root is unavailable.\n');
    process.exitCode = 1;
    return;
  }

  try {
    process.stdout.write(`${resolveProjectRoot(process.argv[2])}\n`);
  } catch {
    process.stderr.write('ERROR: /review repository root is unavailable.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
