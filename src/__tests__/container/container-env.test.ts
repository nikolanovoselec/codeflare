// REQ-MEM-001 AC3: buildEnvVars must propagate the per-session
// USER_TIMEZONE so the capture haiku's `TZ="$RESOLVED" date '+%...'`
// step produces a wall-clock timestamp in the user's local zone
// instead of falling all the way through to UTC. Without this, every
// vault capture filename gets a +0000 suffix regardless of where the
// user actually is.

import { describe, it, expect } from 'vitest';
import { buildEnvVars, type ContainerEnvState } from '../../container/container-env';
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
