import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

/**
 * Validates ECC (Everything Claude Code) rule integration in the generated
 * agent seed configs. ECC rules are language-specific and common rules that
 * should only be available in advanced session mode.
 */

const ECC_SUBDIRS = ['common', 'typescript', 'python', 'golang', 'swift'] as const;

// Expected file count per subdirectory
const ECC_FILES_PER_SUBDIR: Record<string, number> = {
  common: 8, // agents, coding-style, development-workflow, git-workflow, patterns, performance, security, testing
  typescript: 5, // coding-style, hooks, patterns, security, testing
  python: 5,
  golang: 5,
  swift: 5,
};

function eccRules() {
  return AGENTS_SEEDED_CONFIGS.filter((doc) =>
    ECC_SUBDIRS.some((dir) => doc.key.startsWith(`.claude/rules/${dir}/`))
  );
}

function codeflareRules() {
  // Original codeflare rules — directly in .claude/rules/ without a subdirectory
  return AGENTS_SEEDED_CONFIGS.filter(
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

  it('existing codeflare rules still have default+advanced modes', () => {
    const cfRules = codeflareRules();
    expect(cfRules.length).toBeGreaterThan(0);
    for (const rule of cfRules) {
      expect(rule.modes).toContain('default');
      expect(rule.modes).toContain('advanced');
    }
  });

  it('total ECC rules count is 28', () => {
    expect(eccRules().length).toBe(28);
  });
});
