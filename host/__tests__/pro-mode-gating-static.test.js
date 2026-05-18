// REQ-MEM-006 backfill (static source-level checks).
//
// Manifest assertions for AC3 live in src/__tests__/lib/pro-mode-gating.test.ts
// (vitest, uses the generated AGENTS_SEEDED_CONFIGS). This file covers
// AC5 (entrypoint.sh hook-merge mode gating) and AC8 (reconcileAgentConfigs
// guarded against bulk deletion of user files) because those require
// readFileSync on source files which the Workers vitest pool does not
// allow.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../');

describe('REQ-MEM-006 AC5: entrypoint.sh merges hook registrations only in advanced mode', () => {
  const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

  it('default-mode SETTINGS_CONFIG contains only skipDangerousModePermissionPrompt', () => {
    // The default-mode branch in entrypoint.sh writes a minimal config.
    // Any drift (e.g. accidentally including a hooks block) would
    // silently turn on capture/memory hooks for Standard users.
    assert.ok(
      entrypoint.includes(`SETTINGS_CONFIG='{"skipDangerousModePermissionPrompt":true}'`),
      'default-mode SETTINGS_CONFIG block must be exactly {"skipDangerousModePermissionPrompt":true}'
    );
  });

  it('advanced-mode SETTINGS_CONFIG includes UserPromptSubmit hook for memory-capture.sh', () => {
    // The advanced-mode branch builds a larger hooks block.
    // memory-capture.sh and vault-monitor-hook.sh must both register
    // on UserPromptSubmit.
    assert.ok(/codeflare-memory\/scripts\/memory-capture\.sh/.test(entrypoint),
      'entrypoint.sh advanced-mode SETTINGS_CONFIG must reference codeflare-memory/scripts/memory-capture.sh');
    assert.ok(/codeflare-vault\/scripts\/vault-monitor-hook\.sh/.test(entrypoint),
      'entrypoint.sh advanced-mode SETTINGS_CONFIG must reference codeflare-vault/scripts/vault-monitor-hook.sh');
  });

  it('advanced-mode and default-mode are separate, ordered log sentinels', () => {
    // The two SETTINGS_CONFIG assignments must live in separate
    // mode-gated branches identified by their log lines.
    const advIdx = entrypoint.indexOf('Advanced mode: configuring settings.json with hooks');
    const defIdx = entrypoint.indexOf('Default mode: configuring settings.json without hooks');
    assert.ok(advIdx > 0, 'entrypoint.sh must log "Advanced mode: configuring settings.json with hooks"');
    assert.ok(defIdx > 0, 'entrypoint.sh must log "Default mode: configuring settings.json without hooks"');
    assert.ok(defIdx > advIdx,
      'default-mode log must follow advanced-mode log (else-branch ordering)');
  });
});

describe('REQ-MEM-006 AC8: reconcileAgentConfigs preserves user-created files', () => {
  const r2seed = readFileSync(resolve(repoRoot, 'src/lib/r2-seed.ts'), 'utf8');

  it('reconcileAgentConfigs is exported from r2-seed.ts', () => {
    assert.ok(
      /export\s+(async\s+)?function\s+reconcileAgentConfigs/.test(r2seed),
      'src/lib/r2-seed.ts must export a reconcileAgentConfigs function'
    );
  });

  it('reconcile is manifest-driven (uses AGENTS_SEEDED_CONFIGS / managed key set)', () => {
    // The function must NOT call deleteObjects with arbitrary key
    // patterns; deletes are filtered through the manifest. The exact
    // identifier may evolve - accept several known shapes.
    assert.ok(
      /AGENTS_SEEDED_CONFIGS|AGENT_SEEDED_KEYS|agentSeedKeys|seededKeys/.test(r2seed),
      'r2-seed.ts reconcile must filter through a manifest-driven key set so user files are never collateral'
    );
  });

  it('reconcile does NOT issue a bulk wildcard delete of .claude/**', () => {
    // A wildcard delete of '.claude/**' would obliterate user files.
    // The function must iterate explicit keys from the manifest.
    assert.ok(
      !/deleteAll\s*\(/.test(r2seed),
      'r2-seed.ts must not call deleteAll() (would risk wiping user-created files)'
    );
    assert.ok(
      !/deleteObjects\s*\(\s*['"]\.claude\/\*\*['"]/.test(r2seed),
      "r2-seed.ts must not deleteObjects('.claude/**') (would risk wiping user-created files)"
    );
  });
});
