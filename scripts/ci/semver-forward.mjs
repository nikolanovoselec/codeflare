#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const NUMERIC_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseNumericSemver(value, label) {
  const match = NUMERIC_SEMVER.exec(value);
  if (!match) {
    throw new Error(`${label} must be a numeric semantic version (x.y.z), got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map(Number);
}

export function strictSemverUpgrade(current, candidate) {
  const currentParts = parseNumericSemver(current, 'current version');
  const candidateParts = parseNumericSemver(candidate, 'candidate version');

  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) return true;
    if (candidateParts[index] < currentParts[index]) return false;
  }
  return false;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , current, candidate] = process.argv;
  try {
    process.stdout.write(strictSemverUpgrade(current ?? '', candidate ?? '') ? 'upgrade\n' : 'skip\n');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
