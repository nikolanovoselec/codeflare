import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

/**
 * Validates ECC (Everything Claude Code) rule integration in the generated
 * agent seed configs. ECC rules are language-specific and common rules that
 * should only be available in advanced session mode.
 *
 * These checks are scoped to Claude documents only - non-Claude agents
 * receive rules concatenated into a single instructions file, not as
 * individual rule documents.
 */

const ECC_SUBDIRS = ['typescript', 'python', 'golang', 'swift'] as const;

// The four documents every ECC language subdirectory owes. This is the
// contract; a count is not. A pinned total passes the moment someone edits the
// constant to match whatever shipped, which is what it is supposed to catch.
const ECC_DOCUMENTS = ['coding-style', 'patterns', 'security', 'testing'] as const;

function claudeDocs() {
  return AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key.startsWith('.claude/'));
}

function eccRules() {
  return claudeDocs().filter((doc) =>
    ECC_SUBDIRS.some((dir) => doc.key.startsWith(`.claude/rules/${dir}/`))
  );
}

function codeflareRules() {
  // Original codeflare rules - directly in .claude/rules/ without a subdirectory
  return claudeDocs().filter(
    (doc) =>
      doc.key.startsWith('.claude/rules/') &&
      !ECC_SUBDIRS.some((dir) => doc.key.startsWith(`.claude/rules/${dir}/`))
  );
}

describe('ECC rules in agent-seed', () => {
  it('carries no language-agnostic common/ rules; those concretes live in the constitution', () => {
    // rules/common/coding-style.md was absorbed into engineering-constitution.md
    // (both advanced-only, so no audience changed). The per-language
    // coding-style rules below still stand alone and remain path-scoped.
    expect(eccRules().filter((doc) => doc.key.startsWith('.claude/rules/common/'))).toHaveLength(0);
    const constitution = claudeDocs().find((doc) => doc.key === '.claude/rules/engineering-constitution.md');
    expect(constitution!.content).toMatch(/^## Coding concretes$/m);
    expect(constitution!.content).toMatch(/Never set a field to `undefined`/);
  });

  for (const dir of ECC_SUBDIRS) {
    it(`includes ${dir}/ rules with advanced mode only`, () => {
      const rules = eccRules().filter((doc) => doc.key.startsWith(`.claude/rules/${dir}/`));
      expect(rules).toHaveLength(ECC_DOCUMENTS.length);
      for (const rule of rules) {
        expect(rule.modes).toEqual(['advanced']);
      }
    });
  }

  it('all ECC rule keys have .claude/rules/ prefix', () => {
    for (const rule of eccRules()) {
      expect(rule.key.startsWith('.claude/rules/')).toBe(true);
    }
  });

  it('ECC rules do not appear in default mode configs', () => {
    for (const rule of eccRules()) {
      expect(rule.modes).not.toContain('default');
    }
  });

  // Rules that are intentionally advanced-mode-only (Pro features).
  // memory.md depends on the MCP memory server.
  // spec-discipline.md is part of the Pro-mode SDD workflow (REQ-AGENT-021).
  // documentation-discipline.md is the doc-updater enforcement layer (sibling
  //   to spec-discipline.md, same Pro-mode SDD workflow).
  // tdd-discipline.md is the third sibling in the discipline triad - Pro-mode
  //   only because default-mode users are vibe-coding and didn't opt into
  //   rigorous TDD enforcement.
  // The graphify discipline (REQ-AGENT-023, AD52), the Karpathy working
  //   principles, and the common coding concretes now live in
  //   engineering-constitution.md. All three were already advanced-only, and
  //   the constitution is advanced-only too, so absorbing them preserved the
  //   discipline-vs-capability split exactly: the graphify MCP server is still
  //   registered for every session mode, only the discipline rule is gated.
  const ADVANCED_ONLY_CODEFLARE_RULES = [
    '.claude/rules/memory.md',
    '.claude/rules/spec-discipline.md',
    '.claude/rules/documentation-discipline.md',
    '.claude/rules/tdd-discipline.md',
    // vault-note-capture.md is the trigger rule that maps "take a note"
    // phrases to the vault-note-capture skill. The vault itself is
    // Pro-mode-only, so the trigger has no audience in default mode.
    // Vault layout/conventions live in skills/vault-operations/ and
    // are routed from rules/memory.md (Pro-mode-only), not from a
    // separate rules/vault.md (folded into memory.md).
    '.claude/rules/vault-note-capture.md',
    // frontend-components.md is the composable-UI coding-standards rule
    // (extract-don't-duplicate, central tokens/content, behavioral-only
    // tests). A sibling of karpathy.md / tdd-discipline.md: rigorous
    // coding discipline default-mode vibe-coders didn't opt into, and it
    // routes to the frontend-components skill, itself advanced-only.
    '.claude/rules/frontend-components.md',
    // engineering-constitution.md is the four-mandate spine (no overengineering,
    // behavioral tests only, reusable/composable components, SDD+TDD enforced) plus
    // the plan/done gates. A sibling of karpathy.md / frontend-components.md:
    // rigorous coding discipline default-mode vibe-coders didn't opt into.
    '.claude/rules/engineering-constitution.md',
    // cloudflare-workers.md is the path-scoped retrieval rule that ships with the
    // bundled Cloudflare platform skills (REQ-AGENT-075). The CF skills are
    // advanced/Pro-only, so their companion Workers rule is too (asserted in
    // cloudflare-skills-seed.test.ts as advancedOnly).
    '.claude/rules/cloudflare-workers.md',
  ];

  it('non-memory codeflare rules have default+advanced modes', () => {
    const cfRules = codeflareRules().filter(
      (doc) => !ADVANCED_ONLY_CODEFLARE_RULES.includes(doc.key)
    );
    expect(cfRules.length).toBeGreaterThan(0);
    for (const rule of cfRules) {
      expect(rule.modes).toContain('default');
      expect(rule.modes).toContain('advanced');
    }
  });

  it('memory rule is advanced-only (depends on MCP memory server)', () => {
    const memoryRule = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/memory.md'
    );
    expect(memoryRule).toBeDefined();
    expect(memoryRule!.modes).toEqual(['advanced']);
  });

  it('spec-discipline rule is advanced-only (Pro-mode SDD workflow)', () => {
    const specDisciplineRule = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/spec-discipline.md'
    );
    expect(specDisciplineRule).toBeDefined();
    expect(specDisciplineRule!.modes).toEqual(['advanced']);
  });

  it('documentation-discipline rule is advanced-only (Pro-mode SDD workflow)', () => {
    const docDisciplineRule = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/documentation-discipline.md'
    );
    expect(docDisciplineRule).toBeDefined();
    expect(docDisciplineRule!.modes).toEqual(['advanced']);
  });

  it('tdd-discipline rule is advanced-only (Pro-mode SDD workflow)', () => {
    const tddDisciplineRule = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/tdd-discipline.md'
    );
    expect(tddDisciplineRule).toBeDefined();
    expect(tddDisciplineRule!.modes).toEqual(['advanced']);
  });

  it('graphify discipline is advanced-only and lives in the constitution (REQ-AGENT-023 / AD52)', () => {
    // The discipline moved into engineering-constitution.md. The gating claim
    // is what matters and it is unchanged: the MCP server is ambient across
    // modes, the rule telling the agent to prefer the graph is advanced-only.
    expect(codeflareRules().find((doc) => doc.key === '.claude/rules/graph-first.md')).toBeUndefined();
    const constitution = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/engineering-constitution.md'
    );
    expect(constitution).toBeDefined();
    expect(constitution!.modes).toEqual(['advanced']);
    expect(constitution!.content).toMatch(/^## Graph first$/m);
    expect(constitution!.content).toMatch(/graphify-out\/graph\.json/);
  });

  it('every ECC subdirectory ships exactly the four documents it owes', () => {
    // Derived from the two declared lists, so adding a language or a document
    // type requires changing a real declaration, not a tally.
    for (const dir of ECC_SUBDIRS) {
      const shipped = eccRules()
        .filter((doc) => doc.key.startsWith(`.claude/rules/${dir}/`))
        .map((doc) => doc.key.replace(`.claude/rules/${dir}/`, '').replace(/\.md$/, ''))
        .sort();
      expect(shipped, dir).toEqual([...ECC_DOCUMENTS].sort());
    }
    expect(eccRules()).toHaveLength(ECC_SUBDIRS.length * ECC_DOCUMENTS.length);
  });
});
