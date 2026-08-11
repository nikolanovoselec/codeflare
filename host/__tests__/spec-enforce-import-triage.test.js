import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(
  HERE,
  '../../preseed/agents/claude/skills/spec-enforce/scripts/validate-import-triage.mjs',
);

function fixture({ transition = true, triage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'import-triage-'));
  mkdirSync(join(root, 'sdd/spec'), { recursive: true });
  writeFileSync(join(root, 'sdd/spec/config.yml'), `mode: interactive\ntransition: ${transition}\n`);
  if (triage !== undefined) writeFileSync(join(root, 'sdd/spec/.init-triage.md'), triage);
  return root;
}

function validate(root) {
  const result = spawnSync(process.execPath, [VALIDATOR, '--repo', root], { encoding: 'utf8' });
  return { ...result, report: JSON.parse(result.stdout) };
}

// REQ-AGENT-045 AC2
describe('spec-enforce import-triage substantive validator', () => {
  it('accepts concrete open import guidance while transition is active', () => {
    const root = fixture({ triage: `### TRIAGE-001\n\n**Status:** open\n**Context:** src/auth.ts:42 rejects the token in commit abcdef123.\n**Recommendation:** Require the auth route to reject expired access tokens.\n**Rationale:** This follows because the cited branch already rejects an equivalent credential.\n` });
    const result = validate(root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.transition, true);
    assert.equal(result.report.checked, 1);
    assert.deepEqual(result.report.findings, []);
  });

  it('blocks placeholder import guidance with one executable finding per field', () => {
    const root = fixture({ triage: `### TRIAGE-002\n\n**Status:** open\n**Context:** TBD\n**Recommendation:** fix as needed\n**Rationale:** unknown\n` });
    const result = validate(root);

    assert.equal(result.status, 1);
    assert.equal(result.report.checked, 1);
    assert.deepEqual(result.report.findings.map((finding) => finding.field), [
      'Context', 'Recommendation', 'Rationale',
    ]);
    assert.ok(result.report.findings.every((finding) => finding.id === 'import-triage-placeholder'));
  });

  it('still validates an open import queue when transition configuration drifted false', () => {
    const root = fixture({ transition: false, triage: `### TRIAGE-003\n\n**Status:** open\n**Context:** investigate\n` });
    const result = validate(root);

    assert.equal(result.status, 1,
      'transition drift must not turn the always-run content gate into an inert backlog pass');
    assert.equal(result.report.transition, false);
    assert.equal(result.report.checked, 1);
  });

  it('is an inert successful pass when no import queue exists', () => {
    const result = validate(fixture({ transition: false }));
    assert.equal(result.status, 0);
    assert.equal(result.report.checked, 0);
    assert.deepEqual(result.report.findings, []);
  });
});
