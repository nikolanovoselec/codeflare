/**
 * Setup-wizard state shape and shared routing types, extracted from setup.ts
 * so the payload builder (setup-payload.ts) and prefill appliers
 * (setup-prefill.ts) can type against the state without importing the store.
 */
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Per-group routing entry (REQ-ENTERPRISE-013). */
export interface GroupRouting {
  routes: string[];
  defaultRoute: string;
  reasoning: ReasoningLevel;
}

export interface SetupState {
  step: number;
  // Token detection (auto-detected from env)
  tokenDetected: boolean;
  tokenDetecting: boolean;
  tokenDetectError: string | null;
  accountInfo: { id: string; name: string } | null;
  // Custom domain (optional)
  customDomain: string;
  customDomainError: string | null;
  // Allowed users
  adminUsers: string[];
  allowedUsers: string[];
  // Configuration progress
  configuring: boolean;
  configureSteps: Array<{ step: string; status: string; error?: string }>;
  configureError: string | null;
  setupComplete: boolean;
  // Result URLs
  customDomainUrl: string | null;
  accountId: string | null;
  // SaaS mode
  saasMode: boolean;
  // Enterprise mode (deploy-time flag, from /api/setup/status)
  enterpriseMode: boolean;
  // Enterprise-only: customer-managed Cloudflare Access group NAMES (chip list)
  enterpriseAccessGroups: string[];
  // REQ-ENTERPRISE-014: enterprise admin Access group NAMES (chip list). Members are
  // granted admin (= Setup access); never used for per-group routing.
  adminAccessGroups: string[];
  // Feature C: enterprise gateway dynamic-route catalog + optional default.
  dynamicRoutes: string[];
  defaultRouteName: string;            // '' = no default
  defaultRouteReasoning: ReasoningLevel;
  // REQ-ENTERPRISE-012: per-route context window (route name -> tokens). Each route
  // defaults to DEFAULT_ROUTE_CONTEXT_WINDOW; the admin can raise or reset it.
  routeContextWindows: Record<string, number>;
  // REQ-BROWSER-007: admin-global Cloudflare Browser Rendering token + account id.
  // cloudflareBrowserToken holds only a freshly-typed value (the stored token is
  // never returned); cloudflareBrowserTokenSet reflects whether one is already saved.
  cloudflareBrowserToken: string;
  cloudflareBrowserTokenSet: boolean;
  cloudflareBrowserAccountId: string;
  // REQ-ENTERPRISE-017: enterprise AI Gateway URL + token (wizard-configured, KV-persisted).
  // aigToken holds only a freshly-typed value (the stored token is never returned);
  // aigTokenSet reflects whether one is already saved; aigGatewayUrl is non-secret.
  aigGatewayUrl: string;
  aigToken: string;
  aigTokenSet: boolean;
  // REQ-ENTERPRISE-016: enterprise-only strict gateway egress toggle. Default OFF;
  // routes the container's HTTP/HTTPS egress through the Cloudflare Gateway.
  strictGatewayEgress: boolean;
  // REQ-ENTERPRISE-018: enterprise-only Governed Mode toggle. Default OFF; disables
  // R2 SSE-C so corporate bucket data is readable/scannable. Flipping it triggers a
  // lossless re-encrypt of each bucket on its next session start.
  r2SseDisabled: boolean;
  // Enterprise-only view-only-storage toggle. Default OFF; blocks file downloads in the
  // Storage panel (open/view only) to prevent bulk export of bucket contents.
  downloadsDisabled: boolean;
  // REQ-ENTERPRISE-025: wizard-governed active coding agents. configurableAgents is
  // the server-delivered governable universe (one checkbox each — a newly capable
  // agent appears without a UI change); activeAgents is the current selection
  // (min 1, enforced in toggleActiveAgent and by the backend schema).
  activeAgents: string[];
  configurableAgents: string[];
  // REQ-GITHUB-008: enterprise GitHub provider config. *ClientSecret holds only a
  // freshly-typed value (the stored secret is never returned); *ClientSecretSet
  // reflects whether one is already saved.
  githubProviderType: 'app' | 'oauth';
  githubAppClientId: string;
  githubAppClientSecret: string;
  githubAppClientSecretSet: boolean;
  githubOauthClientId: string;
  githubOauthClientSecret: string;
  githubOauthClientSecretSet: boolean;
  // Connect-to-Cloudflare OAuth client (admin, non-enterprise). Same masked-secret
  // shape as the GitHub provider fields above.
  cloudflareOauthClientId: string;
  cloudflareOauthClientSecret: string;
  cloudflareOauthClientSecretSet: boolean;
  // REQ-ENTERPRISE-013: per-group routing, keyed by Access group name.
  groupRouting: Record<string, GroupRouting>;
}

// REQ-ENTERPRISE-012 default per-route context window (tokens).
export const DEFAULT_ROUTE_CONTEXT_WINDOW = 256000;
