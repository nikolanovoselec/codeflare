// The host lane runs `host/__tests__/*.test.js` minus ci-excluded.txt. Both
// halves of that selection can silently stop covering things:
//
//   - a test written as .test.mjs/.test.ts, or placed in a subdirectory, matches
//     no glob and never runs, while the lane stays green;
//   - an exclusion naming a file that no longer exists suppresses nothing and
//     hides the fact that the list has drifted from the tree.
//
// Neither failure produces a red build on its own, so it is asserted here. This
// file is itself part of the selection, so the check ships with the thing it
// checks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

const ANY_TEST_FILE = /\.(test|spec)\.[a-z]+$/;
const LANE_GLOB = /^[^/]+\.test\.js$/;

function walk(current) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = join(current, entry.name);
    if (entry.isDirectory()) return walk(full);
    return ANY_TEST_FILE.test(entry.name) ? [relative(HERE, full)] : [];
  });
}

const runnable = () => readdirSync(HERE).filter((name) => LANE_GLOB.test(name));

const excluded = () =>
  readFileSync(join(HERE, 'ci-excluded.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

describe('host test inventory', () => {
  it('leaves every test file reachable by the lane glob', () => {
    const unreachable = walk(HERE).filter((rel) => !LANE_GLOB.test(rel));
    assert.deepEqual(
      unreachable,
      [],
      `these files do not match host/__tests__/*.test.js, so the host lane never runs them: ${unreachable.join(', ')}`
    );
  });

  it('excludes only files that exist and would otherwise run', () => {
    const present = new Set(runnable());
    const stale = excluded().filter((name) => !present.has(name));
    assert.deepEqual(
      stale,
      [],
      `ci-excluded.txt lists files that are not runnable host tests: ${stale.join(', ')}`
    );
  });

  it('leaves tests to run, including this check', () => {
    const skip = new Set(excluded());
    const remaining = runnable().filter((name) => !skip.has(name));
    assert.ok(remaining.length > 0, 'ci-excluded.txt excludes every host test, so the lane runs nothing');
    assert.ok(
      remaining.includes(SELF),
      'this inventory check is excluded from CI, so nothing enforces the host test inventory'
    );
  });
});
