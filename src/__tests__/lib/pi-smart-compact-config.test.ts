import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import smartCompactConfig, { configureSmartCompact } from '../../../preseed/agents/pi/extensions/00-smart-compact-config';
import { handleContextModeCommand, type PiSettings } from '../../../preseed/agents/pi/extensions/ctx-command';

// Intentional initial-preset contract: retain the managed values, changing only
// mode to auto. Seed only an absent section; never fill or rewrite a user object.
const MANAGED_DEFAULTS = {
  mode: 'auto',
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

describe('REQ-AGENT-223: provider-neutral Smart Compact settings preparation', () => {
  it('REQ-AGENT-223: initializes an absent settings file with the full managed preset in auto mode', async () => {
    await configureSmartCompact(agentDir);

    expect(readSettings()).toEqual({ smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-223: adds only an absent smartCompact section without changing unrelated settings or auth files', async () => {
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

  it('REQ-AGENT-223: preserves explicit false, zero, null, array, model-route, profile, and unknown options byte-for-byte', async () => {
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
    const bytes = `\n${JSON.stringify(initial, null, '\t')}\n\n`;
    writeFileSync(settingsPath, bytes);

    await configureSmartCompact(agentDir);

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each([
    ['empty object', {}],
    ['mode only', { mode: 'fast' }],
    ['autoTrigger false only', { autoTrigger: false }],
    ['unknown options only', { futureOption: { enabled: false, budget: 0 } }],
  ])('REQ-AGENT-223: leaves an existing %s byte-unchanged across helper and extension reloads', async (_label, smartCompact) => {
    const bytes = ` { "theme" : "user-theme", "smartCompact" : ${JSON.stringify(smartCompact)} }\n\n`;
    writeFileSync(settingsPath, bytes);

    await configureSmartCompact(agentDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    await smartCompactConfig({} as never);
    await smartCompactConfig({} as never);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each([
    ['empty object', {}],
    ['automatic-compaction opt-out', { autoTrigger: false }],
    ['partial configuration', { mode: 'fast', futureOption: { keep: [false, 0] } }],
  ])('REQ-AGENT-223: preserves semanticCompact-only %s byte-for-byte without inserting smartCompact across reloads', async (_label, semanticCompact) => {
    const bytes = ` { "theme" : "user-theme", "semanticCompact" : ${JSON.stringify(semanticCompact)} }\n\n`;
    writeFileSync(settingsPath, bytes);

    await configureSmartCompact(agentDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    await smartCompactConfig({} as never);
    await smartCompactConfig({} as never);

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
    expect(Object.hasOwn(readSettings(), 'smartCompact')).toBe(false);
  });

  it('REQ-AGENT-223: preserves canonical precedence when both supported sections exist', async () => {
    const bytes = ' { "smartCompact": { "autoTrigger": false }, "semanticCompact": { "autoTrigger": true }, "theme": "user-theme" }\n';
    writeFileSync(settingsPath, bytes);

    await configureSmartCompact(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    await smartCompactConfig({} as never);

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each(['null', '[]', 'false', '0', '"fast"'])('REQ-AGENT-223: preserves a malformed semanticCompact alias %s without inserting canonical defaults', async (json) => {
    const bytes = `{ "theme": "user-theme", "semanticCompact": ${json} }\n`;
    writeFileSync(settingsPath, bytes);

    try { await configureSmartCompact(agentDir); } catch { /* Refusal may be signalled by throwing. */ }

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
    expect(Object.hasOwn(readSettings(), 'smartCompact')).toBe(false);
  });

  it('REQ-AGENT-223: user edits after initial configuration survive repeated startup preparation', async () => {
    await configureSmartCompact(agentDir);
    const edited = '{\n  "smartCompact": { "mode": "balanced", "autoTrigger": false },\n  "theme": "user-theme"\n}\n';
    writeFileSync(settingsPath, edited);

    await configureSmartCompact(agentDir);
    await configureSmartCompact(agentDir);

    expect(readFileSync(settingsPath, 'utf8')).toBe(edited);
  });

  it('REQ-AGENT-223: the default extension factory prepares the full auto-mode preset immediately on load, before any session event', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    // No lifecycle dispatch or provider API: configuration must precede the
    // managed package reading settings, not wait for session_start.
    await smartCompactConfig({} as never);

    expect(readSettings()).toEqual({ smartCompact: MANAGED_DEFAULTS });
  });

  it('REQ-AGENT-076 AC2 / REQ-AGENT-223: /ctx off stays disabled across Smart Compact loads until the next container boot', async () => {
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

  for (const shape of ['relative', 'absolute', 'filtered-relative', 'filtered-absolute']) {
    for (const section of ['smartCompact', 'semanticCompact', 'both', 'absent']) {
      it(`REQ-AGENT-222 AC1 / REQ-AGENT-223: reconciles a ${shape} duplicate with ${section} preferences for the next discovery`, async () => {
        const source = shape.includes('absolute')
          ? join(agentDir, 'packages/pi-smart-compact-10.6.2')
          : './packages/pi-smart-compact-10.6.2';
        const legacy = shape.startsWith('filtered') ? { source, extensions: ['dist/index.js'] } : source;
        const canonical = { source: 'npm:pi-smart-compact@10.6.2', extensions: ['dist/index.js'], skills: [] };
        const userPackage = { source: 'npm:user-extension@1.0.0', extensions: [], custom: true };
        const initial = {
          packages: [legacy, canonical, userPackage, './custom/pi-smart-compact-10.6.2',
            './packages/pi-smart-compact-10.6.2-extra', 'npm:pi-smart-compact-extra@1.0.0'],
          extensions: ['user-extension.ts'], theme: 'keep-theme',
          ...(section === 'absent' ? {} : section === 'both'
            ? { smartCompact: { mode: 'fast', autoTrigger: false }, semanticCompact: { future: [0, null] } }
            : { [section]: { mode: 'fast', autoTrigger: false, future: [0, null] } }),
        };
        writeSettings(initial);
        const localDir = join(agentDir, 'packages/pi-smart-compact-10.6.2');
        mkdirSync(localDir, { recursive: true });
        writeFileSync(join(localDir, 'memory.json'), '{ "keep": true }\n');
        const authPath = join(agentDir, 'auth.json');
        writeFileSync(authPath, '{ "provider": "fixture-only" }\n');
        vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

        await smartCompactConfig({} as never);

        expect(readSettings()).toEqual({ ...initial, packages: initial.packages.slice(1),
          ...(section === 'absent' ? { smartCompact: MANAGED_DEFAULTS } : {}) });
        const once = readFileSync(settingsPath, 'utf8');
        await smartCompactConfig({} as never);
        expect(readFileSync(settingsPath, 'utf8')).toBe(once);
        expect(readFileSync(join(localDir, 'memory.json'), 'utf8')).toBe('{ "keep": true }\n');
        expect(readFileSync(authPath, 'utf8')).toBe('{ "provider": "fixture-only" }\n');
      });
    }
  }

  it('REQ-AGENT-223: retains a local-only registration and similarly named npm package without inserting a competing registration', async () => {
    const bytes = JSON.stringify({ smartCompact: { mode: 'fast' }, packages: [
      './packages/pi-smart-compact-10.6.2', 'npm:pi-smart-compact-extra@1.0.0',
    ] });
    writeFileSync(settingsPath, bytes);
    await configureSmartCompact(agentDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each(['null', '[]', 'false'])('REQ-AGENT-223: refuses duplicate migration with malformed compaction preferences %s', async value => {
    const bytes = `{ "smartCompact": ${value}, "packages": ["./packages/pi-smart-compact-10.6.2", "npm:pi-smart-compact@10.6.2"] }\n`;
    writeFileSync(settingsPath, bytes);
    await configureSmartCompact(agentDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each(['null', '[]', 'false', '0', '"fast"'])('REQ-AGENT-223: a malformed shadowed legacy section %s prevents duplicate migration despite a valid canonical section', async value => {
    const bytes = ` { "smartCompact": {}, "semanticCompact": ${value}, "packages": ["./packages/pi-smart-compact-10.6.2", "npm:pi-smart-compact@10.6.2"] }\n\n`;
    writeFileSync(settingsPath, bytes);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    await smartCompactConfig({} as never);
    await smartCompactConfig({} as never);

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it('REQ-AGENT-223: a locked settings file retains both registrations until safe reconciliation is possible', async () => {
    const bytes = '{ "smartCompact": {}, "packages": ["./packages/pi-smart-compact-10.6.2", "npm:pi-smart-compact@10.6.2"] }\n';
    writeFileSync(settingsPath, bytes);
    mkdirSync(`${settingsPath}.lock`);
    await configureSmartCompact(agentDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
    expect(lstatSync(`${settingsPath}.lock`).isDirectory()).toBe(true);
  });

  it('REQ-AGENT-223: malformed JSON fails closed without overwriting the original settings bytes', async () => {
    const malformed = '{ "theme": "user-theme", "smartCompact": { "autoTrigger": false },\n';
    writeFileSync(settingsPath, malformed);

    // Error reporting is not part of this helper's contract: a returned refusal
    // or a thrown error is acceptable, but losing user settings is not.
    try { await configureSmartCompact(agentDir); } catch { /* Refusal may be signalled by throwing. */ }

    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
  });

  it.each(['null', '[]', 'false', '0', '"fast"'])('REQ-AGENT-223: preserves a nonobject settings root %s without repair', async (json) => {
    const bytes = ` ${json}\n`;
    writeFileSync(settingsPath, bytes);

    try { await configureSmartCompact(agentDir); } catch { /* Refusal may be signalled by throwing. */ }

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  it.each(['null', '[]', 'false', '0', '"fast"'])('REQ-AGENT-223: preserves a nonobject smartCompact value %s without repair', async (json) => {
    const bytes = `{ "theme": "user-theme", "smartCompact": ${json} }\n`;
    writeFileSync(settingsPath, bytes);

    try { await configureSmartCompact(agentDir); } catch { /* Refusal may be signalled by throwing. */ }

    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes);
  });

  for (const target of ['settings file', 'ancestor directory'] as const) {
    it(`REQ-AGENT-223: refuses a symlinked ${target} without changing the link or target settings`, async () => {
      const realDir = join(agentDir, 'real', 'nested');
      mkdirSync(realDir, { recursive: true });
      const realSettings = join(realDir, 'settings.json');
      const bytes = '{ "theme": "user-theme" }\n';
      writeFileSync(realSettings, bytes);
      const link = target === 'settings file' ? settingsPath : join(agentDir, 'alias');
      symlinkSync(target === 'settings file' ? realSettings : join(agentDir, 'real'), link);

      try {
        await configureSmartCompact(target === 'settings file' ? agentDir : join(link, 'nested'));
      } catch { /* Refusal may be signalled by throwing. */ }

      expect(readFileSync(realSettings, 'utf8')).toBe(bytes);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
  }

  for (const lockKind of ['directory', 'file', 'symlink'] as const) {
    it(`REQ-AGENT-223: an existing settings.json.lock ${lockKind} refuses a concurrent write without changing settings or the owner's lock`, async () => {
      // The section is absent so configuration needs to seed the preset;
      // an early no-op must not mask a broken lock.
      const initial = { theme: 'user-theme', packages: ['npm:user-package@1.0.0'] };
      writeSettings(initial);
      const before = readFileSync(settingsPath, 'utf8');
      const lockPath = join(agentDir, 'settings.json.lock');
      if (lockKind === 'directory') mkdirSync(lockPath);
      const ownerPath = lockKind === 'directory' ? join(lockPath, 'owner')
        : lockKind === 'symlink' ? join(agentDir, 'lock-owner') : lockPath;
      writeFileSync(ownerPath, 'another writer owns this lock\n');
      if (lockKind === 'symlink') symlinkSync(ownerPath, lockPath);

      try { await configureSmartCompact(agentDir); } catch { /* A locked file may be reported by throwing. */ }

      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(readFileSync(ownerPath, 'utf8')).toBe('another writer owns this lock\n');
      if (lockKind === 'symlink') expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    });
  }
});
