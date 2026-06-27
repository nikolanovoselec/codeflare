// REQ-SESSION-016 AC3: buildEnvVars must propagate the per-session
// USER_TIMEZONE into the container env-var pipeline so REQ-MEM-010 AC4
// (capture pipeline consumes $USER_TIMEZONE) gets a non-empty value.
// Without this, every vault capture filename gets a +0000 suffix
// regardless of where the user actually is.

import { describe, it, expect } from 'vitest';
import { buildEnvVars, applyBucketName, applyPrefsOnRestart, type ContainerEnvState } from '../../container/container-env';
import type { Env } from '../../types';
import { ENTERPRISE_GH_TOKEN_PLACEHOLDER, ENTERPRISE_R2_KEY_PLACEHOLDER } from '../../lib/constants';

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

  // REQ-GITHUB-004: the one-shot clone directive flows DO state -> container env.
  // entrypoint.sh clones GIT_CLONE_REPO (with optional GIT_CLONE_REF) at start.
  it('REQ-GITHUB-004: emits GIT_CLONE_REPO when state._gitCloneRepo is set', () => {
    const state = baseState();
    (state as unknown as { _gitCloneRepo: string | null })._gitCloneRepo = 'octo/repo';
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.GIT_CLONE_REPO).toBe('octo/repo');
  });

  it('REQ-GITHUB-004: emits GIT_CLONE_REF when state._gitCloneRef is set', () => {
    const state = baseState();
    const s = state as unknown as { _gitCloneRepo: string | null; _gitCloneRef: string | null };
    s._gitCloneRepo = 'octo/repo';
    s._gitCloneRef = 'develop';
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.GIT_CLONE_REPO).toBe('octo/repo');
    expect(vars.GIT_CLONE_REF).toBe('develop');
  });

  it('REQ-GITHUB-004: omits both GIT_CLONE vars when unset', () => {
    const state = baseState();
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.GIT_CLONE_REPO).toBeUndefined();
    expect(vars.GIT_CLONE_REF).toBeUndefined();
  });

  it('REQ-GITHUB-004: omits GIT_CLONE_REF when only the repo is set', () => {
    const state = baseState();
    (state as unknown as { _gitCloneRepo: string | null })._gitCloneRepo = 'octo/repo';
    const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
    expect(vars.GIT_CLONE_REPO).toBe('octo/repo');
    expect(vars.GIT_CLONE_REF).toBeUndefined();
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

  // REQ-GITHUB-003: the real GitHub token must never enter an enterprise container.
  // @test buildEnvVars emits a placeholder GH_TOKEN (not the real token) in enterprise mode
  it('REQ-GITHUB-003 / REQ-GITHUB-006: emits a NON-SECRET placeholder GH_TOKEN in enterprise mode (real token never enters the container)', () => {
    const state = baseState();
    (state as unknown as { _githubToken: string | null })._githubToken = 'gho_real_secret';
    const vars = buildEnvVars(state, { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.GH_TOKEN).toBe(ENTERPRISE_GH_TOKEN_PLACEHOLDER);
    expect(vars.GH_TOKEN).not.toBe('gho_real_secret');
  });

  // @test buildEnvVars emits the real GH_TOKEN verbatim in non-enterprise mode (byte-identical to today)
  it('REQ-GITHUB-003 / REQ-GITHUB-006: emits the real GH_TOKEN unchanged in non-enterprise mode', () => {
    const state = baseState();
    (state as unknown as { _githubToken: string | null })._githubToken = 'gho_real_secret';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.GH_TOKEN).toBe('gho_real_secret');
  });

  // @test buildEnvVars omits GH_TOKEN entirely (no placeholder) in enterprise when not connected
  it('REQ-GITHUB-003: omits GH_TOKEN entirely in enterprise mode when not connected (no token to inject)', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    expect('GH_TOKEN' in vars).toBe(false);
  });

  // REQ-ENTERPRISE-016: when strict Gateway egress is active the real R2 key must NEVER
  // enter the container — both the AWS_* (rclone S3 provider) and R2_* names get a
  // non-secret placeholder; the EgressController strips it and re-signs with the
  // worker-held key at the R2 boundary.
  it('REQ-ENTERPRISE-016: emits a NON-SECRET placeholder R2 key (both AWS_* and R2_*) when _strictEgress is true (real key never enters the container)', () => {
    const state = baseState();
    (state as unknown as { _strictEgress: boolean })._strictEgress = true;
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.AWS_ACCESS_KEY_ID).toBe(ENTERPRISE_R2_KEY_PLACEHOLDER);
    expect(vars.AWS_SECRET_ACCESS_KEY).toBe(ENTERPRISE_R2_KEY_PLACEHOLDER);
    expect(vars.R2_ACCESS_KEY_ID).toBe(ENTERPRISE_R2_KEY_PLACEHOLDER);
    expect(vars.R2_SECRET_ACCESS_KEY).toBe(ENTERPRISE_R2_KEY_PLACEHOLDER);
    // The real key from DO state is NOT emitted anywhere.
    expect(vars.AWS_ACCESS_KEY_ID).not.toBe('AK');
    expect(vars.R2_SECRET_ACCESS_KEY).not.toBe('SK');
    // Non-secret endpoint/account stay real (rclone still targets the right bucket).
    expect(vars.R2_ACCOUNT_ID).toBe('acc');
    expect(vars.R2_ENDPOINT).toBe('https://r2.test');
  });

  // @test buildEnvVars emits the real R2 key verbatim when strict egress is off (byte-identical to today)
  it('REQ-ENTERPRISE-016: emits the real R2 key verbatim when _strictEgress is falsy (non-enterprise / strict-off unchanged)', () => {
    const vars = buildEnvVars(baseState(), baseEnv);
    expect(vars.AWS_ACCESS_KEY_ID).toBe('AK');
    expect(vars.AWS_SECRET_ACCESS_KEY).toBe('SK');
    expect(vars.R2_ACCESS_KEY_ID).toBe('AK');
    expect(vars.R2_SECRET_ACCESS_KEY).toBe('SK');
    expect(vars.AWS_ACCESS_KEY_ID).not.toBe(ENTERPRISE_R2_KEY_PLACEHOLDER);
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

  // REQ-ENTERPRISE-018 (Governed Mode): the container learns the bucket's R2 SSE-C
  // regime via R2_SSE_DISABLED, emitted iff _r2SseDisabled is set. entrypoint.sh
  // keys off it to drop SSE-C from rclone.conf and re-enable checksums.
  describe('R2_SSE_DISABLED (REQ-ENTERPRISE-018)', () => {
    it('emits R2_SSE_DISABLED=true when _r2SseDisabled is set', () => {
      const state = baseState();
      (state as unknown as { _r2SseDisabled: boolean })._r2SseDisabled = true;
      const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
      expect(vars.R2_SSE_DISABLED).toBe('true');
    });

    it('omits R2_SSE_DISABLED when _r2SseDisabled is false', () => {
      const state = baseState();
      (state as unknown as { _r2SseDisabled: boolean })._r2SseDisabled = false;
      const vars = buildEnvVars(state, baseEnv) as Record<string, string | undefined>;
      expect(vars.R2_SSE_DISABLED).toBeUndefined();
    });

    it('omits R2_SSE_DISABLED when _r2SseDisabled is unset (default container env)', () => {
      const vars = buildEnvVars(baseState(), baseEnv) as Record<string, string | undefined>;
      expect(vars.R2_SSE_DISABLED).toBeUndefined();
    });

    it('applyBucketName sets _r2SseDisabled from the body', async () => {
      const state = baseState();
      const { storage } = makeStorage();
      await applyBucketName(state, 'codeflare-test', baseEnv, storage, { r2SseDisabled: true });
      expect((state as unknown as { _r2SseDisabled: boolean })._r2SseDisabled).toBe(true);
    });

    it('applyBucketName defaults _r2SseDisabled to false when the body omits it', async () => {
      const state = baseState();
      const { storage } = makeStorage();
      await applyBucketName(state, 'codeflare-test', baseEnv, storage, {});
      expect((state as unknown as { _r2SseDisabled: boolean })._r2SseDisabled).toBe(false);
    });

    it('applyPrefsOnRestart flips _r2SseDisabled both directions and regenerates env', async () => {
      const state = baseState();
      const s = state as unknown as { _r2SseDisabled: boolean };
      const { storage } = makeStorage();

      const onChanged = await applyPrefsOnRestart(state, storage, { r2SseDisabled: true });
      expect(onChanged).toBe(true);
      expect(s._r2SseDisabled).toBe(true);

      // Turning Governed Mode OFF on a warm DO must reset the stale state.
      const offChanged = await applyPrefsOnRestart(state, storage, { r2SseDisabled: false });
      expect(offChanged).toBe(true);
      expect(s._r2SseDisabled).toBe(false);
    });

    it('applyPrefsOnRestart is a no-op for r2SseDisabled when unchanged', async () => {
      const state = baseState();
      (state as unknown as { _r2SseDisabled: boolean })._r2SseDisabled = true;
      const { storage } = makeStorage();
      const changed = await applyPrefsOnRestart(state, storage, { r2SseDisabled: true });
      expect(changed).toBe(false);
    });
  });
});
