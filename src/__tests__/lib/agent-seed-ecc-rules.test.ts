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

const ECC_SUBDIRS = ['common', 'typescript', 'python', 'golang', 'swift'] as const;

// Expected file count per subdirectory
const ECC_FILES_PER_SUBDIR: Record<string, number> = {
  common: 2, // coding-style, security (git-workflow moved to top-level rules/ with default+advanced modes)
  typescript: 4, // coding-style, patterns, security, testing
  python: 4,
  golang: 4,
  swift: 4,
};

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
  it('includes common/ rules with advanced mode only', () => {
    const commonRules = eccRules().filter((doc) => doc.key.startsWith('.claude/rules/common/'));
    expect(commonRules.length).toBe(ECC_FILES_PER_SUBDIR.common);
    for (const rule of commonRules) {
      expect(rule.modes).toEqual(['advanced']);
    }
  });

  it('includes typescript/ rules with advanced mode only', () => {
    const tsRules = eccRules().filter((doc) => doc.key.startsWith('.claude/rules/typescript/'));
    expect(tsRules.length).toBe(ECC_FILES_PER_SUBDIR.typescript);
    for (const rule of tsRules) {
      expect(rule.modes).toEqual(['advanced']);
    }
  });

  it('includes python/ rules with advanced mode only', () => {
    const pyRules = eccRules().filter((doc) => doc.key.startsWith('.claude/rules/python/'));
    expect(pyRules.length).toBe(ECC_FILES_PER_SUBDIR.python);
    for (const rule of pyRules) {
      expect(rule.modes).toEqual(['advanced']);
    }
  });

  it('includes golang/ rules with advanced mode only', () => {
    const goRules = eccRules().filter((doc) => doc.key.startsWith('.claude/rules/golang/'));
    expect(goRules.length).toBe(ECC_FILES_PER_SUBDIR.golang);
    for (const rule of goRules) {
      expect(rule.modes).toEqual(['advanced']);
    }
  });

  it('includes swift/ rules with advanced mode only', () => {
    const swiftRules = eccRules().filter((doc) => doc.key.startsWith('.claude/rules/swift/'));
    expect(swiftRules.length).toBe(ECC_FILES_PER_SUBDIR.swift);
    for (const rule of swiftRules) {
      expect(rule.modes).toEqual(['advanced']);
    }
  });

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
  // graph-first.md is the graphify discipline rule (REQ-AGENT-023, AD52).
  //   The graphify MCP server is registered for all session modes (ambient
  //   capability) but the rule that teaches the agent to prefer graph MCP
  //   queries over Grep ships to advanced only - the discipline-vs-capability
  //   split.
  const ADVANCED_ONLY_CODEFLARE_RULES = [
    '.claude/rules/memory.md',
    '.claude/rules/spec-discipline.md',
    '.claude/rules/documentation-discipline.md',
    '.claude/rules/tdd-discipline.md',
    '.claude/rules/graph-first.md',
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

  it('graph-first rule is advanced-only (graphify discipline, REQ-AGENT-023 / AD52)', () => {
    const graphFirstRule = codeflareRules().find(
      (doc) => doc.key === '.claude/rules/graph-first.md'
    );
    expect(graphFirstRule).toBeDefined();
    expect(graphFirstRule!.modes).toEqual(['advanced']);
  });

  it('total ECC rules count is 18', () => {
    expect(eccRules().length).toBe(18);
  });
});
