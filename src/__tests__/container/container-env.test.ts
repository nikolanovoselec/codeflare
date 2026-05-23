// REQ-SESSION-016 AC3: buildEnvVars must propagate the per-session
// USER_TIMEZONE into the container env-var pipeline so REQ-MEM-010 AC4
// (capture pipeline consumes $USER_TIMEZONE) gets a non-empty value.
// Without this, every vault capture filename gets a +0000 suffix
// regardless of where the user actually is.

import { describe, it, expect } from 'vitest';
import { buildEnvVars, applyBucketName, applyPrefsOnRestart, type ContainerEnvState } from '../../container/container-env';
import type { Env } from '../../types';

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
    _sessionId: 'sid-abcdef12',
    _userEmail: 'user@example.com',
    // Field gated by REQ-SESSION-016 AC3 (added in this PR).
    _userTimezone: null,
  } as unknown as ContainerEnvState;
}

const baseEnv: Env = {} as Env;

describe('buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)', () => {
  it('emits USER_TIMEZONE when _userTimezone is set', () => {
    const state = baseState();
    (state as unknown as { _userTimezone: string | null })._userTimezone = 'Europe/Zurich';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.USER_TIMEZONE).toBe('Europe/Zurich');
  });

  it('omits USER_TIMEZONE when _userTimezone is null', () => {
    const state = baseState();
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.USER_TIMEZONE).toBeUndefined();
  });

  it('omits USER_TIMEZONE when _userTimezone is empty string', () => {
    const state = baseState();
    (state as unknown as { _userTimezone: string | null })._userTimezone = '';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.USER_TIMEZONE).toBeUndefined();
  });

  it('does not affect other env vars (regression guard)', () => {
    const state = baseState();
    (state as unknown as { _userTimezone: string | null })._userTimezone = 'Europe/Zurich';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
  });

  // REQ-SEC-005 AC3: ENCRYPTION_KEY is forwarded from Worker -> DO state ->
  // container env var so entrypoint create_rclone_config can append the
  // sse_customer_key_base64 / sse_customer_algorithm lines.
  it('REQ-SEC-005 AC3: emits ENCRYPTION_KEY when state._encryptionKey is set', () => {
    const state = baseState();
    (state as unknown as { _encryptionKey: string | null })._encryptionKey =
      'YXNkZmFzZGZhc2RmYXNkZmFzZGZhc2RmYXNkZg==';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ENCRYPTION_KEY).toBe('YXNkZmFzZGZhc2RmYXNkZmFzZGZhc2RmYXNkZg==');
  });

  // REQ-SEC-005 AC7: when no ENCRYPTION_KEY is set, R2 operations proceed
  // without SSE-C headers (no code path changes). Verified at the env-var
  // boundary: omitted entirely rather than emitted empty.
  it('REQ-SEC-005 AC7: omits ENCRYPTION_KEY when state._encryptionKey is null', () => {
    const state = baseState();
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ENCRYPTION_KEY).toBeUndefined();
  });
});

// Regression test for the entry-point destructure: handleSetBucketName at
// container/index.ts forwards r2Creds (including userTimezone) to
// applyBucketName, which must persist + write the state field. The
// original PR #390 wired everything except this destructure, so the field
// was silently dropped and USER_TIMEZONE always emitted empty in
// production. Both code paths (first-time setBucketName via applyBucketName,
// and subsequent wakes via applyPrefsOnRestart) are exercised here.
describe('applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)', () => {
  function makeStorage() {
    const writes: Record<string, unknown> = {};
    return {
      writes,
      storage: {
        put: async (key: string, value: unknown) => {
          writes[key] = value;
        },
      },
    };
  }

  it('applyBucketName persists userTimezone into both state and storage', async () => {
    const state = baseState();
    const { writes, storage } = makeStorage();
    await applyBucketName(state, 'codeflare-test', baseEnv, storage, {
      userTimezone: 'Europe/Zurich',
    });
    expect((state as unknown as { _userTimezone: string | null })._userTimezone).toBe('Europe/Zurich');
    expect(writes.userTimezone).toBe('Europe/Zurich');
  });

  it('applyBucketName leaves userTimezone untouched when omitted', async () => {
    const state = baseState();
    const { writes, storage } = makeStorage();
    await applyBucketName(state, 'codeflare-test', baseEnv, storage, {});
    expect((state as unknown as { _userTimezone: string | null })._userTimezone).toBeNull();
    expect(writes.userTimezone).toBeUndefined();
  });

  it('applyPrefsOnRestart updates userTimezone on wake when value changes', async () => {
    const state = baseState();
    (state as unknown as { _userTimezone: string | null })._userTimezone = 'UTC';
    const { writes, storage } = makeStorage();
    const changed = await applyPrefsOnRestart(state, storage, {
      userTimezone: 'America/New_York',
    });
    expect(changed).toBe(true);
    expect((state as unknown as { _userTimezone: string | null })._userTimezone).toBe('America/New_York');
    expect(writes.userTimezone).toBe('America/New_York');
  });

  it('applyPrefsOnRestart is a no-op when userTimezone unchanged', async () => {
    const state = baseState();
    (state as unknown as { _userTimezone: string | null })._userTimezone = 'Europe/Zurich';
    const { writes, storage } = makeStorage();
    const changed = await applyPrefsOnRestart(state, storage, {
      userTimezone: 'Europe/Zurich',
    });
    expect(changed).toBe(false);
    expect(writes.userTimezone).toBeUndefined();
  });
});
