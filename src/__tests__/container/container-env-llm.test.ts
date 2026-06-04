/**
 * REQ-ENTERPRISE-005: per-session LLM-proxy env injection through the container
 * env pipeline. buildEnvVars must emit ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
 * / COPILOT_PROVIDER_BASE_URL / PI_BASE_URL / ENTERPRISE_MODE ONLY when the
 * corresponding state field is set (enterprise mode), and omit each one entirely
 * when unset (non-enterprise deploys are byte-identical to today).
 *
 * AC (emit): each of the 5 env vars appears with the injected value when the
 *   matching state field is populated.
 * AC (omit / flag-off regression): none of the 5 env vars appear when the state
 *   fields are null - the non-enterprise env is unchanged.
 * AC (apply): applyBucketName + applyPrefsOnRestart thread the fields into state.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEnvVars,
  applyBucketName,
  applyPrefsOnRestart,
  type ContainerEnvState,
} from '../../container/container-env';
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
    _userTimezone: null,
    _anthropicBaseUrl: null,
    _copilotProviderBaseUrl: null,
    _piBaseUrl: null,
    _aigProxyToken: null,
    _enterpriseMode: null,
  };
}

const baseEnv: Env = {} as Env;

/** In-memory storage stub matching the shape applyBucketName/applyPrefsOnRestart need. */
function memStorage() {
  const store = new Map<string, unknown>();
  return {
    put: async (key: string, value: unknown) => { store.set(key, value); },
    store,
  };
}

describe('REQ-ENTERPRISE-005: container LLM-proxy env injection (flag-on emit)', () => {
  it('emits ANTHROPIC_BASE_URL when _anthropicBaseUrl is set', () => {
    const state = baseState();
    state._anthropicBaseUrl = 'https://w.example.com/api/llm/sid/anthropic';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBe('https://w.example.com/api/llm/sid/anthropic');
  });

  it('emits ANTHROPIC_AUTH_TOKEN from _aigProxyToken when set', () => {
    const state = baseState();
    state._aigProxyToken = 'signed.proxy.token';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBe('signed.proxy.token');
  });

  it('emits COPILOT_PROVIDER_BASE_URL when _copilotProviderBaseUrl is set', () => {
    const state = baseState();
    state._copilotProviderBaseUrl = 'https://w.example.com/api/llm/sid/compat';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBe('https://w.example.com/api/llm/sid/compat');
  });

  it('emits PI_BASE_URL when _piBaseUrl is set', () => {
    const state = baseState();
    state._piBaseUrl = 'https://w.example.com/api/llm/sid/compat';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.PI_BASE_URL).toBe('https://w.example.com/api/llm/sid/compat');
  });

  it('emits ENTERPRISE_MODE when _enterpriseMode is set', () => {
    const state = baseState();
    state._enterpriseMode = 'active';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ENTERPRISE_MODE).toBe('active');
  });

  it('emits all five together when all fields are set', () => {
    const state = baseState();
    state._anthropicBaseUrl = 'https://w/a';
    state._aigProxyToken = 'tkn';
    state._copilotProviderBaseUrl = 'https://w/c';
    state._piBaseUrl = 'https://w/p';
    state._enterpriseMode = 'active';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBe('https://w/a');
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBe('tkn');
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBe('https://w/c');
    expect(vars.PI_BASE_URL).toBe('https://w/p');
    expect(vars.ENTERPRISE_MODE).toBe('active');
  });
});

describe('REQ-ENTERPRISE-005: container LLM-proxy env injection (flag-off regression)', () => {
  it('omits all five env vars when the state fields are null', () => {
    const vars = buildEnvVars(baseState(), baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
    expect(vars.PI_BASE_URL).toBeUndefined();
    expect(vars.ENTERPRISE_MODE).toBeUndefined();
  });

  it('omits the env vars when fields are empty strings (defence-in-depth)', () => {
    const state = baseState();
    state._anthropicBaseUrl = '';
    state._aigProxyToken = '';
    state._copilotProviderBaseUrl = '';
    state._piBaseUrl = '';
    state._enterpriseMode = '';
    const vars = buildEnvVars(state, baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
    expect(vars.PI_BASE_URL).toBeUndefined();
    expect(vars.ENTERPRISE_MODE).toBeUndefined();
  });

  it('does not disturb the existing env vars (full regression guard)', () => {
    const vars = buildEnvVars(baseState(), baseEnv);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
    expect(vars.SESSION_MODE).toBe('default');
  });
});

describe('REQ-ENTERPRISE-005: applyBucketName threads LLM-proxy fields into state', () => {
  it('stores the five fields on first setBucketName', async () => {
    const state = baseState();
    const storage = memStorage();
    await applyBucketName(state, 'codeflare-test', baseEnv, storage, {
      anthropicBaseUrl: 'https://w/a',
      copilotProviderBaseUrl: 'https://w/c',
      piBaseUrl: 'https://w/p',
      aigProxyToken: 'tkn',
      enterpriseMode: 'active',
    });
    expect(state._anthropicBaseUrl).toBe('https://w/a');
    expect(state._copilotProviderBaseUrl).toBe('https://w/c');
    expect(state._piBaseUrl).toBe('https://w/p');
    expect(state._aigProxyToken).toBe('tkn');
    expect(state._enterpriseMode).toBe('active');
  });

  it('leaves the fields null when not provided (flag-off)', async () => {
    const state = baseState();
    const storage = memStorage();
    await applyBucketName(state, 'codeflare-test', baseEnv, storage, {});
    expect(state._anthropicBaseUrl).toBeNull();
    expect(state._aigProxyToken).toBeNull();
    expect(state._enterpriseMode).toBeNull();
  });

  it('does NOT persist the fields to storage (in-memory only)', async () => {
    const state = baseState();
    const storage = memStorage();
    await applyBucketName(state, 'codeflare-test', baseEnv, storage, {
      anthropicBaseUrl: 'https://w/a',
      aigProxyToken: 'tkn',
      enterpriseMode: 'active',
    });
    expect(storage.store.has('anthropicBaseUrl')).toBe(false);
    expect(storage.store.has('aigProxyToken')).toBe(false);
    expect(storage.store.has('enterpriseMode')).toBe(false);
  });
});

describe('REQ-ENTERPRISE-005: applyPrefsOnRestart refreshes LLM-proxy fields', () => {
  it('updates the proxy token (re-minted each start) on restart', async () => {
    const state = baseState();
    state._aigProxyToken = 'old.token';
    const storage = memStorage();
    const changed = await applyPrefsOnRestart(state, storage, { aigProxyToken: 'new.token' });
    expect(changed).toBe(true);
    expect(state._aigProxyToken).toBe('new.token');
  });

  it('leaves fields untouched when omitted (flag-off restart)', async () => {
    const state = baseState();
    state._anthropicBaseUrl = 'https://w/a';
    state._enterpriseMode = 'active';
    const storage = memStorage();
    await applyPrefsOnRestart(state, storage, { sessionId: 'sid-2' });
    expect(state._anthropicBaseUrl).toBe('https://w/a');
    expect(state._enterpriseMode).toBe('active');
  });
});
