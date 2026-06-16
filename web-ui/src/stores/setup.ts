import { createStore, produce } from 'solid-js/store';
import { batch } from 'solid-js';
import * as api from '../api/client';

/** Whether loadExistingConfig has already been called (prevents duplicate fetches). */
let configLoaded = false;

const TOTAL_STEPS = 3;

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

/** Per-group routing entry (REQ-ENTERPRISE-013). */
export interface GroupRouting {
  routes: string[];
  defaultRoute: string;
  reasoning: ReasoningLevel;
}

interface SetupState {
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
  defaultRouteReasoning: 'off' | 'low' | 'medium' | 'high';
  // REQ-BROWSER-007: admin-global Cloudflare Browser Rendering token + account id.
  // cloudflareBrowserToken holds only a freshly-typed value (the stored token is
  // never returned); cloudflareBrowserTokenSet reflects whether one is already saved.
  cloudflareBrowserToken: string;
  cloudflareBrowserTokenSet: boolean;
  cloudflareBrowserAccountId: string;
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
  // REQ-ENTERPRISE-013: per-group routing, keyed by Access group name.
  groupRouting: Record<string, GroupRouting>;
}

const initialState: SetupState = {
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
  cloudflareBrowserToken: '',
  cloudflareBrowserTokenSet: false,
  cloudflareBrowserAccountId: '',
  githubProviderType: 'app',
  githubAppClientId: '',
  githubAppClientSecret: '',
  githubAppClientSecretSet: false,
  githubOauthClientId: '',
  githubOauthClientSecret: '',
  githubOauthClientSecretSet: false,
  groupRouting: {},
};

const [state, setState] = createStore<SetupState>({ ...initialState });

async function detectToken(): Promise<void> {
  batch(() => {
    setState('tokenDetecting', true);
    setState('tokenDetectError', null);
  });
  try {
    const data = await api.detectToken();
    batch(() => {
      if (data.detected && data.valid) {
        setState('tokenDetected', true);
        setState('accountInfo', data.account ?? null);
      } else {
        setState('tokenDetectError', data.error || 'Token not detected');
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to detect token';
    setState('tokenDetectError', msg);
  } finally {
    setState('tokenDetecting', false);
  }
}

/** Add a user as admin. If already in allowedUsers, promotes to admin. */
function addAdminUser(email: string): void {
  if (email && !state.adminUsers.includes(email)) {
    setState(
      produce((s) => {
        // If already in regular users list, remove from there
        const regularIndex = s.allowedUsers.indexOf(email);
        if (regularIndex !== -1) {
          s.allowedUsers.splice(regularIndex, 1);
        }
        s.adminUsers.push(email);
      })
    );
  }
}

function removeAdminUser(email: string): void {
  setState(
    produce((s) => {
      const index = s.adminUsers.indexOf(email);
      if (index !== -1) {
        s.adminUsers.splice(index, 1);
      }
    })
  );
}

/** Add a user as regular allowed user. If already in adminUsers, demotes to regular user. */
function addAllowedUser(email: string): void {
  if (email && !state.allowedUsers.includes(email)) {
    setState(
      produce((s) => {
        // If already in admin list, remove from there
        const adminIndex = s.adminUsers.indexOf(email);
        if (adminIndex !== -1) {
          s.adminUsers.splice(adminIndex, 1);
        }
        s.allowedUsers.push(email);
      })
    );
  }
}

function removeAllowedUser(email: string): void {
  setState(
    produce((s) => {
      const index = s.allowedUsers.indexOf(email);
      if (index !== -1) {
        s.allowedUsers.splice(index, 1);
      }
    })
  );
}

function addAccessGroup(name: string): void {
  if (name && !state.enterpriseAccessGroups.includes(name)) {
    setState(produce((s) => {
      s.enterpriseAccessGroups.push(name);
      // REQ-ENTERPRISE-013: seed a new group's routing from the current global default
      // + full catalog, so its card is never empty and "Apply to all" has a source.
      if (!s.groupRouting[name]) {
        s.groupRouting[name] = {
          routes: [...s.dynamicRoutes],
          defaultRoute: s.defaultRouteName || s.dynamicRoutes[0] || '',
          reasoning: s.defaultRouteName ? s.defaultRouteReasoning : 'off',
        };
      }
    }));
  }
}
function removeAccessGroup(name: string): void {
  setState(produce((s) => {
    const i = s.enterpriseAccessGroups.indexOf(name);
    if (i !== -1) s.enterpriseAccessGroups.splice(i, 1);
    delete s.groupRouting[name];
  }));
}

// ─── REQ-ENTERPRISE-014: admin Access groups (Setup access, NOT routing) ───────
// Deliberately no groupRouting seeding — admin groups never appear in per-group
// routing; they only grant admin/Setup access.
function addAdminAccessGroup(name: string): void {
  if (name && !state.adminAccessGroups.includes(name)) {
    setState(produce((s) => { s.adminAccessGroups.push(name); }));
  }
}
function removeAdminAccessGroup(name: string): void {
  setState(produce((s) => {
    const i = s.adminAccessGroups.indexOf(name);
    if (i !== -1) s.adminAccessGroups.splice(i, 1);
  }));
}

// ─── REQ-GITHUB-008: GitHub provider config setters ───────────────────────────
function setGithubProviderType(t: 'app' | 'oauth'): void { setState('githubProviderType', t); }
function setGithubAppClientId(v: string): void { setState('githubAppClientId', v); }
function setGithubAppClientSecret(v: string): void { setState('githubAppClientSecret', v); }
function setGithubOauthClientId(v: string): void { setState('githubOauthClientId', v); }
function setGithubOauthClientSecret(v: string): void { setState('githubOauthClientSecret', v); }

// ─── REQ-ENTERPRISE-013: per-group routing setters ────────────────────────────
function emptyGroupRouting(): GroupRouting { return { routes: [], defaultRoute: '', reasoning: 'off' }; }

/** Toggle a route's membership in a group's active set, fixing the default if needed. */
function toggleGroupRoute(group: string, route: string): void {
  setState(produce((s) => {
    if (!s.groupRouting[group]) s.groupRouting[group] = emptyGroupRouting();
    const g = s.groupRouting[group];
    const i = g.routes.indexOf(route);
    if (i === -1) {
      g.routes.push(route);
      if (!g.defaultRoute) g.defaultRoute = route; // first active route becomes the default
    } else {
      g.routes.splice(i, 1);
      if (g.defaultRoute === route) {
        // The default belonged to the removed route; fall back to the new first route
        // (or clear) with reasoning off, matching the resolver's drift rule.
        g.defaultRoute = g.routes[0] ?? '';
        g.reasoning = 'off';
      }
    }
  }));
}

function setGroupDefaultRoute(group: string, route: string): void {
  setState(produce((s) => {
    if (!s.groupRouting[group]) s.groupRouting[group] = emptyGroupRouting();
    s.groupRouting[group].defaultRoute = route;
  }));
}

function setGroupReasoning(group: string, level: ReasoningLevel): void {
  setState(produce((s) => {
    if (!s.groupRouting[group]) s.groupRouting[group] = emptyGroupRouting();
    s.groupRouting[group].reasoning = level;
  }));
}

/** Copy one group's routing config to every other configured group. */
function applyGroupRoutingToAll(source: string): void {
  setState(produce((s) => {
    const src = s.groupRouting[source];
    if (!src) return;
    for (const g of s.enterpriseAccessGroups) {
      if (g === source) continue;
      s.groupRouting[g] = { routes: [...src.routes], defaultRoute: src.defaultRoute, reasoning: src.reasoning };
    }
  }));
}

function addDynamicRoute(name: string): void {
  if (name && !state.dynamicRoutes.includes(name)) {
    setState(produce((s) => {
      s.dynamicRoutes.push(name);
      // The first route added auto-becomes the default an agent uses when it
      // names none; a later explicit pick overrides it.
      if (!s.defaultRouteName) s.defaultRouteName = name;
    }));
  }
}
function removeDynamicRoute(name: string): void {
  setState(produce((s) => {
    const i = s.dynamicRoutes.indexOf(name);
    if (i !== -1) s.dynamicRoutes.splice(i, 1);
    // If the removed route was the default, fall back to the new first route (or
    // clear when the catalog is now empty). The reasoning grade belonged to the
    // removed route, so reset it to off for the fallback (matching the resolver's
    // "unset default → reasoning off" rule); the admin can re-raise it.
    if (s.defaultRouteName === name) {
      s.defaultRouteName = s.dynamicRoutes[0] ?? '';
      s.defaultRouteReasoning = 'off';
    }
  }));
}

function setDefaultRouteName(name: string): void {
  setState('defaultRouteName', name);
}
function setDefaultRouteReasoning(level: 'off' | 'low' | 'medium' | 'high'): void {
  setState('defaultRouteReasoning', level);
}

function setCloudflareBrowserToken(token: string): void {
  setState('cloudflareBrowserToken', token);
}
function setCloudflareBrowserAccountId(accountId: string): void {
  setState('cloudflareBrowserAccountId', accountId);
}

function setCustomDomain(domain: string): void {
  setState({ customDomain: domain, customDomainError: null });
}

function nextStep(): void {
  if (state.step < TOTAL_STEPS) {
    setState('step', state.step + 1);
  }
}

function prevStep(): void {
  setState('step', Math.max(1, state.step - 1));
}

function goToStep(step: number): void {
  setState('step', Math.max(1, Math.min(TOTAL_STEPS, step)));
}

/**
 * Pre-fill the store from the existing backend configuration.
 * Called when setup is already configured (re-configuration flow).
 */
async function loadExistingConfig(): Promise<void> {
  if (configLoaded) return;
  configLoaded = true;
  try {
    const statusRes = await api.getSetupStatus();

    if (statusRes.saasMode) {
      setState('saasMode', true);
    }
    if (statusRes.enterpriseMode) {
      setState('enterpriseMode', true);
    }

    if (statusRes.configured) {
      // Enterprise reconfiguration: GET /api/users returns 403 in enterprise mode
      // (REQ-ENTERPRISE-009), so admins and the Access group come from the setup
      // prefill instead. Calling getUsers() here would throw and abort the whole
      // prefill, leaving enterpriseAccessGroup blank and silently clearing the
      // stored value on the next save. The non-enterprise path below is unchanged.
      if (statusRes.enterpriseMode) {
        const prefill = await api.getSetupPrefill();
        setState(
          produce((s) => {
            if (statusRes.customDomain) {
              s.customDomain = statusRes.customDomain;
            }
            s.adminUsers = Array.from(new Set(prefill.adminUsers.map((email) => email.trim().toLowerCase())));
            s.enterpriseAccessGroups = prefill.enterpriseAccessGroup;
            s.adminAccessGroups = prefill.adminAccessGroup;
            s.dynamicRoutes = prefill.dynamicRoutes;
            s.defaultRouteName = prefill.defaultRoute?.route ?? prefill.dynamicRoutes[0] ?? '';
            s.defaultRouteReasoning = prefill.defaultRoute?.reasoning ?? 'off';
            s.cloudflareBrowserTokenSet = prefill.browserRenderTokenSet;
            s.cloudflareBrowserAccountId = prefill.browserRenderAccountId;
            s.githubProviderType = prefill.githubProviderType ?? 'app';
            s.githubAppClientId = prefill.githubAppClientId;
            s.githubAppClientSecretSet = prefill.githubAppClientSecretSet;
            s.githubOauthClientId = prefill.githubOauthClientId;
            s.githubOauthClientSecretSet = prefill.githubOauthClientSecretSet;
            s.groupRouting = prefill.groupRouting;
          })
        );
        return;
      }
      // Reconfiguration: load existing config so admin can see what's set
      const { users: usersRes } = await api.getUsers();
      setState(
        produce((s) => {
          if (statusRes.customDomain) {
            s.customDomain = statusRes.customDomain;
          }
          s.adminUsers = usersRes
            .filter((u) => u.role === 'admin')
            .map((u) => u.email);
          if (!statusRes.saasMode) {
            s.allowedUsers = usersRes
              .filter((u) => u.role !== 'admin')
              .map((u) => u.email);
          }
        })
      );
      return;
    }

    // Initial setup: in SaaS mode, admin enters everything manually (no prefill)
    if (statusRes.saasMode) {
      return;
    }

    const prefill = await api.getSetupPrefill();
    setState(
      produce((s) => {
        if (prefill.customDomain) {
          s.customDomain = prefill.customDomain;
        }
        const admins = Array.from(new Set(prefill.adminUsers.map((email) => email.trim().toLowerCase())));
        const regularUsers = Array.from(new Set(prefill.allowedUsers.map((email) => email.trim().toLowerCase())))
          .filter((email) => !admins.includes(email));
        s.adminUsers = admins;
        s.allowedUsers = regularUsers;
        s.enterpriseAccessGroups = prefill.enterpriseAccessGroup;
        s.adminAccessGroups = prefill.adminAccessGroup;
        s.dynamicRoutes = prefill.dynamicRoutes;
        s.defaultRouteName = prefill.defaultRoute?.route ?? prefill.dynamicRoutes[0] ?? '';
        s.defaultRouteReasoning = prefill.defaultRoute?.reasoning ?? 'off';
        s.cloudflareBrowserTokenSet = prefill.browserRenderTokenSet;
        s.cloudflareBrowserAccountId = prefill.browserRenderAccountId;
      })
    );
  } catch {
    // Silently fail — pre-fill is best-effort
    configLoaded = false;
  }
}

async function configure(): Promise<boolean> {
  setState({ configuring: true, configureSteps: [], configureError: null });

  try {
    const allUsers = [...state.adminUsers, ...state.allowedUsers];
    const response = await fetch('/api/setup/configure', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'manual',
      body: JSON.stringify({
        customDomain: state.customDomain,
        allowedUsers: allUsers,
        adminUsers: state.adminUsers,
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
          // REQ-BROWSER-007: a blank token => backend keeps the existing one (no clobber).
          browserRenderToken: state.cloudflareBrowserToken,
          browserRenderAccountId: state.cloudflareBrowserAccountId,
          // REQ-GITHUB-008: provider type + client ids; a blank secret => backend keeps
          // the existing one (no clobber, mirroring the browser token).
          githubProviderType: state.githubProviderType,
          githubAppClientId: state.githubAppClientId,
          githubAppClientSecret: state.githubAppClientSecret,
          githubOauthClientId: state.githubOauthClientId,
          githubOauthClientSecret: state.githubOauthClientSecret,
          // REQ-ENTERPRISE-013: per-group routing map.
          groupRouting: state.groupRouting,
        } : {}),
      }),
    });

    // Detect CF Access auth redirects
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      setState({ configureError: 'Authentication redirect detected — session may have expired' });
      return false;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let errorMsg = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) errorMsg = parsed.error;
        if (Array.isArray(parsed.steps)) setState({ configureSteps: parsed.steps });
      } catch { /* not JSON */ }
      setState({ configureError: errorMsg });
      return false;
    }

    // Read NDJSON stream line by line
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let success = false;

    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as Record<string, unknown>;

          if (msg.done) {
            // Final summary message
            if (msg.success) {
              success = true;
              setState({
                setupComplete: true,
                customDomainUrl: (msg.customDomainUrl as string) || null,
                accountId: (msg.accountId as string) || null,
              });
              if (Array.isArray(msg.steps)) {
                setState({ configureSteps: msg.steps as SetupState['configureSteps'] });
              }
            } else {
              setState({ configureError: (msg.error as string) || 'Configuration failed' });
              if (Array.isArray(msg.steps)) {
                setState({ configureSteps: msg.steps as SetupState['configureSteps'] });
              }
            }
          } else if (msg.step && msg.status) {
            // Progressive step update
            setState(
              produce((s) => {
                const existing = s.configureSteps.find((st) => st.step === msg.step);
                if (existing) {
                  existing.status = msg.status as string;
                  if (msg.error) existing.error = msg.error as string;
                } else {
                  const entry: { step: string; status: string; error?: string } = {
                    step: msg.step as string,
                    status: msg.status as string,
                  };
                  if (msg.error) entry.error = msg.error as string;
                  s.configureSteps.push(entry);
                }
              })
            );
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (done) break;
    }

    return success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Configuration request failed';
    setState({ configureError: msg });
    return false;
  } finally {
    setState({ configuring: false });
  }
}

function reset(): void {
  configLoaded = false;
  setState({ ...initialState, adminUsers: [], allowedUsers: [], enterpriseAccessGroups: [], adminAccessGroups: [], dynamicRoutes: [], configureSteps: [], groupRouting: {} });
}

export const setupStore = {
  // State (readonly via getters)
  get step() {
    return state.step;
  },
  get tokenDetected() {
    return state.tokenDetected;
  },
  get tokenDetecting() {
    return state.tokenDetecting;
  },
  get tokenDetectError() {
    return state.tokenDetectError;
  },
  get accountInfo() {
    return state.accountInfo;
  },
  get customDomain() {
    return state.customDomain;
  },
  get customDomainError() {
    return state.customDomainError;
  },
  get adminUsers() {
    return state.adminUsers;
  },
  get allowedUsers() {
    return state.allowedUsers;
  },
  get configuring() {
    return state.configuring;
  },
  get configureSteps() {
    return state.configureSteps;
  },
  get configureError() {
    return state.configureError;
  },
  get setupComplete() {
    return state.setupComplete;
  },
  get customDomainUrl() {
    return state.customDomainUrl;
  },
  get accountId() {
    return state.accountId;
  },
  get saasMode() {
    return state.saasMode;
  },
  get enterpriseMode() {
    return state.enterpriseMode;
  },
  get enterpriseAccessGroups() { return state.enterpriseAccessGroups; },
  get adminAccessGroups() { return state.adminAccessGroups; },
  get dynamicRoutes() { return state.dynamicRoutes; },
  get defaultRouteName() { return state.defaultRouteName; },
  get defaultRouteReasoning() { return state.defaultRouteReasoning; },
  get cloudflareBrowserToken() { return state.cloudflareBrowserToken; },
  get cloudflareBrowserTokenSet() { return state.cloudflareBrowserTokenSet; },
  get cloudflareBrowserAccountId() { return state.cloudflareBrowserAccountId; },
  get githubProviderType() { return state.githubProviderType; },
  get githubAppClientId() { return state.githubAppClientId; },
  get githubAppClientSecret() { return state.githubAppClientSecret; },
  get githubAppClientSecretSet() { return state.githubAppClientSecretSet; },
  get githubOauthClientId() { return state.githubOauthClientId; },
  get githubOauthClientSecret() { return state.githubOauthClientSecret; },
  get githubOauthClientSecretSet() { return state.githubOauthClientSecretSet; },
  get groupRouting() { return state.groupRouting; },

  // Actions
  detectToken,
  loadExistingConfig,
  addAdminUser,
  removeAdminUser,
  addAllowedUser,
  removeAllowedUser,
  setCustomDomain,
  addAccessGroup,
  removeAccessGroup,
  addAdminAccessGroup,
  removeAdminAccessGroup,
  addDynamicRoute,
  removeDynamicRoute,
  setDefaultRouteName,
  setDefaultRouteReasoning,
  setCloudflareBrowserToken,
  setCloudflareBrowserAccountId,
  setGithubProviderType,
  setGithubAppClientId,
  setGithubAppClientSecret,
  setGithubOauthClientId,
  setGithubOauthClientSecret,
  toggleGroupRoute,
  setGroupDefaultRoute,
  setGroupReasoning,
  applyGroupRoutingToAll,
  nextStep,
  prevStep,
  goToStep,
  configure,
  reset,
};
