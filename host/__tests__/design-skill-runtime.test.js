// Behavioral coverage for REQ-AGENT-135, REQ-AGENT-136, and REQ-AGENT-137.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const skillScripts = fileURLToPath(new URL('../../preseed/agents/claude/skills/ui-ux-pro-max/scripts/', import.meta.url));
const claudeImpeccableSkill = fileURLToPath(new URL('../../preseed/agents/claude/skills/impeccable/SKILL.md', import.meta.url));
const piImpeccableSkill = fileURLToPath(new URL('../../preseed/agents/pi/skills/impeccable/SKILL.md', import.meta.url));
const impeccableUpdater = fileURLToPath(new URL('../../scripts/update-impeccable-skill.mjs', import.meta.url));
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

  it('REQ-AGENT-136: rejects symlinked persistence destinations', () => {
    const cases = [
      {
        name: 'design-system directory',
        prepare(outputRoot) {
          const outsideDirectory = join(outputRoot, 'outside');
          const outsideFile = join(outsideDirectory, 'portal', 'MASTER.md');
          mkdirSync(join(outsideDirectory, 'portal'), { recursive: true });
          writeFileSync(outsideFile, 'outside\n');
          symlinkSync(outsideDirectory, join(outputRoot, 'design-system'));
          return outsideFile;
        },
        page: undefined,
      },
      {
        name: 'project directory',
        prepare(outputRoot) {
          const outsideDirectory = join(outputRoot, 'outside');
          const outsideFile = join(outsideDirectory, 'MASTER.md');
          mkdirSync(join(outputRoot, 'design-system'));
          mkdirSync(outsideDirectory);
          writeFileSync(outsideFile, 'outside\n');
          symlinkSync(outsideDirectory, join(outputRoot, 'design-system', 'portal'));
          return outsideFile;
        },
        page: undefined,
      },
      {
        name: 'master file',
        prepare(outputRoot) {
          const outsideFile = join(outputRoot, 'outside-target');
          mkdirSync(join(outputRoot, 'design-system', 'portal', 'pages'), { recursive: true });
          writeFileSync(outsideFile, 'outside\n');
          symlinkSync(outsideFile, join(outputRoot, 'design-system', 'portal', 'MASTER.md'));
          return outsideFile;
        },
        page: undefined,
      },
      {
        name: 'pages directory',
        prepare(outputRoot) {
          const outsideDirectory = join(outputRoot, 'outside');
          const outsideFile = join(outsideDirectory, 'overview.md');
          mkdirSync(join(outputRoot, 'design-system', 'portal'), { recursive: true });
          mkdirSync(outsideDirectory);
          writeFileSync(outsideFile, 'outside\n');
          symlinkSync(outsideDirectory, join(outputRoot, 'design-system', 'portal', 'pages'));
          return outsideFile;
        },
        page: 'overview',
      },
      {
        name: 'page file',
        prepare(outputRoot) {
          const outsideFile = join(outputRoot, 'outside-target');
          mkdirSync(join(outputRoot, 'design-system', 'portal', 'pages'), { recursive: true });
          writeFileSync(outsideFile, 'outside\n');
          symlinkSync(outsideFile, join(outputRoot, 'design-system', 'portal', 'pages', 'overview.md'));
          return outsideFile;
        },
        page: 'overview',
      },
    ];

    for (const testCase of cases) {
      const outputRoot = mkdtempSync(join(tmpdir(), 'design-skill-symlink-'));
      temporaryDirectories.push(outputRoot);
      const outsideFile = testCase.prepare(outputRoot);
      const args = [
        join(skillScripts, 'search.py'), 'saas dashboard', '--design-system', '--json',
        '--project-name', 'portal', '--persist', '--output-dir', outputRoot, '--force',
      ];
      if (testCase.page) args.push('--page', testCase.page);

      const generated = runPython(args);
      assert.notEqual(generated.status, 0, `${testCase.name} must fail closed`);
      assert.equal(readFileSync(outsideFile, 'utf8'), 'outside\n');
    }
  });

  it('REQ-AGENT-179: narrows Impeccable discovery without removing explicit commands', () => {
    const expectedDescription = 'Critique, audit, harden, adapt, animate, or apply bounded polish to an existing frontend whose direction remains intact. Use for accessibility, responsive behavior, performance, UX copy, interaction detail, visual finishing, and explicit impeccable commands. For greenfield creation or any change to the visual thesis, frontend-design owns art direction; use Impeccable afterward for critique or finishing. Not for backend-only or non-UI tasks.';
    for (const skillPath of [claudeImpeccableSkill, piImpeccableSkill]) {
      const skill = readFileSync(skillPath, 'utf8');
      assert.equal(
        skill.split('\n').find((line) => line.startsWith('description: ')),
        `description: ${expectedDescription}`,
      );
      assert.ok(skill.includes('## Codeflare routing boundary'));
      assert.ok(skill.includes('general/new-work path applies only after explicit Impeccable invocation'));
      assert.ok(skill.includes('| `shape [feature]` |'));
      assert.ok(skill.includes('| `polish [target]` |'));
      assert.ok(skill.includes('| `live` |'));
    }

    const updater = readFileSync(impeccableUpdater, 'utf8');
    assert.ok(updater.includes(expectedDescription));
    assert.ok(updater.includes('applyCodeflareRoutingBoundary(text)'));
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
