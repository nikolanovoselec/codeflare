import { describe, expect, it } from 'vitest';
import { SetupPrefillResponseSchema } from '../../lib/schemas';
import { applyInitialPrefill } from '../../stores/setup-prefill';
import type { SetupState } from '../../stores/setup-types';
import { setupStore } from '../../stores/setup';

function state(): SetupState {
  return {
    step: 1,
    tokenDetected: false,
    tokenDetecting: false,
    tokenDetectError: null,
    accountInfo: null,
    customDomain: '',
    customDomainError: null,
    adminUsers: [],
    allowedUsers: [],
    configuring: false,
    configureSteps: [],
    configureError: null,
    setupComplete: false,
    customDomainUrl: null,
    accountId: null,
    saasMode: false,
    enterpriseMode: false,
    enterpriseAccessGroups: [],
    adminAccessGroups: [],
    dynamicRoutes: [],
    defaultRouteName: '',
    defaultRouteReasoning: 'off',
    routeContextWindows: {},
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
    configurableAgents: [],
    githubProviderType: 'app',
    githubAppClientId: '',
    githubAppClientSecret: '',
    githubAppClientSecretSet: false,
    githubOauthClientId: '',
    githubOauthClientSecret: '',
    githubOauthClientSecretSet: false,
    cloudflareOauthClientId: '',
    cloudflareOauthClientSecret: '',
    cloudflareOauthClientSecretSet: false,
    managedEnvironmentEnabled: false,
    managedEnvironmentConfigured: false,
    managedEnvironmentTouched: false,
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
  };
}

describe('managed-environment setup prefill', () => {
  it('routes administrator edits through the managed-environment store boundary', () => {
    setupStore.setManagedEnvironmentEnabled(true);
    setupStore.setManagedEnvironmentRepository('acme/curation');
    setupStore.setManagedEnvironmentPersonalAccessToken('github_pat_replacement');
    setupStore.setManagedEnvironmentPublicKey('ab'.repeat(32));

    expect(setupStore.managedEnvironmentEnabled).toBe(true);
    expect(setupStore.managedEnvironmentTouched).toBe(true);
    expect(setupStore.managedEnvironmentRepository).toBe('acme/curation');
    expect(setupStore.managedEnvironmentPersonalAccessToken).toBe('github_pat_replacement');
    expect(setupStore.managedEnvironmentPublicKey).toBe('ab'.repeat(32));

    setupStore.setManagedEnvironmentEnabled(false);
    setupStore.setManagedEnvironmentRepository('');
    setupStore.setManagedEnvironmentPersonalAccessToken('');
    setupStore.setManagedEnvironmentPublicKey('');
  });

  it('REQ-SETUP-013 AC2: hydrates masked status without inventing a PAT value', () => {
    const target = state();
    const prefill = SetupPrefillResponseSchema.parse({
      adminUsers: [],
      allowedUsers: [],
      managedEnvironment: {
        enabled: true,
        configured: true,
        repository: 'acme/curation',
        personalAccessTokenSet: true,
        publicKeyFingerprint: '0123456789abcdef',
        activeReleaseTag: 'release-7',
        activeSequence: 7,
        activeDigestPrefix: '123456789abc',
        freshness: 'fresh',
        lastCheckedAt: '2026-08-18T00:00:00.000Z',
        patExpiryState: 'valid',
      },
    });
    applyInitialPrefill(target, prefill);

    expect(target.managedEnvironmentEnabled).toBe(true);
    expect(target.managedEnvironmentConfigured).toBe(true);
    expect(target.managedEnvironmentTouched).toBe(false);
    expect(target.managedEnvironmentRepository).toBe('acme/curation');
    expect(target.managedEnvironmentPersonalAccessTokenSet).toBe(true);
    expect(target.managedEnvironmentPersonalAccessToken).toBe('');
    expect(target.managedEnvironmentActiveSequence).toBe(7);
    expect(target.managedEnvironmentFreshness).toBe('fresh');
  });
});
