// REQ-MEM-001 AC3: buildEnvVars must propagate the per-session
// USER_TIMEZONE so the capture haiku's `TZ="$RESOLVED" date '+%...'`
// step produces a wall-clock timestamp in the user's local zone
// instead of falling all the way through to UTC. Without this, every
// vault capture filename gets a +0000 suffix regardless of where the
// user actually is.

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
    // Field gated by REQ-MEM-001 AC3 (added in this PR).
    _userTimezone: null,
  } as unknown as ContainerEnvState;
}

const baseEnv: Env = {} as Env;

describe('buildEnvVars (REQ-MEM-001 AC3)', () => {
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
});

// Regression test for the entry-point destructure: handleSetBucketName at
// container/index.ts forwards r2Creds (including userTimezone) to
// applyBucketName, which must persist + write the state field. The
// original PR #390 wired everything except this destructure, so the field
// was silently dropped and USER_TIMEZONE always emitted empty in
// production. Both code paths (first-time setBucketName via applyBucketName,
// and subsequent wakes via applyPrefsOnRestart) are exercised here.
describe('applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-MEM-001 AC3 wiring regression)', () => {
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
