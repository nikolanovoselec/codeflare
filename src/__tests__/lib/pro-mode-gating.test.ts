// REQ-MEM-006 backfill: memory/vault features gated behind advanced mode.
//
// AC1 (vault NOT preserved across recreations in default mode) and AC2
// (default-mode capture hook runs counter but no vault write) are
// behavioral and require integration / E2E setup that this unit suite
// cannot host; they remain in the integration suite per the spec's
// Verification field.
//
// AC3 (memory + vault rules + plugins are advanced-only) -- THIS FILE.
// AC4 (Pro is a strict superset of Standard) -- already covered in
// agent-seed-manifest.test.ts (`"advanced" is a superset of "default"`).
// AC5 (entrypoint.sh hook-merge mode gating) -- host/__tests__/pro-mode-gating-static.test.js
//      (Workers vitest pool cannot readFileSync entrypoint.sh).
// AC6 (resolveSessionMode default) -- covered in session-mode.test.ts.
// AC7 (mode changes only via recreate or new bucket) -- behavioral; integration.
// AC8 (reconcileAgentConfigs never touches user files) -- host/__tests__/pro-mode-gating-static.test.js.
import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

describe('REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)', () => {
  const advancedOnly = (key: string) =>
    AGENTS_SEEDED_CONFIGS.filter((d) => d.key === key).every(
      (d) => d.modes.length === 1 && d.modes[0] === 'advanced'
    );

  const has = (key: string) => AGENTS_SEEDED_CONFIGS.some((d) => d.key === key);

  it('rules/memory.md is advanced-only', () => {
    expect(has('.claude/rules/memory.md'), '.claude/rules/memory.md must be present in the seed').toBe(true);
    expect(advancedOnly('.claude/rules/memory.md'),
      'rules/memory.md must be tagged advanced-only -- it documents vault capture which is Pro-only').toBe(true);
  });

  it('vault subsystem is folded into rules/memory.md (no separate rules/vault.md)', () => {
    // Architectural choice: vault trigger/route content lives in memory.md
    // as the 'Vault operations' and 'Vault-edit hook' subsections, rather
    // than a separate rules/vault.md file. memory.md is advanced-only
    // (verified above), so vault is still Pro-mode gated.
    expect(has('.claude/rules/vault.md'),
      'rules/vault.md was folded into memory.md and should NOT appear in the seed').toBe(false);
  });

  it('rules/vault-note-capture.md is advanced-only', () => {
    expect(has('.claude/rules/vault-note-capture.md'), '.claude/rules/vault-note-capture.md must be present in the seed').toBe(true);
    expect(advancedOnly('.claude/rules/vault-note-capture.md'),
      'rules/vault-note-capture.md drives the vault-note-capture skill; must be Pro-only').toBe(true);
  });

  it('all codeflare-memory plugin files are advanced-only', () => {
    const memory = AGENTS_SEEDED_CONFIGS.filter((d) =>
      d.key.startsWith('.claude/plugins/codeflare-memory/')
    );
    expect(memory.length, 'codeflare-memory plugin must have at least one file in the seed').toBeGreaterThan(0);
    for (const doc of memory) {
      expect(doc.modes, `${doc.key} must be tagged advanced-only`).toEqual(['advanced']);
    }
  });

  it('all codeflare-vault plugin files are advanced-only', () => {
    const vault = AGENTS_SEEDED_CONFIGS.filter((d) =>
      d.key.startsWith('.claude/plugins/codeflare-vault/')
    );
    expect(vault.length, 'codeflare-vault plugin must have at least one file in the seed').toBeGreaterThan(0);
    for (const doc of vault) {
      expect(doc.modes, `${doc.key} must be tagged advanced-only`).toEqual(['advanced']);
    }
  });

  it('non-Claude agents do not receive memory or vault plugins', () => {
    // The memory and vault subsystems depend on Claude-specific MCP and
    // hook systems; shipping them to Codex/Gemini/Copilot/OpenCode would
    // produce empty/broken plugs.
    const nonClaude = AGENTS_SEEDED_CONFIGS.filter((d) => !d.key.startsWith('.claude/'));
    for (const doc of nonClaude) {
      expect(doc.key).not.toContain('codeflare-memory');
      expect(doc.key).not.toContain('codeflare-vault');
    }
  });
});
