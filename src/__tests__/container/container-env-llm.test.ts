/**
 * REQ-ENTERPRISE-005 (revised): enterprise-mode container env injection.
 *
 * With the outbound-interception transport the container needs the ENTERPRISE_MODE
 * flag PLUS the dynamic-route NAMES + default reasoning grade (revised invariant):
 * the route catalog (Pi models.json lists all), the default route (Copilot
 * COPILOT_MODEL + Pi defaultModel), and its reasoning grade (Pi
 * defaultThinkingLevel). The interceptor maps each slash-free handle to
 * dynamic/<route> on egress, so NO gateway URL / token / credential ever enters
 * the container — buildEnvVars still must NOT fan those (or COPILOT_MODEL /
 * PI_MODEL, which entrypoint.sh sets from the fanned default route, not buildEnvVars).
 *
 * ENTERPRISE_MODE gates the entrypoint.sh block that trusts the Cloudflare
 * containers CA and points each agent at the constant provider base-URLs; the
 * actual LLM routing is the DO's outbound-HTTPS interception.
 *
 * AC (emit): ENTERPRISE_MODE='active' appears iff env.ENTERPRISE_MODE==='active';
 *   ENTERPRISE_ROUTE_CATALOG / ENTERPRISE_DEFAULT_ROUTE / ENTERPRISE_DEFAULT_REASONING
 *   appear iff enterprise AND the corresponding state field is present.
 * AC (omit / flag-off regression): ENTERPRISE_MODE, the route vars, and any
 *   gateway/base-URL var are absent on a non-enterprise deploy (byte-identical to
 *   today). COPILOT_MODEL and PI_MODEL are NEVER emitted by buildEnvVars in ANY
 *   mode (entrypoint-fixed), even with a default route configured.
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
    _userGroups: [],
    _routeCatalog: [],
    _defaultRoute: null,
    _defaultReasoning: null,
    _userTimezone: null,
    // Cast covers ContainerEnvState fields this enterprise-LLM fixture does not
    // exercise (e.g. _gitCloneRepo/_gitCloneRef), matching the sibling fixtures
    // so a new state field doesn't rebreak this file's typecheck.
  } as unknown as ContainerEnvState;
}

describe('REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)', () => {
  it('emits ENTERPRISE_MODE=active when the Worker deploy var is active', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.ENTERPRISE_MODE).toBe('active');
  });

  it('never injects a gateway URL, token, or per-agent base-URL into the container', () => {
    // The whole point of interception: no credential or URL reaches the container.
    // These must NEVER appear regardless of enterprise mode.
    const vars = buildEnvVars(baseState(), {
      ENTERPRISE_MODE: 'active',
      AIG_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw',
      AIG_TOKEN: 'secret',
    } as Env);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(vars.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
    expect(vars.PI_BASE_URL).toBeUndefined();
    expect(vars.AIG_GATEWAY_URL).toBeUndefined();
    expect(vars.AIG_TOKEN).toBeUndefined();
  });

  it('does NOT fan COPILOT_MODEL / PI_MODEL even with a default route configured', () => {
    // The route HANDLE is set in entrypoint.sh (from the fanned default route),
    // never by buildEnvVars — assert key-absence, not just an undefined value.
    const state = { ...baseState(), _routeCatalog: ['development'], _defaultRoute: 'development', _defaultReasoning: 'off' };
    const vars = buildEnvVars(state, { ENTERPRISE_MODE: 'active' } as Env);
    expect('COPILOT_MODEL' in vars).toBe(false);
    expect('PI_MODEL' in vars).toBe(false);
  });

  it('fans the route catalog + default route + reasoning grade when enterprise + present', () => {
    // Revised REQ-ENTERPRISE-005: the route NAMES + reasoning grade ARE fanned so
    // entrypoint.sh can build Pi models.json / settings.json + Copilot COPILOT_MODEL.
    const state = { ...baseState(), _routeCatalog: ['development', 'production'], _defaultRoute: 'development', _defaultReasoning: 'medium' };
    const vars = buildEnvVars(state, { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.ENTERPRISE_ROUTE_CATALOG).toBe(JSON.stringify(['development', 'production']));
    expect(vars.ENTERPRISE_DEFAULT_ROUTE).toBe('development');
    expect(vars.ENTERPRISE_DEFAULT_REASONING).toBe('medium');
  });

  it('omits the route vars when enterprise but the route config is unset (empty catalog)', () => {
    const vars = buildEnvVars(baseState(), { ENTERPRISE_MODE: 'active' } as Env);
    expect('ENTERPRISE_ROUTE_CATALOG' in vars).toBe(false);
    expect('ENTERPRISE_DEFAULT_ROUTE' in vars).toBe(false);
    expect('ENTERPRISE_DEFAULT_REASONING' in vars).toBe(false);
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

  it('omits COPILOT_MODEL / PI_MODEL + the route vars on a non-enterprise deploy even with route state set', () => {
    // Flag-off: even if the DO state carried a route catalog, the flag-off gate
    // suppresses every enterprise var so the env is byte-identical to today.
    const state = { ...baseState(), _routeCatalog: ['development'], _defaultRoute: 'development', _defaultReasoning: 'off' };
    const vars = buildEnvVars(state, {} as Env);
    expect('COPILOT_MODEL' in vars).toBe(false);
    expect('PI_MODEL' in vars).toBe(false);
    expect('ENTERPRISE_ROUTE_CATALOG' in vars).toBe(false);
    expect('ENTERPRISE_DEFAULT_ROUTE' in vars).toBe(false);
    expect('ENTERPRISE_DEFAULT_REASONING' in vars).toBe(false);
  });

  it('does not disturb the existing env vars (full regression guard)', () => {
    const vars = buildEnvVars(baseState(), {} as Env);
    expect(vars.R2_BUCKET_NAME).toBe('codeflare-test');
    expect(vars.CONTAINER_AUTH_TOKEN).toBe('tok');
    expect(vars.SESSION_ID).toBe('sid-abcdef12');
    expect(vars.SESSION_MODE).toBe('default');
  });
});
