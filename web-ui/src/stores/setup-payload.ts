/**
 * Pure mapping from the setup-wizard state to the POST /api/setup/configure
 * request body, extracted from setup.ts so the payload contract (enterprise
 * key gating, blank-secret no-clobber pass-through, default-route fallback,
 * min-1 activeAgents omission) is unit-testable without a fetch.
 */
import type { SetupState } from './setup-types';

export function buildConfigurePayload(state: SetupState): Record<string, unknown> {
  const allUsers = [...state.adminUsers, ...state.allowedUsers];
  return {
    customDomain: state.customDomain,
    allowedUsers: allUsers,
    adminUsers: state.adminUsers,
    // REQ-GITHUB-008: provider config (admin, any mode). GitHub provider type +
    // client ids; a blank secret => backend keeps the existing one (no clobber).
    // The Connect-to-Cloudflare OAuth client mirrors the same shape.
    githubProviderType: state.githubProviderType,
    githubAppClientId: state.githubAppClientId,
    githubAppClientSecret: state.githubAppClientSecret,
    githubOauthClientId: state.githubOauthClientId,
    githubOauthClientSecret: state.githubOauthClientSecret,
    cloudflareOauthClientId: state.cloudflareOauthClientId,
    cloudflareOauthClientSecret: state.cloudflareOauthClientSecret,
    // Deployment-level managed environment uses the same request shape in
    // every mode. Once loaded or touched, disabled is explicit; an unavailable
    // best-effort prefill is omitted so it cannot accidentally disable curation.
    ...((state.managedEnvironmentConfigured || state.managedEnvironmentTouched) ? {
      managedEnvironment: state.managedEnvironmentEnabled ? {
        enabled: true,
        repository: state.managedEnvironmentRepository,
        personalAccessToken: state.managedEnvironmentPersonalAccessToken,
        publicKey: state.managedEnvironmentPublicKey,
        immutableResources: state.managedEnvironmentImmutableResources,
        disableUserCreatedResources: state.managedEnvironmentDisableUserCreatedResources,
      } : { enabled: false },
    } : {}),
    // Enterprise-only fields; omitted entirely for other modes so their
    // request body is byte-identical to today.
    ...(state.enterpriseMode ? {
      enterpriseAccessGroup: state.enterpriseAccessGroups,
      // REQ-ENTERPRISE-014: admin Access groups (Setup access; not routing).
      adminAccessGroup: state.adminAccessGroups,
      dynamicRoutes: state.dynamicRoutes,
      defaultRoute: state.defaultRouteName || state.dynamicRoutes[0]
        ? { route: state.defaultRouteName || state.dynamicRoutes[0], reasoning: state.defaultRouteName ? state.defaultRouteReasoning : 'off' }
        : null,
      // REQ-ENTERPRISE-012: per-route context windows (route name -> tokens).
      routeContextWindows: state.routeContextWindows,
      // REQ-BROWSER-007: a blank token => backend keeps the existing one (no clobber).
      browserRenderToken: state.cloudflareBrowserToken,
      browserRenderAccountId: state.cloudflareBrowserAccountId,
      // REQ-ENTERPRISE-017: AI Gateway URL (non-secret) + token (blank => no clobber).
      aigGatewayUrl: state.aigGatewayUrl,
      aigToken: state.aigToken,
      // REQ-ENTERPRISE-013: per-group routing map.
      groupRouting: state.groupRouting,
      // REQ-ENTERPRISE-016: strict gateway egress toggle.
      strictGatewayEgress: state.strictGatewayEgress,
      // REQ-ENTERPRISE-018: Governed Mode (R2 SSE-C disable) toggle.
      r2SseDisabled: state.r2SseDisabled,
      // View-only-storage toggle.
      downloadsDisabled: state.downloadsDisabled,
      // REQ-ENTERPRISE-025: active coding agents. Omitted while the prefill has
      // not delivered a selection so an unrelated reconfigure cannot 400 on the
      // backend's min-1 rule.
      ...(state.activeAgents.length > 0 ? { activeAgents: state.activeAgents } : {}),
    } : {}),
  };
}
