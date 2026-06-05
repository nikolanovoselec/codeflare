/**
 * REQ-ENTERPRISE-005: enterprise-mode container env injection.
 *
 * With the outbound-interception transport the container needs ONLY the
 * ENTERPRISE_MODE flag. The gateway route id (AIG_LANGUAGE_MODEL) is a Worker /
 * gateway concern: the LlmInterceptor rewrites the wire `model` to it on egress
 * (see llm-interceptor.ts), and the agents are configured with a fixed,
 * slash-free handle (`codeflare`) in entrypoint.sh — so the route name, like
 * every other gateway concern (URL, token), never enters the container.
 * buildEnvVars therefore must NOT fan AIG_LANGUAGE_MODEL (or any gateway URL /
 * token / base-URL) into the container.
 *
 * ENTERPRISE_MODE gates the entrypoint.sh block that trusts the Cloudflare
 * containers CA and points each agent at the constant provider base-URLs; the
 * actual LLM routing is the DO's outbound-HTTPS interception.
 *
 * AC (emit): ENTERPRISE_MODE='active' appears iff env.ENTERPRISE_MODE==='active'.
 * AC (omit / flag-off regression): ENTERPRISE_MODE and any gateway/base-URL var
 *   are absent on a non-enterprise deploy (byte-identical to today). COPILOT_MODEL
 *   and PI_MODEL are NEVER emitted by buildEnvVars in ANY mode (entrypoint-fixed),
 *   even when AIG_LANGUAGE_MODEL is set.
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

  it('never injects a gateway URL, token, route id, or per-agent base-URL into the container', () => {
    // The whole point of interception: no credential, URL, or route reaches the
    // container. These must NEVER appear regardless of enterprise mode — even
    // when AIG_LANGUAGE_MODEL is configured on the Worker.
    const vars = buildEnvVars(baseState(), {
      ENTERPRISE_MODE: 'active',
      AIG_LANGUAGE_MODEL: 'dynamic/codeflare-enterprise',
    } as Env);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
    expect(vars.PI_BASE_URL).toBeUndefined();
    expect(vars.AIG_GATEWAY_URL).toBeUndefined();
    expect(vars.AIG_TOKEN).toBeUndefined();
  });

  it('does NOT fan AIG_LANGUAGE_MODEL into the container as COPILOT_MODEL / PI_MODEL', () => {
    // The route id is Worker-only (the LlmInterceptor stamps it on egress).
    // Agents get a fixed handle from entrypoint.sh, so buildEnvVars must not emit
    // these keys at all — assert key-absence, not just an undefined value.
    const vars = buildEnvVars(baseState(), {
      ENTERPRISE_MODE: 'active',
      AIG_LANGUAGE_MODEL: 'dynamic/codeflare-enterprise',
    } as Env);
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
    expect('COPILOT_MODEL' in vars).toBe(false);
    expect('PI_MODEL' in vars).toBe(false);
  });

  it('does not disturb the existing env vars (full regression guard)', () => {
    const vars = buildEnvVars(baseState(), {} as Env);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
    expect(vars.SESSION_MODE).toBe('default');
  });
});
