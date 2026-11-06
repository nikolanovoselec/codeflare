import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { actionlintInput } from '../../scripts/ci/actionlint-input.mjs';

const source = `name: verify
on: workflow_dispatch
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: '$/.github/actions/demo' # preserved comment
        with:
          value: ok
      - run: |
          printf '%s\\n' 'uses: $/.github/actions/untouched'
  call:
    uses: $/.github/workflows/called.yml
    with:
      message: hello
`;

test('REQ-OPS-021 AC3: projects only actual self-repository uses, retaining scripts and diagnostic positions', () => {
  const expected = source.replace("uses: '$/.github/actions/demo'", "uses: './.github/actions/demo'")
    .replace('uses: $/.github/workflows/called.yml', 'uses: ./.github/workflows/called.yml');
  assert.equal(actionlintInput(source, '1.7.12'), expected, 'lint input is an intentional byte-preserving syntax contract');
  assert.equal(actionlintInput(expected, '1.7.12'), expected);
  assert.throws(() => actionlintInput(source, '1.7.13'), /Requalify/);
  for (const invalid of ['$/elsewhere/demo', '$/.github/actions/../demo', '$/.github/actions/demo@main']) {
    assert.throws(() => actionlintInput(source.replace('$/.github/actions/demo', invalid), '1.7.12'), /Unsupported/);
  }
  assert.throws(() => actionlintInput('jobs: [broken', '1.7.12'), /Invalid workflow YAML/);
});

// This integration runs in workflow-audit only, after its checksum-pinned binary is verified.
// The normal host lane still executes the projection contract above without downloading a tool.
test('REQ-OPS-021 AC3: real pinned actionlint retains local target, input, expression and shell failures', {
  skip: !process.env.ACTIONLINT_BINARY,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'actionlint-input-'));
  const helper = fileURLToPath(new URL('../../scripts/ci/actionlint-input.mjs', import.meta.url));
  const file = join(root, '.github/workflows/verify.yml');
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  };
  try {
    mkdirSync(join(root, '.git')); // Project marker for the real linter's local metadata lookup.
    const actionFile = join(root, '.github/actions/demo/action.yml');
    const actionMetadata = `name: demo
description: fixture
inputs:
  value:
    description: fixture input
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      run: 'true'
`;
    write(actionFile, actionMetadata);
    write(join(root, '.github/workflows/called.yml'), `on:
  workflow_call:
    inputs:
      message:
        required: true
        type: string
jobs:
  work:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
`);
    const run = input => {
      write(file, input);
      const result = spawnSync(process.execPath, [helper, process.env.ACTIONLINT_BINARY, file], {
        cwd: root, encoding: 'utf8', env: { ...process.env, SHELLCHECK_OPTS: '--severity=error' },
      });
      assert.equal(readFileSync(file, 'utf8'), input, 'audited source is never rewritten');
      return result;
    };
    const valid = run(source);
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    for (const [name, input, metadata = actionMetadata] of [
      ['malformed local action metadata', source, 'inputs: [\n'],
      ['missing reusable workflow', source.replace('workflows/called.yml', 'workflows/missing.yml')],
      ['invalid action input', source.replace('value: ok', 'unlisted: ok')],
      ['invalid workflow input', source.replace('message: hello', 'unlisted: hello')],
      ['invalid expression', source.replace('value: ok', 'value: ${{ nonexistent.value }}')],
      ['broken shell', source.replace("printf '%s\\n' 'uses: $/.github/actions/untouched'", 'if then')],
    ]) {
      await t.test(name, () => {
        write(actionFile, metadata);
        const result = run(input);
        assert.notEqual(result.status, 0, `${name} must remain a failure: ${result.stdout}\n${result.stderr}`);
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
