// Contract audit for preseed/agents/claude/skills/sdd-clean/SKILL.md.
//
// This skill IS the implementation of REQ-AGENT-037 (/sdd clean rescue and
// autonomy modes) and the /sdd-clean half of REQ-AGENT-048 (audit
// accumulators). The agent reads SKILL.md and follows the procedure — if
// the skill loses a load-bearing instruction, the agent silently does the
// wrong thing. Each it() below asserts that the skill still carries the
// specific instruction the spec AC requires.
//
// Same pattern as host/__tests__/skill-graphify-content.test.js and
// host/__tests__/skill-sdd-init-contract.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(__dirname, '../../preseed/agents/claude/skills/sdd-clean/SKILL.md'),
  'utf8'
);

describe('REQ-AGENT-037: /sdd clean rescue and autonomy modes', () => {
  it('AC1: skill defines the three autonomy modes (interactive, auto, unleashed)', () => {
    assert.ok(/interactive/.test(skill), 'SKILL must name interactive mode (AC1)');
    assert.ok(/\bauto\b/.test(skill), 'SKILL must name auto mode (AC1)');
    assert.ok(/unleashed/.test(skill), 'SKILL must name unleashed mode (AC1)');
  });

  it('AC1: skill references the layout-resolved config file location', () => {
    assert.ok(
      /sdd\/spec\/config\.yml/.test(skill) || /sdd\/config\.yml/.test(skill),
      'SKILL must reference the config.yml location (AC1)'
    );
  });

  it('AC2: skill defines per-mode behaviour (interactive prompts vs auto vs unleashed walk-away)', () => {
    // /sdd clean must distinguish modes — at minimum the unleashed
    // (walk-away) mode must be described as taking conservative
    // JUDGMENT resolutions without prompting.
    assert.ok(
      /JUDGMENT/.test(skill) || /walk-away/i.test(skill) || /without\s+prompt/i.test(skill),
      'SKILL must distinguish unleashed (autonomous JUDGMENT) from interactive (AC2)'
    );
  });

  it('AC3: skill defines safety nets that apply across all modes', () => {
    assert.ok(
      /Safety nets/i.test(skill),
      'SKILL must define a "Safety nets" section that applies to all modes (AC3)'
    );
  });

  it('AC4: skill defines layout migration (flat -> nested)', () => {
    assert.ok(
      /Layout migration/i.test(skill) || /flat.*nested|flat\s*→\s*nested/i.test(skill),
      'SKILL must define flat-to-nested layout migration (AC4)'
    );
  });

  it('AC5: skill enumerates what gets cleaned (per-category mechanics)', () => {
    assert.ok(
      /What gets cleaned/i.test(skill),
      'SKILL must define a "What gets cleaned" section (AC5)'
    );
    assert.ok(
      /Per-category mechanics/i.test(skill),
      'SKILL must define per-category mechanics (AC5)'
    );
  });
});

describe('REQ-AGENT-048: Audit accumulator surfaces (sdd-clean half)', () => {
  it('AC2: skill instructs writing per-category commit bodies prefixed [sdd-clean]', () => {
    assert.ok(
      /\[sdd-clean\]/.test(skill),
      'SKILL must instruct the [sdd-clean] commit prefix on per-category commits (REQ-AGENT-048 AC2)'
    );
  });

  it('AC2: skill must NOT instruct writing the execution audit to a dotfile', () => {
    // REQ-AGENT-048 AC2 explicitly forbids a dotfile audit; commit bodies
    // ARE the audit trail. The skill must not introduce a parallel dotfile.
    const forbidden = /\.sdd-clean-audit|sdd-clean\.log|sdd\/\.clean-audit/;
    assert.doesNotMatch(
      skill,
      forbidden,
      'SKILL must NOT route the /sdd clean execution audit to a dotfile (REQ-AGENT-048 AC2)'
    );
  });
});
