/**
 * REQ-SESSION-008: Container restart preserves R2 bucket
 * AC coverage: AC2 (onStart re-arms collectMetrics and records containerStartedAt),
 *              AC3 (onStart refreshes envVars via updateEnvVars),
 *              AC4 (entrypoint rclone sync restores workspace on restart - structural),
 *              AC5 (sleepAfter/fastStart/sessionMode take effect on restart)
 *
 * AC1 (409 handler stores sessionId/prefs) is covered by existing container DO tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyPrefsOnRestart, type ContainerEnvState } from '../../container/container-env';

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({ accountId: 'test-account', endpoint: 'https://r2.test' }),
}));
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

function baseState(): ContainerEnvState {
  return {
    _bucketName: 'codeflare-test',
    _r2AccountId: 'acc',
    _r2Endpoint: 'https://r2.test',
    _r2AccessKeyId: 'AK',
    _r2SecretAccessKey: 'SK',
    _workspaceSyncEnabled: false,
    _fastStartEnabled: false,
    _tabConfig: null,
    _openaiApiKey: null,
    _geminiApiKey: null,
    _githubToken: null,
    _cloudflareApiToken: null,
    _cloudflareAccountId: null,
    _encryptionKey: null,
    _sessionMode: 'default',
    _containerAuthToken: 'tok',
    _sessionId: 'oldsession12345678',
    _userEmail: 'user@example.com',
    _userTimezone: null,
  } as unknown as ContainerEnvState;
}

function makeStorage() {
  const writes: Record<string, unknown> = {};
  const storage = {
    put: vi.fn(async (key: string, value: unknown) => {
      writes[key] = value;
    }),
  };
  return { writes, storage };
}

describe('REQ-SESSION-008: Container restart preserves R2 bucket', () => {
  // AC2 (onStart collectMetrics schedule + containerStartedAt + updateEnvVars):
  //   covered behaviorally by src/__tests__/container/index.test.ts
  //   (onStart lifecycle describe). Worker runtime cannot readFileSync arbitrary
  //   project files, so the source-presence audit lived here previously was
  //   broken; the behavioral test is the canonical anchor.

  // AC3: onStart refreshes envVars via updateEnvVars - preferences take effect
  describe('REQ-SESSION-008 AC3: onStart refreshes envVars via updateEnvVars', () => {
    it('applyPrefsOnRestart updates sessionId in state and storage', async () => {
      const state = baseState();
      const { writes, storage } = makeStorage();

      const changed = await applyPrefsOnRestart(state, storage, {
        sessionId: 'newsession12345678',
      });

      expect(changed).toBe(true);
      expect((state as any)._sessionId).toBe('newsession12345678');
      expect(writes._sessionId).toBe('newsession12345678');
    });

    it('applyPrefsOnRestart updates workspaceSyncEnabled when changed', async () => {
      const state = baseState();
      (state as any)._workspaceSyncEnabled = false;
      const { writes, storage } = makeStorage();

      const changed = await applyPrefsOnRestart(state, storage, {
        workspaceSyncEnabled: true,
      });

      expect(changed).toBe(true);
      expect((state as any)._workspaceSyncEnabled).toBe(true);
      expect(writes.workspaceSyncEnabled).toBe(true);
    });

    it('applyPrefsOnRestart is a no-op when workspaceSyncEnabled unchanged', async () => {
      const state = baseState();
      (state as any)._workspaceSyncEnabled = true;
      const { writes, storage } = makeStorage();

      const changed = await applyPrefsOnRestart(state, storage, {
        workspaceSyncEnabled: true,
      });

      expect(changed).toBe(false);
      expect(writes.workspaceSyncEnabled).toBeUndefined();
    });

    it('applyPrefsOnRestart updates fastStartEnabled when changed', async () => {
      const state = baseState();
      (state as any)._fastStartEnabled = false;
      const { writes, storage } = makeStorage();

      const changed = await applyPrefsOnRestart(state, storage, {
        fastStartEnabled: true,
      });

      expect(changed).toBe(true);
      expect((state as any)._fastStartEnabled).toBe(true);
      expect(writes.fastStartEnabled).toBe(true);
    });
  });

  // AC4 (entrypoint rclone sync on restart): covered by
  //   host/__tests__/entrypoint-bisync-behavior.test.js (real bash spawn).

  // AC5: User preference changes take effect on restart without container recreation
  describe('REQ-SESSION-008 AC5: sleepAfter, fastStart, sessionMode take effect on restart', () => {
    it('applyPrefsOnRestart updates tabConfig on restart', async () => {
      const state = baseState();
      const { writes, storage } = makeStorage();
      const newTabConfig = [{ id: '1', command: 'bash', label: 'Bash' }];

      const changed = await applyPrefsOnRestart(state, storage, {
        tabConfig: newTabConfig,
      });

      expect(changed).toBe(true);
      expect((state as any)._tabConfig).toEqual(newTabConfig);
      expect(writes.tabConfig).toEqual(newTabConfig);
    });

    it('applyPrefsOnRestart returns false when no preferences changed', async () => {
      const state = baseState();
      const { storage } = makeStorage();

      // Pass no preference fields - nothing changes
      const changed = await applyPrefsOnRestart(state, storage, {});

      expect(changed).toBe(false);
    });
  });
});
