/**
 * REQ-ENTERPRISE-005: enterprise-mode container env injection.
 *
 * With the outbound-interception transport, the container needs only the
 * ENTERPRISE_MODE flag plus, optionally, the agent model ids COPILOT_MODEL /
 * PI_MODEL — both fanned out from the single operator var AIG_LANGUAGE_MODEL (the
 * gateway model/route every agent should send, e.g. `dynamic/<route>` — AD74).
 * buildEnvVars derives them straight from Worker deploy vars (isEnterpriseMode(env)
 * + env.AIG_LANGUAGE_MODEL) — no per-session base-URL/token injection.
 * ENTERPRISE_MODE gates the entrypoint.sh block that trusts the Cloudflare
 * containers CA and points each agent at the constant provider base-URLs; the
 * actual LLM routing is done by the DO's outbound-HTTPS interception, which keeps
 * every credential, gateway URL, and token OUT of the container. The model id is a
 * non-secret routing hint, not a credential.
 *
 * AC (emit): ENTERPRISE_MODE='active' appears when env.ENTERPRISE_MODE==='active';
 *   COPILOT_MODEL and PI_MODEL both appear (= AIG_LANGUAGE_MODEL) when enterprise
 *   AND AIG_LANGUAGE_MODEL is set.
 * AC (omit / flag-off regression): ENTERPRISE_MODE, COPILOT_MODEL, PI_MODEL, and
 *   any proxy/base-URL var are all absent on a non-enterprise or non-"active"
 *   deploy (byte-identical to today), even if AIG_LANGUAGE_MODEL is set.
 */
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
    _userTimezone: null,
  };
}

describe('REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)', () => {
  it('emits ENTERPRISE_MODE=active when the Worker deploy var is active', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.ENTERPRISE_MODE).toBe('active');
  });

  it('never injects a gateway URL, token, or per-agent base-URL into the container', () => {
    // The whole point of interception: no credential or URL reaches the
    // container. These must NEVER appear regardless of enterprise mode.
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
    expect(vars.PI_BASE_URL).toBeUndefined();
    expect(vars.AIG_GATEWAY_URL).toBeUndefined();
    expect(vars.AIG_TOKEN).toBeUndefined();
  });

  it('fans AIG_LANGUAGE_MODEL out to both COPILOT_MODEL and PI_MODEL when enterprise and the deploy var is set', () => {
    const vars = buildEnvVars(baseState(), {
      ENTERPRISE_MODE: 'active',
      AIG_LANGUAGE_MODEL: 'dynamic/codeflare-enterprise',
    } as Env);
    expect(vars.COPILOT_MODEL).toBe('dynamic/codeflare-enterprise');
    expect(vars.PI_MODEL).toBe('dynamic/codeflare-enterprise');
  });

  it('omits COPILOT_MODEL / PI_MODEL when enterprise but AIG_LANGUAGE_MODEL is unset', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    // Assert key-absence, not just undefined-value: a present `COPILOT_MODEL:
    // undefined` key (what dropping the `env.AIG_LANGUAGE_MODEL &&` guard would
    // emit) must also fail this test.
    expect('COPILOT_MODEL' in vars).toBe(false);
    expect('PI_MODEL' in vars).toBe(false);
  });
});

describe('REQ-ENTERPRISE-005: enterprise env injection (flag-off regression)', () => {
  it('omits ENTERPRISE_MODE when the deploy var is unset (non-enterprise)', () => {
    const vars = buildEnvVars(baseState(), {} as Env);
    expect(vars.ENTERPRISE_MODE).toBeUndefined();
  });

  it('omits ENTERPRISE_MODE when the deploy var is any non-"active" value', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'inactive' } as Env);
    expect(vars.ENTERPRISE_MODE).toBeUndefined();
  });

  it('omits COPILOT_MODEL / PI_MODEL on a non-enterprise deploy even if AIG_LANGUAGE_MODEL is set', () => {
    const vars = buildEnvVars(baseState(), {
      AIG_LANGUAGE_MODEL: 'dynamic/codeflare-enterprise',
    } as Env);
    expect(vars.COPILOT_MODEL).toBeUndefined();
    expect(vars.PI_MODEL).toBeUndefined();
  });

  it('does not disturb the existing env vars (full regression guard)', () => {
    const vars = buildEnvVars(baseState(), {} as Env);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
    expect(vars.SESSION_MODE).toBe('default');
  });
});
