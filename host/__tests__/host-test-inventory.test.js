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
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectHostGroup } from '../../scripts/ci/select-host-tests.mjs';

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
    // `#` lines carry the per-file reason for the exclusion. They are stripped
    // identically here and in the lane's selection step; if the two ever
    // disagree, the count printed by the lane stops matching what it ran.
    .filter((line) => line && !line.startsWith('#'));

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

  it('assigns every eligible file exactly once across five nonempty deterministic groups', () => {
    const expected = runnable().filter(name => !excluded().includes(name)).sort();
    const groups = Array.from({ length: 5 }, (_, i) => selectHostGroup(`${i + 1}/5`));
    const actual = groups.flat();
    assert.deepEqual([...actual].sort(), expected);
    assert.equal(new Set(actual).size, actual.length);
    for (let i = 0; i < groups.length; i++) {
      assert.ok(groups[i].length > 0);
      assert.deepEqual(selectHostGroup(`${i + 1}/5`), groups[i]);
      assert.ok(!groups[i].some(name => excluded().includes(name)));
    }
  });

  it('moves only the two measured files and preserves every other native baseline owner', () => {
    const expected = runnable().filter(name => !excluded().includes(name)).sort();
    const groups = Array.from({ length: 5 }, (_, i) => selectHostGroup(`${i + 1}/5`));
    for (const [index, name] of expected.entries()) {
      // Node v26.8.2 runner.js: index % shard.total === shard.index - 1.
      const owner = name === 'enforce-review-spawn.test.js' ? 4
        : name === 'pi-lockstep.test.js' ? 1 : index % 5 + 1;
      assert.ok(groups[owner - 1].includes(name), `${name} belongs to group ${owner}`);
    }
  });

  it('emits the selected executable file list without requiring a second native shard', () => {
    const script = join(HERE, '../../scripts/ci/select-host-tests.mjs');
    const result = spawnSync(process.execPath, [script, '3/5'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'),
      selectHostGroup('3/5').map(name => `host/__tests__/${name}`));
  });

  it('requires a completed Host persistence matrix with all 60 passing cases', t => {
    const directory = mkdtempSync(join(tmpdir(), 'host-persistence-receipt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const report = join(directory, 'junit.xml');
    const gate = resolve(HERE, '../../scripts/ci/check-host-persistence-report.py');
    const name = 'REQ-STOR-002/004/011/031/032: production persistence policy matrix';
    const example = (index, evidence = '') =>
      `<testcase name="matrix ${index}" file="/checkout/host/__tests__/entrypoint-rclone-filters.test.js" time="0.1">${evidence}</testcase>`;
    const leaves = Array.from({ length: 60 }, (_, index) => example(index));
    const suite = (cases, tag = 'testsuite') =>
      `<${tag} name="${name}" tests="${cases.length}" skipped="0" failures="0" errors="0">${cases.join('')}</${tag}>`;
    const run = matrix => {
      writeFileSync(report, `<testsuites><testcase name="unrelated"/>${matrix}</testsuites>`);
      return spawnSync('python3', [gate, report], { encoding: 'utf8' });
    };

    const complete = run(suite(leaves));
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /all 60 cases passed/);

    for (const [label, matrix] of [
      ['observed missing tail', suite(leaves.slice(0, 23), 'undefined')],
      ['finished but incomplete', suite(leaves.slice(0, 23))],
      ['duplicate case', suite([...leaves.slice(0, 59), leaves[0]])],
      ['skipped case', suite([...leaves.slice(0, 59), example(59, '<skipped type="skipped"/>')])],
    ]) {
      const result = run(matrix);
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, /Host persistence JUnit report incomplete/, label);
    }
  });

  it('rejects invalid groups, empty partitions, stale exclusions and unsafe filenames before execution', t => {
    for (const group of ['', '0/5', '6/5', '1/4', '1/5 extra']) {
      assert.throws(() => selectHostGroup(group), /host group/);
    }
    const directory = mkdtempSync(join(tmpdir(), 'host-inventory-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'ci-excluded.txt'), '# fixture\n');
    writeFileSync(join(directory, 'only.test.js'), '');
    assert.throws(() => selectHostGroup('1/5', directory), /empty/);
    writeFileSync(join(directory, 'ci-excluded.txt'), 'missing.test.js\n');
    assert.throws(() => selectHostGroup('1/5', directory), /not runnable/);
    writeFileSync(join(directory, 'unsafe name.test.js'), '');
    assert.throws(() => selectHostGroup('1/5', directory), /unsafe/);
  });
});
