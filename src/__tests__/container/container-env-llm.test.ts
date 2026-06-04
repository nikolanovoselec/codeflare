/**
 * REQ-ENTERPRISE-005: enterprise-mode container env injection.
 *
 * With the outbound-interception transport, the container needs exactly ONE
 * enterprise env var: ENTERPRISE_MODE. buildEnvVars derives it straight from the
 * Worker deploy var (isEnterpriseMode(env)) - no per-session base-URL/token
 * injection. The var gates the entrypoint.sh block that trusts the Cloudflare
 * containers CA and points each agent at the constant provider base-URLs; the
 * actual LLM routing is done by the DO's outbound-HTTPS interception, which
 * keeps every credential, gateway URL, and token OUT of the container.
 *
 * AC (emit): ENTERPRISE_MODE='active' appears when env.ENTERPRISE_MODE==='active'.
 * AC (omit / flag-off regression): ENTERPRISE_MODE absent + no proxy/base-URL
 *   vars ever appear, on a non-enterprise or non-"active" deploy (byte-identical
 *   to today).
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

  it('does not disturb the existing env vars (full regression guard)', () => {
    const vars = buildEnvVars(baseState(), {} as Env);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
    expect(vars.SESSION_MODE).toBe('default');
  });
});
