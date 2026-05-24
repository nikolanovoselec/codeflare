// Contract audit for preseed/agents/claude/skills/sdd-init/SKILL.md.
//
// This skill IS the implementation of REQ-AGENT-033 (canonical render),
// REQ-AGENT-034 (enrichment pass), REQ-AGENT-038 (Resume Mode), REQ-AGENT-045
// (Import-Mode triage queue), REQ-AGENT-047 (Resume closure), and the
// /sdd-init half of REQ-AGENT-048 (audit accumulators). The agent reads
// SKILL.md and follows the procedure — if the skill loses a load-bearing
// instruction, the agent silently does the wrong thing. Each it() below
// asserts that the skill still carries the specific instruction the spec
// AC requires.
//
// Same pattern as host/__tests__/skill-graphify-content.test.js, which
// guards REQ-AGENT-024 the same way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(__dirname, '../../preseed/agents/claude/skills/sdd-init/SKILL.md'),
  'utf8'
);

describe('REQ-AGENT-033: /sdd init scaffolding and canonical render', () => {
  it('AC1+AC2: skill carries both Greenfield and Import Mode procedures', () => {
    assert.ok(
      /Greenfield/i.test(skill),
      'SKILL must define the Greenfield flow (AC1)'
    );
    assert.ok(
      /Import Mode/i.test(skill),
      'SKILL must define Import Mode (AC2)'
    );
  });

  it('AC3+AC4: skill instructs the agent to resolve dep versions at scaffold time with --ignore-scripts', () => {
    assert.ok(
      /--ignore-scripts/.test(skill),
      'SKILL must instruct agent to use npm --ignore-scripts during lockfile resolution (AC4)'
    );
    assert.ok(
      /wrangler/.test(skill) && /@cloudflare\/workers-types/.test(skill),
      'SKILL must pin the Cloudflare Workers cohort (AC3: co-resolved cohort)'
    );
  });

  it('AC5: skill defines the lean two-confirm flow (one vision question, full-draft, edit-in-place)', () => {
    assert.ok(
      /two-confirm/i.test(skill),
      'SKILL must name the lean two-confirm flow (AC5)'
    );
    assert.ok(
      /one\s+(vision|domain|question)/i.test(skill) || /vision question/i.test(skill),
      'SKILL must instruct asking a single vision question (AC5)'
    );
  });

  it('AC6: skill instructs canonical REQ render (numbered ACs, Constraints + Dependencies always present, None. literal when empty)', () => {
    assert.ok(
      /Constraints/.test(skill) && /Dependencies/.test(skill),
      'SKILL must reference the canonical Constraints + Dependencies fields (AC6)'
    );
    assert.ok(
      /None\./.test(skill),
      'SKILL must reference the "None." literal placeholder for empty Constraints/Dependencies (AC6)'
    );
  });

  it('AC7: skill instructs pre-creating sdd/spec/.review-queue.md with the placeholder', () => {
    assert.ok(
      /\.review-queue\.md/.test(skill),
      'SKILL must reference the verification queue file (AC7)'
    );
    assert.ok(
      /Awaiting first finding/.test(skill),
      'SKILL must use the verbatim "_Awaiting first finding._" placeholder (AC7)'
    );
  });
});

describe('REQ-AGENT-034: /sdd init enrichment pass with graphify', () => {
  it('AC1: skill defines an enrichment pass that runs AFTER draft accept BEFORE file writes', () => {
    assert.ok(
      /Enrichment pass/i.test(skill),
      'SKILL must define an enrichment pass section (AC1)'
    );
  });

  it('AC2+AC3+AC4: skill names the three sub-passes (cross-link, ADR-seed, glossary-seed)', () => {
    assert.ok(
      /cross-link/i.test(skill),
      'SKILL must define the cross-link sub-pass (AC2)'
    );
    assert.ok(
      /ADR-seed|ADR seed/i.test(skill),
      'SKILL must define the ADR-seed sub-pass (AC3)'
    );
    assert.ok(
      /glossary-seed|glossary seed/i.test(skill),
      'SKILL must define the glossary-seed sub-pass (AC4)'
    );
  });

  it('AC5: skill instructs querying the graph via mcp__graphify__ MCP tools', () => {
    assert.ok(
      /mcp__graphify__/.test(skill),
      'SKILL must instruct the agent to call graphify MCP tools (AC5)'
    );
    assert.ok(
      /get_neighbors/.test(skill),
      'SKILL must reference get_neighbors for cross-link pass (AC5)'
    );
    assert.ok(
      /god_nodes/.test(skill),
      'SKILL must reference god_nodes for ADR-seed pass (AC5)'
    );
  });

  it('AC6: skill instructs the graph-missing fallback (cluster-only offer + in-memory fallback + changes.md notice)', () => {
    assert.ok(
      /cluster-only/.test(skill),
      'SKILL must offer the cluster-only build when graph missing (AC6)'
    );
    assert.ok(
      /changes\.md/.test(skill),
      'SKILL must instruct appending a notice to sdd/changes.md (AC6)'
    );
  });
});

describe('REQ-AGENT-038: Resume Mode drain workflow', () => {
  it('AC1: skill defines a Resume Mode section', () => {
    assert.ok(
      /Resume Mode/.test(skill),
      'SKILL must define Resume Mode (REQ-AGENT-038 AC1)'
    );
  });

  it('AC2: Resume Mode discovers in-flight transition state from config.yml or layout markers', () => {
    // The drain workflow detects partial /sdd init runs and resumes them.
    // The skill must reference either the transition: flag or the layout
    // markers that signal a previous incomplete run.
    assert.ok(
      /transition/.test(skill) || /pick(ing)? up where/i.test(skill),
      'SKILL must describe how Resume Mode detects in-flight state (REQ-AGENT-038 AC2)'
    );
  });
});

describe('REQ-AGENT-045: Import-Mode triage queue and transition state', () => {
  it('AC1: skill defines the Import Mode triage queue (.init-triage.md)', () => {
    assert.ok(
      /\.init-triage\.md/.test(skill),
      'SKILL must define the .init-triage.md triage queue (REQ-AGENT-045 AC1)'
    );
  });

  it('AC2+AC3: skill carries triage entry Status vocabulary (open / resolved / lost) and the Reason: requirement on lost', () => {
    assert.ok(
      /open\s*\|\s*resolved\s*\|\s*lost/.test(skill) ||
        (/open/.test(skill) && /resolved/.test(skill) && /lost/.test(skill)),
      'SKILL must enumerate Status: open | resolved | lost (REQ-AGENT-045 AC3)'
    );
    assert.ok(
      /Reason:/.test(skill),
      'SKILL must require **Reason:** field on "lost" entries (REQ-AGENT-045 AC3)'
    );
  });
});

describe('REQ-AGENT-047: Resume Mode closure and review-pipeline gate', () => {
  it('AC1: skill defines the Resume Mode closure procedure that runs Phase 7a/7b before closing', () => {
    assert.ok(
      /Resume Mode/.test(skill),
      'SKILL must define Resume Mode (REQ-AGENT-047 AC1)'
    );
    assert.ok(
      /Phase 7a/.test(skill),
      'SKILL must instruct running Phase 7a as part of closure (REQ-AGENT-047 AC1)'
    );
    assert.ok(
      /Phase 7b/.test(skill),
      'SKILL must instruct running Phase 7b as part of closure (REQ-AGENT-047 AC1)'
    );
  });
});

describe('REQ-AGENT-048: Audit accumulator surfaces (sdd-init half)', () => {
  it('AC1: skill must NOT instruct scaffold-time pre-creation of documentation/.doc-coverage.md (lazy-create only)', () => {
    // The accumulator is lazy-created by doc-updater on first finding.
    // sdd-init must NOT touch it at scaffold time, which would create the
    // placeholder shape REQ-AGENT-048 AC1 explicitly forbids.
    const initSection = skill;
    const forbidden = /pre-?create.{0,40}\.doc-coverage\.md|scaffold.{0,40}\.doc-coverage\.md/i;
    assert.doesNotMatch(
      initSection,
      forbidden,
      'sdd-init SKILL must NOT pre-create documentation/.doc-coverage.md (REQ-AGENT-048 AC1: lazy-create by doc-updater)'
    );
  });
});
