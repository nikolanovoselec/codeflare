import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import smartCompactConfig, { configureSmartCompact } from '../../../preseed/agents/pi/extensions/00-smart-compact-config';
import { handleContextModeCommand, type PiSettings } from '../../../preseed/agents/pi/extensions/ctx-command';

// Intentional persisted configuration contract, not a snapshot of implementation.
// Thorough uses upstream's built-in 10k summary / 30k recent-token budgets:
// no profiles or legacy profile override is needed. No provider is invoked here.
const MANAGED_DEFAULTS = {
  mode: 'thorough',
  compactionEngines: ['eesv'],
  summaryModel: null,
  segmentationModel: null,
  verificationModel: null,
  summaryThinkingLevel: 'low',
  autoTrigger: true,
  autoTriggerStrategy: 'native-hook',
  minContextPercent: 0,
  maxContextTokens: 272000,
  maxLlmCalls: 4,
  maxLatencyMs: 120000,
  autoTriggerTimeoutMs: 120000,
  requireApproval: true,
  backupEnabled: true,
  zeroCallEnabled: false,
  contextGraphEnabled: false,
  contextHygieneEnabled: false,
  contextNavigationEnabled: false,
  contextRecallEnabled: false,
  contextPivotEnabled: false,
  contextAnchorCacheEnabled: false,
  contextAnchorStatusEnabled: false,
  contextGuidanceEnabled: false,
  promptCacheRoutingEnabled: false,
  onlineDamageMonitor: true,
  agentToolAccess: 'disabled',
  toolLoading: 'off',
  showStatus: false,
};

let agentDir: string;
let settingsPath: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-smart-compact-config-'));
  settingsPath = join(agentDir, 'settings.json');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function readSettings(): PiSettings {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as PiSettings;
}

describe('REQ-AGENT-076 AC8: provider-neutral Smart Compact settings preparation', () => {
  it('REQ-AGENT-076 AC8: initializes an absent settings file with the agreed thorough/manual-approval configuration', async () => {
    await configureSmartCompact(agentDir);

    expect(readSettings()).toEqual({ smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-076 AC8: fills an absent smartCompact section without changing auth, provider, theme, packages, or separate auth files', async () => {
    const initial = {
      auth: { 'user-provider': { type: 'oauth', access: 'fixture-only' } },
      defaultProvider: 'user-provider', defaultModel: 'user-model', defaultThinkingLevel: 'high',
      providers: { 'user-provider': { baseUrl: 'https://provider.invalid/v1' } },
      theme: 'user-theme', extensions: ['user-extension.ts'],
      packages: ['npm:pi-smart-compact@10.6.2',
        { source: 'npm:user-extension@1.0.0', extensions: ['keep.ts'], skills: [] }],
      unrelated: { nested: ['keep', 'all'] },
    };
    writeSettings(initial);
    const authPath = join(agentDir, 'auth.json');
    const authBytes = '{ "user-provider": { "type": "api_key", "key": "fixture-only" } }\n';
    writeFileSync(authPath, authBytes);

    await configureSmartCompact(agentDir);

    expect(readSettings()).toEqual({ ...initial, smartCompact: MANAGED_DEFAULTS });
    expect(readFileSync(authPath, 'utf8')).toBe(authBytes);
  });

  it('REQ-AGENT-076 AC8: fills only missing keys and preserves explicit false, zero, null, array, model-route, and profile overrides', async () => {
    const overrides = {
      mode: 'fast', compactionEngines: [],
      summaryModel: 'custom-provider/summary', segmentationModel: 'custom-provider/segment',
      verificationModel: 'custom-provider/verify', summaryThinkingLevel: null,
      autoTrigger: false, maxContextTokens: 0, maxLlmCalls: 0, maxLatencyMs: 0,
      requireApproval: false, backupEnabled: false, zeroCallEnabled: true,
      contextGraphEnabled: true, onlineDamageMonitor: false,
      agentToolAccess: 'enabled', toolLoading: 'lazy', showStatus: true,
      profiles: { light: { summaryBudgetTokens: 14000, keepRecentTokens: 40000 } },
      customPreference: { keep: ['nested', 'values'] },
    };
    const initial = {
      theme: 'user-theme', defaultProvider: 'custom-provider', defaultModel: 'selected-model',
      packages: ['npm:unrelated@1.0.0'], smartCompact: overrides,
    };
    writeSettings(initial);

    await configureSmartCompact(agentDir);

    expect(readSettings()).toEqual({ ...initial, smartCompact: { ...MANAGED_DEFAULTS, ...overrides } });
  });

  it('REQ-AGENT-076 AC8: an empty smartCompact section receives all managed defaults without profile overrides', async () => {
    writeSettings({ smartCompact: {} });

    await configureSmartCompact(agentDir);

    expect(readSettings()).toEqual({ smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-076 AC8: repeated helper and extension loads yield the same complete settings', async () => {
    const initial = { theme: 'user-theme', packages: ['npm:user-package@1.0.0'], smartCompact: { autoTrigger: false } };
    writeSettings(initial);
    await configureSmartCompact(agentDir);
    const expected = { ...initial, smartCompact: { ...MANAGED_DEFAULTS, autoTrigger: false } };
    expect(readSettings()).toEqual(expected);

    await configureSmartCompact(agentDir);
    expect(readSettings()).toEqual(expected);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    await smartCompactConfig({} as never);
    await smartCompactConfig({} as never);
    expect(readSettings()).toEqual(expected);
  });

  it('REQ-AGENT-076 AC8: the default extension factory prepares settings immediately on load, before any session event', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    // No lifecycle dispatch or provider API: configuration must precede the
    // managed package reading settings, not wait for session_start.
    await smartCompactConfig({} as never);

    expect(readSettings()).toEqual({ smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-076 AC2/AC8: /ctx off stays disabled across Smart Compact loads until the next container boot', async () => {
    const userPackage = { source: 'npm:user-package@1.0.0', extensions: ['keep.ts'] };
    writeSettings({ theme: 'user-theme', packages: [userPackage,
      'npm:pi-smart-compact@10.6.2', { source: 'npm:context-mode@1.0.169', extensions: [] }] });
    const store = { read: readSettings, write: (settings: PiSettings) => writeSettings(settings) };
    const disabledPackage = { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] };

    await handleContextModeCommand('off', { ui: { notify() {} }, reload: async () => {} }, store);
    expect(readSettings().packages).toEqual([userPackage, 'npm:pi-smart-compact@10.6.2', disabledPackage]);
    await configureSmartCompact(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    await smartCompactConfig({} as never);

    expect(readSettings()).toEqual({ theme: 'user-theme',
      packages: [userPackage, 'npm:pi-smart-compact@10.6.2', disabledPackage], smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-076 AC8: malformed JSON fails closed without overwriting the original settings bytes', async () => {
    const malformed = '{ "theme": "user-theme", "smartCompact": { "autoTrigger": false },\n';
    writeFileSync(settingsPath, malformed);

    // Error reporting is not part of this helper's contract: a returned refusal
    // or a thrown error is acceptable, but losing user settings is not.
    try { await configureSmartCompact(agentDir); } catch { /* Refusal may be signalled by throwing. */ }

    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
  });

  for (const lockKind of ['directory', 'file'] as const) {
    it(`REQ-AGENT-076 AC8: an existing settings.json.lock ${lockKind} refuses a concurrent write without changing settings or the owner's lock`, async () => {
      const initial = { theme: 'user-theme', packages: ['npm:user-package@1.0.0'], smartCompact: { mode: 'balanced' } };
      writeSettings(initial);
      const before = readFileSync(settingsPath, 'utf8');
      const lockPath = join(agentDir, 'settings.json.lock');
      // Pi uses a lock directory; also refuse an occupied regular lock path.
      if (lockKind === 'directory') mkdirSync(lockPath);
      const ownerPath = lockKind === 'directory' ? join(lockPath, 'owner') : lockPath;
      writeFileSync(ownerPath, 'another writer owns this lock\n');

      try { await configureSmartCompact(agentDir); } catch { /* A locked file may be reported by throwing. */ }

      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(readSettings()).toEqual(initial);
      expect(readFileSync(ownerPath, 'utf8')).toBe('another writer owns this lock\n');
    });
  }
});
