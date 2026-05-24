// REQ-AGENT-035: /sdd init Phase 7a Source-Anchor Verifier Gate.
//
// Behavioural test for verify-source-anchors.py. Builds a temp fixture
// repo with sdd/ + source files, spawns the verifier, and asserts the
// JSON output shape, the resolve/orphan/drift/malformed classification,
// and the exit-code contract (AC2/AC3/AC5).
//
// AC4 (commit body summary line) and AC6 (severity classification) are
// process-side conventions enforced by spec-reviewer; this test
// validates the verifier's machine output that those conventions feed
// on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFIER = resolve(
  __dirname,
  '../../preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py'
);

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'phase-7a-fixture-'));
  mkdirSync(join(root, 'sdd/spec'), { recursive: true });
  mkdirSync(join(root, 'documentation/lanes'), { recursive: true });
  mkdirSync(join(root, 'src/lib'), { recursive: true });
  return root;
}

function runVerifier(root) {
  const result = spawnSync(
    'python3',
    [VERIFIER, '--root', root, '--quiet'],
    { encoding: 'utf-8' }
  );
  // The verifier prints the JSON report to stdout regardless of exit code.
  const report = JSON.parse(result.stdout);
  return { report, exitCode: result.status };
}

describe('REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate', () => {
  describe('AC2 + AC3: verifier resolves valid anchors and emits the contract JSON shape', () => {
    it('emits all 9 contract fields: parsed/resolved/orphaned/drifted/malformed/unreadable/failures/malformed_entries/unreadable_entries/exit_code', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'src/lib/foo.ts'),
          'export function fooBar() { return 42; }\n'
        );
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/foo.ts::fooBar -->\n'
        );
        const { report } = runVerifier(root);
        for (const field of [
          'parsed', 'resolved', 'orphaned', 'drifted', 'malformed',
          'unreadable', 'failures', 'malformed_entries', 'unreadable_entries',
          'exit_code',
        ]) {
          assert.ok(
            field in report,
            `report missing required field "${field}"`
          );
        }
        assert.equal(report.parsed, 1);
        assert.equal(report.resolved, 1);
        assert.equal(report.orphaned, 0);
        assert.equal(report.exit_code, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2: orphaned anchors are detected and reported', () => {
    it('flags @impl pointing to a non-existent file as orphaned', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/ghost.ts::nothing -->\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.parsed, 1);
        assert.equal(report.orphaned, 1);
        assert.equal(report.failures.length, 1);
        assert.equal(report.failures[0].status, 'orphaned');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags @impl pointing to a real file but missing symbol as orphaned', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'src/lib/foo.ts'),
          'export function realFn() { return 1; }\n'
        );
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/foo.ts::ghostFn -->\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.orphaned, 1);
        assert.match(report.failures[0].reason, /symbol-not-found/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2: drifted anchors are detected when value pattern does not match', () => {
    it('flags @impl whose literal value tail does not appear near the symbol as drifted', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'src/lib/foo.ts'),
          'export const myCap = 100;\n'
        );
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/foo.ts::myCap = 99999999 -->\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.drifted, 1);
        assert.equal(report.failures[0].status, 'drifted');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2: malformed anchors are counted as a distinct failure class', () => {
    it('counts a comment that has @impl: shape but does not parse as :: separator', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: garbage-without-double-colon-separator -->\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.malformed, 1);
        assert.equal(report.malformed_entries.length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2: backticked example anchors are not parsed as live anchors', () => {
    it('ignores inline-code-spanned @impl examples so doc prose does not self-trip', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\nFormat: `<!-- @impl: src/lib/ghost.ts::ghostFn -->`\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.parsed, 0);
        assert.equal(report.malformed, 0);
        assert.equal(report.exit_code, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5: non-zero exit_code blocks until every failure is fixed', () => {
    it('exit_code is 1 when any failure (orphaned, drifted, malformed) is present', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/ghost.ts::nothing -->\n'
        );
        const { report, exitCode } = runVerifier(root);
        assert.equal(report.exit_code, 1);
        assert.equal(exitCode, 1, 'process exit code mirrors report.exit_code');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('exit_code is 0 when every anchor resolves cleanly', () => {
      const root = makeFixture();
      try {
        writeFileSync(
          join(root, 'src/lib/foo.ts'),
          'export const myCap = 100;\n'
        );
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Foo\n\n<!-- @impl: src/lib/foo.ts::myCap -->\n'
        );
        const { report, exitCode } = runVerifier(root);
        assert.equal(report.exit_code, 0);
        assert.equal(exitCode, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
