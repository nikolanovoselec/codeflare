/**
 * Prefill hydration appliers, extracted from setup.ts's loadExistingConfig.
 * Each function mutates a Solid `produce()` draft of the setup-wizard state —
 * the store owns WHEN to hydrate (status branching, best-effort fetches);
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
  for (const r of prefill.dynamicRoutes) {
    if (s.routeContextWindows[r] === undefined) s.routeContextWindows[r] = DEFAULT_ROUTE_CONTEXT_WINDOW;
  }
  applyProviderPrefill(s, prefill);
  s.groupRouting = prefill.groupRouting;
}

/**
 * Non-enterprise reconfiguration hydration: users/admins from /api/users,
 * provider config best-effort from the prefill (masked secrets).
 */
export function applyReconfigPrefill(
  s: SetupState,
  users: UsersList,
  reconfigPrefill: SetupPrefill | null,
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
  if (reconfigPrefill) {
    applyProviderPrefill(s, reconfigPrefill);
  }
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
