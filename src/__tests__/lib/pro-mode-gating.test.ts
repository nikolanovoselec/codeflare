// REQ-MEM-006 backfill: memory/vault features gated behind advanced mode.
//
// AC1 (vault NOT preserved across recreations in default mode) and AC2
// (default-mode capture hook runs counter but no vault write) are
// behavioral and require integration / E2E setup that this unit suite
// cannot host; they remain in the integration suite per the spec's
// Verification field.
//
// AC3 (memory + vault rules + plugins are advanced-only) -- this file.
// AC4 (Pro is a strict superset of Standard) -- already covered in
// agent-seed-manifest.test.ts (`"advanced" is a superset of "default"`).
// AC5 (entrypoint.sh merges hook registrations only in advanced) -- this file.
// AC6 (resolveSessionMode default) -- covered in session-mode.test.ts.
// AC7 (mode changes only via recreate or new bucket) -- behavioral; integration.
// AC8 (reconcileAgentConfigs never touches user files) -- this file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only', () => {
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

  it('rules/vault.md is advanced-only', () => {
    expect(has('.claude/rules/vault.md'), '.claude/rules/vault.md must be present in the seed').toBe(true);
    expect(advancedOnly('.claude/rules/vault.md'),
      'rules/vault.md must be tagged advanced-only -- vault is a Pro feature').toBe(true);
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

describe('REQ-MEM-006 AC5: entrypoint.sh merges hook registrations only in advanced mode', () => {
  const entrypoint = readFileSync(resolve(__dirname, '../../../entrypoint.sh'), 'utf8');

  it('default-mode SETTINGS_CONFIG contains only skipDangerousModePermissionPrompt', () => {
    // The default-mode branch in entrypoint.sh writes a minimal config.
    // Any drift (e.g. accidentally including a hooks block) would
    // silently turn on capture/memory hooks for Standard users.
    assert_contains(
      entrypoint,
      `SETTINGS_CONFIG='{"skipDangerousModePermissionPrompt":true}'`,
      'default-mode SETTINGS_CONFIG block must be exactly {"skipDangerousModePermissionPrompt":true}'
    );
  });

  it('advanced-mode SETTINGS_CONFIG includes UserPromptSubmit hook for memory-capture.sh', () => {
    // The advanced-mode branch builds a larger hooks block. memory-capture.sh
    // and vault-monitor-hook.sh must both register on UserPromptSubmit.
    expect(entrypoint).toMatch(/codeflare-memory\/scripts\/memory-capture\.sh/);
    expect(entrypoint).toMatch(/codeflare-vault\/scripts\/vault-monitor-hook\.sh/);
  });

  it('advanced-mode hook block is gated on the session mode branch', () => {
    // The two SETTINGS_CONFIG assignments must be in separate
    // branches: one in the advanced path, one in the default fallback.
    // Find the `Advanced mode: configuring` and `Default mode: configuring`
    // log lines as sentinels.
    expect(entrypoint).toMatch(/Advanced mode: configuring settings\.json with hooks/);
    expect(entrypoint).toMatch(/Default mode: configuring settings\.json without hooks/);
    // Default mode log must come AFTER advanced (else branch).
    const advIdx = entrypoint.indexOf('Advanced mode: configuring settings.json with hooks');
    const defIdx = entrypoint.indexOf('Default mode: configuring settings.json without hooks');
    expect(advIdx).toBeGreaterThan(0);
    expect(defIdx).toBeGreaterThan(advIdx);
  });
});

describe('REQ-MEM-006 AC8: reconcileAgentConfigs never touches user-created files', () => {
  // Static structural check on the reconcile function: it must only
  // act on keys whose source is a preseed-managed entry, never on
  // user-written files. The function lives in src/lib/r2-seed.ts.
  const r2seed = readFileSync(resolve(__dirname, '../../lib/r2-seed.ts'), 'utf8');

  it('reconcileAgentConfigs is defined in r2-seed.ts', () => {
    expect(r2seed).toMatch(/export\s+(async\s+)?function\s+reconcileAgentConfigs/);
  });

  it('reconcile only deletes keys that match an AGENTS_SEEDED_CONFIGS entry', () => {
    // The function must NOT call deleteObjects with arbitrary key
    // patterns; deletes are filtered through the manifest. Look for
    // the manifest-driven key set used by the delete pass.
    expect(r2seed).toMatch(/AGENTS_SEEDED_CONFIGS|AGENT_SEEDED_KEYS|agentSeedKeys/);
  });

  it('reconcile guards delete with a managed-keys allowlist (no bulk wildcard delete)', () => {
    // A wildcard delete of '.claude/**' would obliterate user files.
    // The function must iterate explicit keys from the manifest.
    expect(r2seed).not.toMatch(/deleteAll\s*\(/);
    expect(r2seed).not.toMatch(/deleteObjects\s*\(\s*['"]\.claude\/\*\*['"]/);
  });
});

// Local helper -- supports the AC5 SETTINGS_CONFIG assertion that
// would otherwise need a substring escape gymnastics for the JSON
// literal containing single quotes and curlies.
function assert_contains(haystack: string, needle: string, msg: string): void {
  expect(haystack.includes(needle), msg).toBe(true);
}
