// Behavioral coverage for REQ-AGENT-135, REQ-AGENT-136, and REQ-AGENT-137.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const skillScripts = resolve('preseed/agents/claude/skills/ui-ux-pro-max/scripts');
const temporaryDirectories = [];

function runPython(args) {
  return spawnSync('python3', args, { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('UI UX Pro Max runtime contract', () => {
  it('REQ-AGENT-135: returns matching records and a generated recommendation', () => {
    const search = runPython([join(skillScripts, 'search.py'), 'saas software', '--domain', 'product', '--json']);
    assert.equal(search.status, 0, search.stderr);
    const result = JSON.parse(search.stdout);
    assert.equal(result.domain, 'product');
    assert.ok(result.count > 0);
    assert.ok(result.results.some((record) => record['Product Type'] === 'SaaS (General)'));

    const generated = runPython([
      join(skillScripts, 'search.py'), 'saas analytics dashboard', '--design-system', '--json',
    ]);
    assert.equal(generated.status, 0, generated.stderr);
    assert.ok(JSON.parse(generated.stdout).design_system.pattern);
  });

  it('REQ-AGENT-136: safely persists design systems without overwriting by default', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'design-skill-'));
    temporaryDirectories.push(outputRoot);
    const args = [
      join(skillScripts, 'search.py'), 'saas analytics dashboard', '--design-system', '--json',
      '--project-name', '../../Customer Portal', '--persist', '--page', '../overview', '--output-dir', outputRoot,
    ];
    const generated = runPython(args);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(generated.stdout).persistence.status, 'success');
    const master = join(outputRoot, 'design-system', 'customer-portal', 'MASTER.md');
    const page = join(outputRoot, 'design-system', 'customer-portal', 'pages', 'overview.md');
    assert.ok(readFileSync(master, 'utf8').length > 0);
    assert.ok(readFileSync(page, 'utf8').length > 0);

    writeFileSync(master, 'preserve prior decisions\n');
    const repeated = runPython(args);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).persistence.status, 'skipped_exists');
    assert.equal(readFileSync(master, 'utf8'), 'preserve prior decisions\n');

    const forced = runPython([...args, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).persistence.status, 'success');
    assert.notEqual(readFileSync(master, 'utf8'), 'preserve prior decisions\n');
  });

  it('REQ-AGENT-137: reports duplicate identifiers and malformed JSON rule values', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'design-skill-validation-'));
    temporaryDirectories.push(outputRoot);
    const invalidCsv = join(outputRoot, 'invalid.csv');
    writeFileSync(invalidCsv, 'No,Decision_Rules\n1,{bad json}\n1,{}\n');
    const validation = runPython([
      '-c',
      'import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from validate_data import _check_file; p=[]; _check_file("fixture",Path(sys.argv[2]),["No"],["No","Decision_Rules"],p); print(json.dumps(p))',
      skillScripts,
      invalidCsv,
    ]);
    assert.equal(validation.status, 0, validation.stderr);
    const problems = JSON.parse(validation.stdout);
    assert.ok(problems.some((problem) => problem.includes("duplicate 'No' value")));
    assert.ok(problems.some((problem) => problem.includes('is not valid JSON')));
  });
});
