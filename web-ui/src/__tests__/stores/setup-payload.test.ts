/**
 * Contract tests for the setup configure payload builder (extracted from the
 * setup store): enterprise key gating, the default-route fallback shape, the
 * min-1 activeAgents omission, and admin/allowed user merging. These are the
 * request-body invariants the backend schema validates against.
 */
import { describe, it, expect } from 'vitest';
import { buildConfigurePayload } from '../../stores/setup-payload';
import type { SetupState } from '../../stores/setup-types';

function baseState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    step: 3,
    tokenDetected: true,
    tokenDetecting: false,
    tokenDetectError: null,
    accountInfo: null,
    customDomain: 'code.example.com',
    customDomainError: null,
    adminUsers: ['admin@example.com'],
    allowedUsers: ['user@example.com'],
    configuring: false,
    configureSteps: [],
    configureError: null,
    setupComplete: false,
    customDomainUrl: null,
    accountId: null,
    saasMode: false,
    enterpriseMode: false,
    enterpriseAccessGroups: ['eng'],
    adminAccessGroups: ['admins'],
    dynamicRoutes: ['route-a', 'route-b'],
    defaultRouteName: '',
    defaultRouteReasoning: 'high',
    routeContextWindows: { 'route-a': 128000 },
    cloudflareBrowserToken: '',
    cloudflareBrowserTokenSet: false,
    cloudflareBrowserAccountId: '',
    aigGatewayUrl: '',
    aigToken: '',
    aigTokenSet: false,
    strictGatewayEgress: false,
    r2SseDisabled: false,
    downloadsDisabled: false,
    activeAgents: [],
    configurableAgents: ['copilot', 'pi'],
    githubProviderType: 'app',
    githubAppClientId: 'app-id',
    githubAppClientSecret: '',
    githubAppClientSecretSet: true,
    githubOauthClientId: '',
    githubOauthClientSecret: '',
    githubOauthClientSecretSet: false,
    cloudflareOauthClientId: '',
    cloudflareOauthClientSecret: '',
    cloudflareOauthClientSecretSet: false,
    managedEnvironmentEnabled: false,
    managedEnvironmentConfigured: false,
    managedEnvironmentTouched: false,
    managedEnvironmentImmutableResources: false,
    managedEnvironmentDisableUserCreatedResources: false,
    managedEnvironmentRepository: '',
    managedEnvironmentPersonalAccessToken: '',
    managedEnvironmentPersonalAccessTokenSet: false,
    managedEnvironmentPublicKey: '',
    managedEnvironmentPublicKeyFingerprint: '',
    managedEnvironmentActiveReleaseTag: '',
    managedEnvironmentActiveSequence: null,
    managedEnvironmentActiveDigestPrefix: '',
    managedEnvironmentFreshness: 'unconfigured',
    managedEnvironmentLastCheckedAt: '',
    managedEnvironmentPatExpiryState: 'unknown',
    managedEnvironmentLastError: '',
    groupRouting: {},
    ...overrides,
  };
}

describe('buildConfigurePayload (setup store split)', () => {
  it('merges admins into allowedUsers and carries the provider fields in every mode', () => {
    const payload = buildConfigurePayload(baseState());
    expect(payload.allowedUsers).toEqual(['admin@example.com', 'user@example.com']);
    expect(payload.adminUsers).toEqual(['admin@example.com']);
    expect(payload.githubProviderType).toBe('app');
    // Blank secret passes through verbatim — the backend treats '' as "keep existing".
    expect(payload.githubAppClientSecret).toBe('');
  });

  it('carries the same managed-environment contract outside and inside enterprise mode', () => {
    const managed = {
      managedEnvironmentEnabled: true,
      managedEnvironmentTouched: true,
      managedEnvironmentRepository: 'acme/curation',
      managedEnvironmentImmutableResources: true,
      managedEnvironmentDisableUserCreatedResources: true,
      managedEnvironmentPersonalAccessToken: '',
      managedEnvironmentPersonalAccessTokenSet: true,
      managedEnvironmentPublicKey: 'ab'.repeat(32),
    };
    const standard = buildConfigurePayload(baseState({ enterpriseMode: false, ...managed }));
    const enterprise = buildConfigurePayload(baseState({ enterpriseMode: true, ...managed }));
    const expected = {
      enabled: true,
      repository: 'acme/curation',
      personalAccessToken: '',
      publicKey: 'ab'.repeat(32),
      immutableResources: true,
      disableUserCreatedResources: true,
    };
    expect(standard.managedEnvironment).toEqual(expected);
    expect(enterprise.managedEnvironment).toEqual(expected);
  });

  it('sends an explicit disable only for a configured or touched control', () => {
    expect(buildConfigurePayload(baseState())).not.toHaveProperty('managedEnvironment');
    expect(buildConfigurePayload(baseState({
      managedEnvironmentConfigured: true,
      managedEnvironmentTouched: true,
    })).managedEnvironment).toEqual({ enabled: false });
  });

  it('omits every enterprise-only key outside enterprise mode (byte-identical body guarantee)', () => {
    const payload = buildConfigurePayload(baseState({ enterpriseMode: false }));
    for (const key of ['enterpriseAccessGroup', 'adminAccessGroup', 'dynamicRoutes', 'defaultRoute',
      'routeContextWindows', 'browserRenderToken', 'aigGatewayUrl', 'groupRouting',
      'strictGatewayEgress', 'r2SseDisabled', 'downloadsDisabled', 'activeAgents']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('falls back to the first dynamic route (reasoning off) when no default route is named', () => {
    const payload = buildConfigurePayload(baseState({ enterpriseMode: true }));
    expect(payload.defaultRoute).toEqual({ route: 'route-a', reasoning: 'off' });
  });

  it('uses the named default route with its configured reasoning', () => {
    const payload = buildConfigurePayload(baseState({ enterpriseMode: true, defaultRouteName: 'route-b' }));
    expect(payload.defaultRoute).toEqual({ route: 'route-b', reasoning: 'high' });
  });

  it('omits activeAgents while the prefill has not delivered a selection (min-1 backend rule)', () => {
    const empty = buildConfigurePayload(baseState({ enterpriseMode: true, activeAgents: [] }));
    expect(empty).not.toHaveProperty('activeAgents');

    const selected = buildConfigurePayload(baseState({ enterpriseMode: true, activeAgents: ['copilot'] }));
    expect(selected.activeAgents).toEqual(['copilot']);
  });
});
