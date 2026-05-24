// REQ-AGENT-039: /sdd init Phase 7b Enumeration-Coverage Verifier Gate.
//
// Behavioural test for verify-enumeration-coverage.py. Builds a temp
// fixture repo with load-bearing source files (under handlers/, >= 100
// lines), drives the verifier across three cases (all anchored, all in
// triage, none accounted), asserts the JSON shape, and exits with the
// correct exit_code (AC1/AC2/AC3/AC4/AC5).
//
// AC4 (commit body summary line) and AC6 (severity classification) are
// process-side conventions consumed by spec-reviewer; this test
// validates the verifier output those conventions sit on.
// AC7 (waiver file) is exercised by writing a waiver and asserting an
// otherwise-unaccounted file becomes excluded from the count.
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
  '../../preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py'
);

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'phase-7b-fixture-'));
  mkdirSync(join(root, 'sdd/spec'), { recursive: true });
  mkdirSync(join(root, 'documentation/lanes'), { recursive: true });
  mkdirSync(join(root, 'src/handlers'), { recursive: true });
  return root;
}

function writeLoadBearing(root, relPath) {
  // Real load-bearing classification fires on either (a) lives under one of
  // the canonical dir tokens, or (b) >= 100 source lines. Use (a) by
  // putting it under handlers/ so the file content can stay short.
  writeFileSync(join(root, relPath), 'export function handle() { return 1; }\n');
}

function runVerifier(root) {
  const result = spawnSync(
    'python3',
    [VERIFIER, '--root', root, '--quiet'],
    { encoding: 'utf-8' }
  );
  const report = JSON.parse(result.stdout);
  return { report, exitCode: result.status };
}

describe('REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate', () => {
  describe('AC2: verifier enumerates load-bearing source files', () => {
    it('classifies files under handlers/ as load-bearing-directory', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        const { report } = runVerifier(root);
        assert.equal(report.enumerated, 1);
        assert.equal(report.enumerated_entries[0].path, 'src/handlers/login.ts');
        assert.equal(report.enumerated_entries[0].reason, 'load-bearing-directory');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2 + AC3: anchored paths count as accounted', () => {
    it('an enumerated file referenced by @impl anchor is accounted via anchor', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        writeFileSync(
          join(root, 'sdd/spec/example.md'),
          '### REQ-FOO-001: Login\n\n<!-- @impl: src/handlers/login.ts::handle -->\n'
        );
        const { report, exitCode } = runVerifier(root);
        assert.equal(report.enumerated, 1);
        assert.equal(report.accounted, 1);
        assert.equal(report.unaccounted, 0);
        assert.equal(report.accounted_via.anchor, 1);
        assert.equal(report.exit_code, 0);
        assert.equal(exitCode, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC2 + AC3: triage-mentioned paths count as accounted', () => {
    it('an enumerated file literally referenced in .init-triage.md is accounted via triage', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        writeFileSync(
          join(root, 'sdd/spec/.init-triage.md'),
          '### TRIAGE-001\n\nsrc/handlers/login.ts has unclear auth flow.\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.accounted, 1);
        assert.equal(report.accounted_via.triage, 1);
        assert.equal(report.exit_code, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC3 + AC5: unaccounted load-bearing source is reported with non-zero exit', () => {
    it('an enumerated file with no anchor and no triage entry is unaccounted', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        // No spec anchor, no triage mention.
        const { report, exitCode } = runVerifier(root);
        assert.equal(report.enumerated, 1);
        assert.equal(report.accounted, 0);
        assert.equal(report.unaccounted, 1);
        assert.equal(report.unaccounted_entries[0].path, 'src/handlers/login.ts');
        assert.equal(report.exit_code, 1);
        assert.equal(exitCode, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC3: JSON report carries all contract fields', () => {
    it('emits enumerated/accounted/unaccounted/coverage_pct/accounted_via/unaccounted_entries/exit_code', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        const { report } = runVerifier(root);
        for (const field of [
          'enumerated', 'accounted', 'unaccounted',
          'coverage_pct', 'accounted_via', 'unaccounted_entries', 'exit_code',
        ]) {
          assert.ok(
            field in report,
            `report missing required field "${field}"`
          );
        }
        assert.equal(typeof report.coverage_pct, 'number');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC7: per-project waiver excludes specific files from coverage', () => {
    it('a file listed in sdd/spec/.phase-7b-waiver.txt is excluded from the enumerated count', () => {
      const root = makeFixture();
      try {
        writeLoadBearing(root, 'src/handlers/login.ts');
        writeFileSync(
          join(root, 'sdd/spec/.phase-7b-waiver.txt'),
          '# Framework boilerplate\nsrc/handlers/login.ts\n'
        );
        const { report } = runVerifier(root);
        assert.equal(report.enumerated, 0, 'waived file should be excluded');
        assert.equal(report.exit_code, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC7: greenfield (no source files) emits enumerated=0 + exit_code=0', () => {
    it('an empty repo (no source) still emits a well-formed advisory report', () => {
      const root = makeFixture();
      try {
        // No source files written. The verifier should still run and
        // emit a report with enumerated=0 and exit_code=0 (advisory).
        const { report, exitCode } = runVerifier(root);
        assert.equal(report.enumerated, 0);
        assert.equal(report.exit_code, 0);
        assert.equal(exitCode, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
