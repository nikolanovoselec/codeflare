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
    // Enterprise route catalog defaults to [] in production (container/index.ts);
    // the enterprise branch of buildEnvVars reads `.length`, so the fixture must
    // carry the same empty-array default rather than leaving it undefined.
    _routeCatalog: [],
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

  // REQ-AGENT-031 AC1/AC2: provider keys reach the container ONLY under the
  // CODEFLARE_ namespace, so coding agents (Pi, opencode, antigravity) cannot
  // auto-detect them as their own credentials and silently bill the user's API
  // account. entrypoint.sh maps them back to the bare names solely inside the
  // consult-llm MCP server's scoped env block.
  it('REQ-AGENT-031 AC1: emits CODEFLARE_OPENAI_API_KEY / CODEFLARE_GEMINI_API_KEY when keys are set', () => {
    const state = baseState();
    const s = state as unknown as { _openaiApiKey: string | null; _geminiApiKey: string | null };
    s._openaiApiKey = 'sk-openai';
    s._geminiApiKey = 'gm-gemini';
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.CODEFLARE_OPENAI_API_KEY).toBe('sk-openai');
    expect(vars.CODEFLARE_GEMINI_API_KEY).toBe('gm-gemini');
  });

  // The whole point of the namespace: the bare provider env names must NEVER
  // appear in the container's global env. That auto-detect was the drain that
  // exhausted the user's OpenAI quota when Pi grabbed OPENAI_API_KEY.
  it('REQ-AGENT-031 AC1 regression: never emits bare OPENAI_API_KEY / GEMINI_API_KEY into the global env', () => {
    const state = baseState();
    const s = state as unknown as { _openaiApiKey: string | null; _geminiApiKey: string | null };
    s._openaiApiKey = 'sk-openai';
    s._geminiApiKey = 'gm-gemini';
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.OPENAI_API_KEY).toBeUndefined();
    expect(vars.GEMINI_API_KEY).toBeUndefined();
  });

  it('REQ-AGENT-031 AC1: omits the LLM keys entirely when unset', () => {
    const state = baseState();
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.CODEFLARE_OPENAI_API_KEY).toBeUndefined();
    expect(vars.CODEFLARE_GEMINI_API_KEY).toBeUndefined();
  });

  // REQ-AGENT-031 AC6: enterprise mode routes models through the AI Gateway BYOK;
  // per-user LLM keys do not exist there, so NEITHER the namespaced nor the bare
  // names are injected even when keys somehow remain in DO state.
  it('REQ-AGENT-031 AC6: injects no LLM keys in enterprise mode', () => {
    const state = baseState();
    const s = state as unknown as { _openaiApiKey: string | null; _geminiApiKey: string | null };
    s._openaiApiKey = 'sk-openai';
    s._geminiApiKey = 'gm-gemini';
    const enterpriseEnv = { ENTERPRISE_MODE: 'active' } as unknown as Env;
    const vars = buildEnvVars(state, enterpriseEnv) as Record<string, string | undefined>;
    expect(vars.CODEFLARE_OPENAI_API_KEY).toBeUndefined();
    expect(vars.CODEFLARE_GEMINI_API_KEY).toBeUndefined();
    expect(vars.OPENAI_API_KEY).toBeUndefined();
    expect(vars.GEMINI_API_KEY).toBeUndefined();
    expect(vars.ENTERPRISE_MODE).toBe('active');
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

  // CF-063 / REQ-AGENT-029 AC2: deploy credentials (GitHub + Cloudflare) are
  // forwarded from DO state to the container env vars when set, and OMITTED
  // (not emitted empty) when cleared to null so a revoked credential is unset
  // in the container rather than left stale.
  // @test buildEnvVars emits GH_TOKEN when state._githubToken is set
  // @test buildEnvVars emits CLOUDFLARE_API_TOKEN when state._cloudflareApiToken is set
  // @test buildEnvVars emits CLOUDFLARE_ACCOUNT_ID when state._cloudflareAccountId is set
  it('CF-063: emits GH_TOKEN / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID when deploy creds are set', () => {
    const state = baseState();
    const s = state as unknown as {
      _githubToken: string | null;
      _cloudflareApiToken: string | null;
      _cloudflareAccountId: string | null;
    };
    s._githubToken = 'ghp_token';
    s._cloudflareApiToken = 'cf_api_token';
    s._cloudflareAccountId = 'cf_account_id';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.GH_TOKEN).toBe('ghp_token');
    expect(vars.CLOUDFLARE_API_TOKEN).toBe('cf_api_token');
    expect(vars.CLOUDFLARE_ACCOUNT_ID).toBe('cf_account_id');
  });

  // @test buildEnvVars omits GH_TOKEN when state._githubToken is null
  // @test buildEnvVars omits CLOUDFLARE_API_TOKEN when state._cloudflareApiToken is null
  // @test buildEnvVars omits CLOUDFLARE_ACCOUNT_ID when state._cloudflareAccountId is null
  it('CF-063: omits GH_TOKEN / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID when deploy creds are null', () => {
    const state = baseState();
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.GH_TOKEN).toBeUndefined();
    expect(vars.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(vars.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
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

  // REQ-ENTERPRISE-004 (revised): userGroups restart compare uses JSON.stringify
  // value equality. A reference !== compare on arrays is ALWAYS true, so it would
  // re-write storage every restart even when the membership is unchanged.
  it('does NOT re-write userGroups storage on restart when the list is value-equal (different array reference)', async () => {
    const state = baseState();
    (state as unknown as { _userGroups: string[] })._userGroups = ['a', 'b'];
    const { writes, storage } = makeStorage();
    await applyPrefsOnRestart(state, storage, { userGroups: ['a', 'b'] }); // fresh array, same value
    expect(writes.userGroups).toBeUndefined();
  });

  it('re-writes userGroups storage on restart when the list value changed', async () => {
    const state = baseState();
    (state as unknown as { _userGroups: string[] })._userGroups = ['a'];
    const { writes, storage } = makeStorage();
    await applyPrefsOnRestart(state, storage, { userGroups: ['a', 'b'] });
    expect(writes.userGroups).toEqual(['a', 'b']);
    expect((state as unknown as { _userGroups: string[] })._userGroups).toEqual(['a', 'b']);
  });
});
