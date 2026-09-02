import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(
  HERE,
  '../../preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs',
);

function fixture(binaryName, body = 'printf "%s\\n" "$@" > "$SAFE_CHECK_CAPTURE"\n') {
  const root = mkdtempSync(join(tmpdir(), 'safe-local-check-'));
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, binaryName);
  writeFileSync(executable, `#!/usr/bin/env bash\nset -eu\n${body}`, 'utf8');
  chmodSync(executable, 0o755);
  return root;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SAFE_CHECK_CAPTURE: join(root, 'capture.txt'),
      ...env,
    },
  });
}

describe('REQ-AGENT-052 AC6: managed safe local checks', () => {
  it('runs full-project Oxlint through the repository-local binary at low priority', () => {
    const root = fixture('oxlint', [
      'if [ "$#" -gt 0 ]; then printf "%s\\n" "$@" > "$SAFE_CHECK_CAPTURE"; else : > "$SAFE_CHECK_CAPTURE"; fi',
      'ps -o ni= -p $$ > "$SAFE_CHECK_NICENESS"',
      '',
    ].join('\n'));
    const result = run(root, ['oxlint'], {
      SAFE_CHECK_NICENESS: join(root, 'niceness.txt'),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'capture.txt'), 'utf8'), '');
    assert.ok(Number(readFileSync(join(root, 'niceness.txt'), 'utf8').trim()) >= 10);
  });

  it('does not impose a file-count limit', () => {
    const root = fixture('oxlint');
    const files = Array.from({ length: 75 }, (_, index) => `src/file-${index}.ts`);
    const result = run(root, ['oxlint', ...files]);

    assert.equal(result.status, 0, result.stderr);
    const captured = readFileSync(join(root, 'capture.txt'), 'utf8').trim().split('\n');
    assert.equal(captured.length, 75);
    assert.deepEqual(captured, files);
  });

  it('rejects mutating analyzer flags before starting the binary', () => {
    for (const args of [
      ['oxlint', '--fix', 'src'],
      ['eslint', '-o', 'report.json', '.'],
      ['eslint', '--cache', '.'],
      ['eslint', '--cache-location=.cache/eslint', '.'],
      ['eslint', '--init'],
    ]) {
      const root = fixture(args[0]);
      const result = run(root, args);

      assert.equal(result.status, 2, `${args.join(' ')} should be rejected`);
      assert.match(result.stderr, /read-only|not allowed/i);
      assert.equal(existsSync(join(root, 'capture.txt')), false, 'analyzer must not start');
      assert.equal(existsSync(join(root, 'report.json')), false, 'output file must not be created');
    }
  });

  it('does not resolve an analyzer outside the repository boundary', () => {
    const parent = fixture('eslint');
    const root = join(parent, 'repository');
    mkdirSync(join(root, '.git'), { recursive: true });
    const result = run(root, ['eslint', '.']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /repository-local eslint/i);
    assert.equal(existsSync(join(parent, 'capture.txt')), false, 'ancestor analyzer must not start');
  });

  it('requires an already-installed repository-local analyzer', () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-local-check-missing-'));
    const result = run(root, ['eslint', '.']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /repository-local eslint/i);
  });

  it('requires Prettier check mode', () => {
    const root = fixture('prettier');
    const result = run(root, ['prettier', '.']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--check/i);
  });

  it('terminates the analyzer process group at the managed deadline', () => {
    const root = fixture('eslint', 'sleep 5\n');
    const started = Date.now();
    const result = run(root, ['eslint', '.'], { SAFE_LOCAL_CHECK_TIMEOUT_MS: '50' });

    assert.equal(result.status, 124, result.stderr);
    assert.ok(Date.now() - started < 2_000, 'managed timeout should stop the fixture promptly');
  });

  it('runs Node syntax checks without a repository dependency', () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-local-check-syntax-'));
    writeFileSync(join(root, 'valid.mjs'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(root, 'invalid.mjs'), 'export const = ;\n', 'utf8');

    assert.equal(run(root, ['syntax', 'valid.mjs']).status, 0);
    assert.notEqual(run(root, ['syntax', 'invalid.mjs']).status, 0);
  });

  it('parses JSON and rejects files outside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-local-check-json-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'valid.json'), '{"ok":true}\n', 'utf8');
    writeFileSync(join(root, 'invalid.json'), '{nope}\n', 'utf8');
    const outside = join(tmpdir(), `safe-local-check-outside-${Date.now()}.json`);
    writeFileSync(outside, '{"ok":true}\n', 'utf8');

    assert.equal(run(root, ['json', 'valid.json']).status, 0);
    assert.notEqual(run(root, ['json', 'invalid.json']).status, 0);
    const outsideResult = run(root, ['json', outside]);
    assert.equal(outsideResult.status, 2);
    assert.match(outsideResult.stderr, /outside repository/i);

    symlinkSync(outside, join(root, 'linked.json'));
    const linkedResult = run(root, ['json', 'linked.json']);
    assert.equal(linkedResult.status, 2);
    assert.match(linkedResult.stderr, /outside repository/i);
  });

  it('does not load parser dependencies from a parent node_modules', () => {
    const parent = mkdtempSync(join(tmpdir(), 'safe-local-check-parent-module-'));
    const root = join(parent, 'repository');
    const yamlPackage = join(parent, 'node_modules', 'yaml');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(yamlPackage, { recursive: true });
    writeFileSync(join(root, 'valid.yaml'), 'ok: true\n', 'utf8');
    writeFileSync(join(yamlPackage, 'package.json'), JSON.stringify({
      name: 'yaml',
      version: '1.0.0',
      main: 'index.js',
    }), 'utf8');
    writeFileSync(join(yamlPackage, 'index.js'), 'module.exports = { parseDocument: () => ({ errors: [] }) };\n', 'utf8');

    const result = run(root, ['yaml', 'valid.yaml']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /repository-local yaml/i);
  });

  it('runs Bash syntax checks through the managed process wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-local-check-shell-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'valid.sh'), 'case "$1" in ok) echo ok;; esac\n', 'utf8');
    writeFileSync(join(root, 'invalid.sh'), 'if true; then echo ok\n', 'utf8');

    assert.equal(run(root, ['shell-syntax', 'valid.sh']).status, 0);
    assert.notEqual(run(root, ['shell-syntax', 'invalid.sh']).status, 0);
  });

  it('checks package lock consistency without running package scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'safe-local-check-lock-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { leftpad: '1.0.0' } }), 'utf8');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { leftpad: '1.0.0' } },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-abc=',
        },
      },
    }), 'utf8');

    assert.equal(run(root, ['lock-consistency']).status, 0);
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { leftpad: '1.0.1' } } },
    }), 'utf8');
    assert.notEqual(run(root, ['lock-consistency']).status, 0);
  });
});
