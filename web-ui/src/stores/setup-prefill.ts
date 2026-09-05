/**
 * Prefill hydration appliers, extracted from setup.ts's loadExistingConfig.
 * Each function mutates a Solid `produce()` draft of the setup-wizard state —
 * the store owns WHEN to hydrate (status branching and request success);
 * these own WHAT maps from the backend payloads into the state.
 */
import type { SetupState } from './setup-types';
import { DEFAULT_ROUTE_CONTEXT_WINDOW } from './setup-types';
import type * as api from '../api/client';

export type SetupPrefill = Awaited<ReturnType<typeof api.getSetupPrefill>>;
export type UsersList = Awaited<ReturnType<typeof api.getUsers>>['users'];

/** Provider (GitHub + Connect-to-Cloudflare OAuth) config, shared by every hydration path. */
function applyProviderPrefill(s: SetupState, prefill: SetupPrefill): void {
  s.githubProviderType = prefill.githubProviderType ?? 'app';
  s.githubAppClientId = prefill.githubAppClientId;
  s.githubAppClientSecretSet = prefill.githubAppClientSecretSet;
  s.githubOauthClientId = prefill.githubOauthClientId;
  s.githubOauthClientSecretSet = prefill.githubOauthClientSecretSet;
  s.cloudflareOauthClientId = prefill.cloudflareOauthClientId;
  s.cloudflareOauthClientSecretSet = prefill.cloudflareOauthClientSecretSet;

  const managed = prefill.managedEnvironment;
  s.managedEnvironmentEnabled = managed.enabled;
  s.managedEnvironmentConfigured = managed.configured;
  s.managedEnvironmentTouched = false;
  s.managedEnvironmentImmutableResources = managed.immutableResources;
  s.managedEnvironmentDisableUserCreatedResources = managed.disableUserCreatedResources;
  s.managedEnvironmentRepository = managed.repository;
  s.managedEnvironmentPersonalAccessToken = '';
  s.managedEnvironmentPersonalAccessTokenSet = managed.personalAccessTokenSet;
  // The signing key is also write-only on prefill; its fingerprint tells the
  // administrator what remains selected while blank preserves it on save.
  s.managedEnvironmentPublicKey = '';
  s.managedEnvironmentPublicKeyFingerprint = managed.publicKeyFingerprint;
  s.managedEnvironmentActiveReleaseTag = managed.activeReleaseTag ?? '';
  s.managedEnvironmentActiveSequence = managed.activeSequence ?? null;
  s.managedEnvironmentActiveDigestPrefix = managed.activeDigestPrefix ?? '';
  s.managedEnvironmentFreshness = managed.freshness;
  s.managedEnvironmentLastCheckedAt = managed.lastCheckedAt ?? '';
  s.managedEnvironmentPatExpiryState = managed.patExpiryState;
  s.managedEnvironmentLastError = managed.lastError ?? '';
}

/** Enterprise + gateway config shared by the enterprise-reconfig and initial paths. */
function applyEnterpriseConfigPrefill(s: SetupState, prefill: SetupPrefill): void {
  s.enterpriseAccessGroups = prefill.enterpriseAccessGroup;
  s.adminAccessGroups = prefill.adminAccessGroup;
  s.dynamicRoutes = prefill.dynamicRoutes;
  s.defaultRouteName = prefill.defaultRoute?.route ?? prefill.dynamicRoutes[0] ?? '';
  s.defaultRouteReasoning = prefill.defaultRoute?.reasoning ?? 'off';
  s.cloudflareBrowserTokenSet = prefill.browserRenderTokenSet;
  s.cloudflareBrowserAccountId = prefill.browserRenderAccountId;
  s.aigGatewayUrl = prefill.aigGatewayUrl;
  s.aigTokenSet = prefill.aigTokenSet;
  s.strictGatewayEgress = prefill.strictGatewayEgress;
  s.r2SseDisabled = prefill.r2SseDisabled;
  s.downloadsDisabled = prefill.downloadsDisabled;
  // REQ-ENTERPRISE-025: active coding agents + the governable universe.
  s.activeAgents = prefill.activeAgents;
  s.configurableAgents = prefill.configurableAgents;
}

/**
 * Enterprise reconfiguration hydration (REQ-ENTERPRISE-009): admins and the
 * Access groups come from the setup prefill because GET /api/users returns
 * 403 in enterprise mode.
 */
export function applyEnterprisePrefill(s: SetupState, prefill: SetupPrefill, customDomain: string | undefined): void {
  if (customDomain) {
    s.customDomain = customDomain;
  }
  s.adminUsers = Array.from(new Set(prefill.adminUsers.map((email) => email.trim().toLowerCase())));
  applyEnterpriseConfigPrefill(s, prefill);
  // REQ-ENTERPRISE-012: hydrate per-route windows, then fill the default for
  // any catalog route the stored map doesn't cover so every field shows a value.
  s.routeContextWindows = { ...prefill.routeContextWindows };
  s.routeReasoningProfiles = { ...prefill.routeReasoningProfiles };
  for (const r of prefill.dynamicRoutes) {
    if (s.routeContextWindows[r] === undefined) s.routeContextWindows[r] = DEFAULT_ROUTE_CONTEXT_WINDOW;
    if (s.routeReasoningProfiles[r] === undefined) s.routeReasoningProfiles[r] = '';
  }
  applyProviderPrefill(s, prefill);
  s.groupRouting = prefill.groupRouting;
}

/** Non-enterprise reconfiguration hydration from users and masked prefill responses. */
export function applyReconfigPrefill(
  s: SetupState,
  users: UsersList,
  reconfigPrefill: SetupPrefill,
  customDomain: string | undefined,
  saasMode: boolean | undefined,
): void {
  if (customDomain) {
    s.customDomain = customDomain;
  }
  s.adminUsers = users
    .filter((u) => u.role === 'admin')
    .map((u) => u.email);
  if (!saasMode) {
    s.allowedUsers = users
      .filter((u) => u.role !== 'admin')
      .map((u) => u.email);
  }
  applyProviderPrefill(s, reconfigPrefill);
}

/** Initial (non-configured, non-SaaS) hydration from the deploy-time prefill. */
export function applyInitialPrefill(s: SetupState, prefill: SetupPrefill): void {
  if (prefill.customDomain) {
    s.customDomain = prefill.customDomain;
  }
  const admins = Array.from(new Set(prefill.adminUsers.map((email) => email.trim().toLowerCase())));
  const regularUsers = Array.from(new Set(prefill.allowedUsers.map((email) => email.trim().toLowerCase())))
    .filter((email) => !admins.includes(email));
  s.adminUsers = admins;
  s.allowedUsers = regularUsers;
  applyEnterpriseConfigPrefill(s, prefill);
  applyProviderPrefill(s, prefill);
}
