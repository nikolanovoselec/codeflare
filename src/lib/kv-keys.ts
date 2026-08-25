/**
 * KV key utilities for session management
 */
import type { Session } from '../types';
import { NotFoundError } from './error-types';
import { createLogger } from './logger';

/**
 * Compressed metadata embedded in KV list keys for session status.
 * batch-status reads this instead of N individual KV.get calls.
 * Must fit within Cloudflare KV's 1024-byte metadata limit (~195 bytes worst case).
 */
interface MetricsListMetadata {
  /** cpu */
  c?: string;
  /** mem */
  e?: string;
  /** hdd */
  h?: string;
  /** syncStatus */
  y?: string;
  /** updatedAt */
  u?: string;
}

export interface SessionEditorMetadata {
  er: 0 | 1;
  ee?: 1;
}

export interface SessionMetricsMetadata {
  la?: string;
  m: MetricsListMetadata;
}

export interface SessionStatusCorrectionMetadata {
  r: 0 | 1;
}

const SESSION_STATUS_CORRECTION_TTL_SECONDS = 120;

export interface SessionListMetadata {
  /** status: 'r' = running, 'i' = initializing, 's' = stopped */
  s?: 'r' | 'i' | 's';
  /** lastActiveAt ISO string */
  la?: string;
  /** lastStartedAt ISO string */
  sa?: string;
  /** Browser IDE editor readiness: 1 = ready, 0 = warming/failed. */
  er?: 0 | 1;
  /** Browser IDE bounded warm-up failure. */
  ee?: 1;
  /**
   * Legacy inline metrics. New runtime metrics use a concern-owned key so
   * metrics ticks cannot overwrite lifecycle or user edits to the session.
   */
  m?: MetricsListMetadata;
}

function buildMetricsListMetadata(metrics: Session['metrics']): MetricsListMetadata {
  return {
    ...(metrics?.cpu && { c: metrics.cpu }),
    ...(metrics?.mem && { e: metrics.mem }),
    ...(metrics?.hdd && { h: metrics.hdd }),
    ...(metrics?.syncStatus && { y: metrics.syncStatus }),
    ...(metrics?.updatedAt && { u: metrics.updatedAt }),
  };
}

/** Build compressed list metadata from a Session object. */
export function buildSessionMetadata(session: Session): SessionListMetadata {
  const meta: SessionListMetadata = {
    s: session.status === 'running' ? 'r' : 's',
    la: session.lastActiveAt,
    sa: session.lastStartedAt,
    ...(typeof session.editorReady === 'boolean' && { er: session.editorReady ? 1 : 0 }),
    ...(session.editorReadyError === true && { ee: 1 }),
  };
  if (session.metrics) meta.m = buildMetricsListMetadata(session.metrics);
  return meta;
}

/** Expand compressed metadata to the shape batch-status returns. */
export function expandSessionMetadata(meta: SessionListMetadata): {
  status: string;
  ptyActive: boolean;
  lastActiveAt: string | null;
  lastStartedAt: string | null;
  editorReady?: boolean;
  editorReadyError?: boolean;
  metrics?: Session['metrics'];
} {
  const isRunning = meta.s === 'r';
  return {
    status: isRunning ? 'running' : 'stopped',
    ptyActive: isRunning && meta.er === undefined,
    lastActiveAt: meta.la || null,
    lastStartedAt: meta.sa || null,
    ...(meta.er !== undefined && { editorReady: meta.er === 1 }),
    ...(meta.ee === 1 && { editorReadyError: true }),
    ...(meta.m && {
      metrics: {
        ...(meta.m.c && { cpu: meta.m.c }),
        ...(meta.m.e && { mem: meta.m.e }),
        ...(meta.m.h && { hdd: meta.m.h }),
        ...(meta.m.y && { syncStatus: meta.m.y }),
        ...(meta.m.u && { updatedAt: meta.m.u }),
      },
    }),
  };
}

/**
 * Write a session to KV with synchronized list metadata.
 * All session KV.put calls MUST use this to keep metadata in sync.
 */
export async function putSessionWithMetadata(
  kv: KVNamespace,
  key: string,
  session: Session,
): Promise<void> {
  const metadata = buildSessionMetadata(session);
  await kv.put(key, JSON.stringify(session), { metadata });
}

export function getSessionEditorKey(bucketName: string, sessionId: string): string {
  return `session-editor:${bucketName}:${sessionId}`;
}

export function getSessionEditorPrefix(bucketName: string): string {
  return `session-editor:${bucketName}:`;
}

export function getSessionMetricsKey(bucketName: string, sessionId: string): string {
  return `session-metrics:${bucketName}:${sessionId}`;
}

export function getSessionMetricsPrefix(bucketName: string): string {
  return `session-metrics:${bucketName}:`;
}

export function getSessionStatusCorrectionKey(bucketName: string, sessionId: string): string {
  return `session-status-correction:${bucketName}:${sessionId}`;
}

export function getSessionStatusCorrectionPrefix(bucketName: string): string {
  return `session-status-correction:${bucketName}:`;
}

export async function putSessionEditorState(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
  state: { editorReady: boolean; editorReadyError?: boolean },
): Promise<void> {
  const metadata: SessionEditorMetadata = {
    er: state.editorReady ? 1 : 0,
    ...(state.editorReadyError === true && { ee: 1 }),
  };
  await kv.put(getSessionEditorKey(bucketName, sessionId), '', { metadata });
}

export async function putSessionMetricsState(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
  state: { lastActiveAt?: string; metrics: Session['metrics'] },
): Promise<void> {
  const metadata: SessionMetricsMetadata = {
    ...(state.lastActiveAt && { la: state.lastActiveAt }),
    m: buildMetricsListMetadata(state.metrics),
  };
  await kv.put(getSessionMetricsKey(bucketName, sessionId), '', { metadata });
}

async function putSessionStatusCorrection(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
  running: boolean,
): Promise<void> {
  const metadata: SessionStatusCorrectionMetadata = { r: running ? 1 : 0 };
  await kv.put(getSessionStatusCorrectionKey(bucketName, sessionId), running ? '1' : '0', {
    metadata,
    expirationTtl: SESSION_STATUS_CORRECTION_TTL_SECONDS,
  });
}

export function putSessionRunningCorrection(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
): Promise<void> {
  return putSessionStatusCorrection(kv, bucketName, sessionId, true);
}

export function clearSessionRunningCorrection(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
): Promise<void> {
  return putSessionStatusCorrection(kv, bucketName, sessionId, false);
}

export async function hasSessionRunningCorrection(
  kv: KVNamespace,
  bucketName: string,
  sessionId: string,
): Promise<boolean> {
  return await kv.get(getSessionStatusCorrectionKey(bucketName, sessionId), 'text') === '1';
}

/**
 * Extract the email address from a KV key like "user:alice@example.com"
 */
export function emailFromKvKey(keyName: string): string {
  return keyName.replace('user:', '');
}

/** Maximum number of pagination iterations for listAllKvKeys to prevent infinite loops */
const MAX_KV_LIST_ITERATIONS = 100;

/**
 * Sanitize a session name to prevent shell injection and XSS.
 * Allows only: alphanumeric, spaces, hyphens, underscores, and '#'.
 * Rejects all shell metacharacters ($, `, |, ;, &, <, >, etc.) and special chars.
 * Example: "Claude Code #1" → "Claude Code #1", "Bad$(rm -rf)" → "Badrmrf"
 */
export function sanitizeSessionName(name: string): string {
  // Allowlist: a-z A-Z 0-9 space hyphen underscore hash
  // Uses replace (not regex alternation) to ensure single-pass filtering
  return name.replace(/[^a-zA-Z0-9 #_-]/g, '').trim() || 'Untitled';
}

/**
 * Get KV key for a session
 */
export function getSessionKey(bucketName: string, sessionId: string): string {
  return `session:${bucketName}:${sessionId}`;
}

/**
 * Get KV prefix for user sessions
 */
export function getSessionPrefix(bucketName: string): string {
  return `session:${bucketName}:`;
}

/** KV key for one user-owned Web Push subscription endpoint digest. */
export function getPushSubKey(bucketName: string, endpointDigest: string): string {
  return `pushsub:${bucketName}:${endpointDigest}`;
}

/** Prefix for listing and deleting every Web Push subscription for one user. */
export function getPushSubPrefix(bucketName: string): string {
  return `pushsub:${bucketName}:`;
}

/**
 * Generate a cryptographically secure random session ID.
 *
 * Produces 96 bits of entropy (12 random bytes) encoded as 24 lowercase hex
 * characters. Matches SESSION_ID_PATTERN validation regex: `/^[a-z0-9]{8,24}$/`
 *
 * @returns 24-character hex string (e.g., "a1b2c3d4e5f6a7b8c9d0e1f2")
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch a session from KV or throw NotFoundError if it doesn't exist.
 */
export async function getSessionOrThrow(kv: KVNamespace, key: string): Promise<Session> {
  const session = await kv.get<Session>(key, 'json');
  if (!session) {
    throw new NotFoundError('Session');
  }
  return session;
}

/**
 * Get KV key for user preferences
 */
export function getPreferencesKey(bucketName: string): string {
  return `user-prefs:${bucketName}`;
}

/**
 * REQ-ENTERPRISE-020: per-bucket Governed Mode migration state object. The single
 * source of truth for a bucket's R2 encryption regime + any in-flight migration
 * (replaces the old boolean UserPreferences.r2SseRegime marker AND the standalone
 * `r2-migration-lock:` key). See src/lib/r2-regime-state.ts.
 */
export function getRegimeStateKey(bucketName: string): string {
  return `r2-regime:${bucketName}`;
}

/**
 * Get KV key for user LLM API keys
 */
export function getLlmKeysKey(bucketName: string): string {
  return `llm-keys:${bucketName}`;
}

/**
 * Get KV key for user deploy credentials (GitHub + Cloudflare tokens)
 */
export function getDeployKeysKey(bucketName: string): string {
  return `deploy-keys:${bucketName}`;
}

/**
 * Get KV key for subscription tier configuration
 */
export function getTiersConfigKey(): string {
  return 'tiers:config';
}

/**
 * Get KV key for a user's Timekeeper usage record
 */
export function getTimekeeperKey(bucketName: string): string {
  return `timekeeper:${bucketName}`;
}

/**
 * Get UTC date string in YYYY-MM-DD format
 */
export function getUtcDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get UTC month string in YYYY-MM format
 */
export function getUtcMonthString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Return Unix timestamp (seconds) for the next 1st of UTC month at 00:00:00.
 * Used to anchor Stripe subscriptions so the billing cycle matches the monthly
 * quota reset boundary.
 *
 */
export function getNextUtcMonthStart(now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(next.getTime() / 1000);
}

/**
 * Get the ISO week start (Monday) date string for a given date.
 * ISO weeks start on Monday. Returns YYYY-MM-DD of the Monday.
 */
export function getIsoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay() returns 0=Sun, 1=Mon, ..., 6=Sat
  // Convert to Mon=0, Tue=1, ..., Sun=6
  const dayOfWeek = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOfWeek);
  return getUtcDateString(d);
}

/**
 * Centralized setup KV key constants. Eliminates raw 'setup:*' strings across 17+ files.
 */
export const SETUP_KEYS = {
  COMPLETE: 'setup:complete',
  COMPLETED_AT: 'setup:completed_at',
  CONFIGURING: 'setup:configuring',
  ACCOUNT_ID: 'setup:account_id',
  R2_ENDPOINT: 'setup:r2_endpoint',
  CUSTOM_DOMAIN: 'setup:custom_domain',
  ALLOWED_ORIGINS: 'setup:allowed_origins',
  ONBOARDING_LANDING_PAGE: 'setup:onboarding_landing_page',
  AUTH_DOMAIN: 'setup:auth_domain',
  ACCESS_AUD: 'setup:access_aud',
  ACCESS_AUD_LIST: 'setup:access_aud_list',
  ACCESS_APP_ID: 'setup:access_app_id',
  ACCESS_SW_BYPASS_APP_ID: 'setup:access_sw_bypass_app_id',
  ACCESS_GROUP_ADMIN_ID: 'setup:access_group_admin_id',
  ACCESS_GROUP_USER_ID: 'setup:access_group_user_id',
  ACCESS_GROUP_ADMIN_NAME: 'setup:access_group_admin_name',
  ACCESS_GROUP_USER_NAME: 'setup:access_group_user_name',
  ENTERPRISE_ACCESS_GROUP: 'setup:enterprise_access_group',
  // REQ-ENTERPRISE-014: enterprise ADMIN access groups. Comma/newline-joined Access
  // group NAMES (same format as ENTERPRISE_ACCESS_GROUP) whose members are granted
  // admin (= Setup access). Resolved live in requireAdmin (not the hot auth path) so
  // membership changes take effect immediately. Distinct from ENTERPRISE_ACCESS_GROUP
  // (which gates entry + per-group routing); admin groups never participate in routing.
  ENTERPRISE_ADMIN_ACCESS_GROUP: 'setup:enterprise_admin_access_group',
  // Feature C: enterprise dynamic-route catalog. DYNAMIC_ROUTES is a JSON string[]
  // of gateway route names (slash-free handles agents send, e.g. "development").
  // DEFAULT_ROUTE is a JSON { route, reasoning } the container applies on start
  // (entrypoint writes Pi defaultThinkingLevel); absent ⇒ no default pinned.
  DYNAMIC_ROUTES: 'setup:dynamic_routes',
  DEFAULT_ROUTE: 'setup:default_route',
  // REQ-ENTERPRISE-012: per-route context window. A JSON map keyed by dynamic-route
  // name -> token count (e.g. { "development": 262144 }). The admin sets it in the
  // Setup wizard (default DEFAULT_ROUTE_CONTEXT_WINDOW); fanned to the container so
  // entrypoint sets each Pi model's contextWindow. A route with no entry falls back
  // to the default. Non-secret (route names + integers).
  ROUTE_CONTEXT_WINDOWS: 'setup:route_context_windows',
  // REQ-ENTERPRISE-013: per-group dynamic routing. A JSON map keyed by Access group
  // name -> { routes: string[] (subset of DYNAMIC_ROUTES), defaultRoute, reasoning }.
  // When set and the user matches a configured group, it overrides DYNAMIC_ROUTES /
  // DEFAULT_ROUTE for that user; absent (or no groups) ⇒ the global catalog applies,
  // byte-identical to pre-feature behavior. Non-secret (route names only).
  GROUP_ROUTING: 'setup:group_routing',
  // REQ-ENTERPRISE-017: enterprise AI Gateway config set in the Setup wizard. The URL is
  // non-secret (plain KV); the token is stored encrypted (kv-crypto, same shape as the
  // Browser Rendering token). Deploy-time env AIG_GATEWAY_URL/AIG_TOKEN remain as an
  // OPTIONAL fallback. Resolved KV-first via getAigConfig (src/lib/aig-config.ts).
  AIG_GATEWAY_URL: 'setup:aig_gateway_url',
  AIG_TOKEN: 'setup:aig_token',
  IDP_LIST: 'setup:idp_list',
  MAX_USERS: 'setup:max_users',
  TURNSTILE_SITE_KEY: 'setup:turnstile_site_key',
  TURNSTILE_SECRET_KEY: 'setup:turnstile_secret_key',
  // REQ-BROWSER-007: admin-global Cloudflare Browser Rendering credentials used by
  // every enterprise session's browser-run (the per-user Push & Deploy accordion is
  // hidden in enterprise). The token is stored encrypted (kv-crypto); the account id
  // is non-secret. Distinct from ACCOUNT_ID ('setup:account_id'), which is the
  // deployment's own Cloudflare account.
  BROWSER_RENDER_TOKEN: 'setup:browser_render_token',
  BROWSER_RENDER_ACCOUNT_ID: 'setup:browser_render_account_id',
  // REQ-ENTERPRISE-016: enterprise-only on/off toggle for strict Gateway egress.
  // Stored as 'active' / 'inactive' (read === 'active'); default OFF when absent.
  // Set by the setup wizard and persisted in KV — no redeploy needed to flip it.
  STRICT_EGRESS: 'setup:strict_egress',
  // REQ-ENTERPRISE-018: enterprise-only Governed Mode toggle — disable R2 SSE-C so the
  // corporate bucket is readable/scannable. Stored as 'active' / 'inactive'
  // (read === 'active'); default OFF when absent. Flipping it reconciles each bucket's
  // encryption regime losslessly on its next session start (src/lib/r2-migration.ts).
  R2_SSE_DISABLED: 'setup:r2_sse_disabled',
  // Enterprise-only view-only-storage toggle: when 'active', the R2 Storage Panel allows
  // open/view (inline) of safe types but blocks file downloads (attachment) so an agent or
  // user cannot bulk-exfiltrate the bucket (e.g. zip the repo and download it). Stored as
  // 'active' / 'inactive' (read === 'active'); default OFF when absent; enterprise-gated.
  DOWNLOADS_DISABLED: 'setup:downloads_disabled',
  // REQ-ENTERPRISE-025: wizard-selected active coding agents (JSON AgentType[], a
  // subset of CONFIGURABLE_ENTERPRISE_AGENTS, min 1). Gates which agents users can
  // pick at session creation; `bash` is always selectable and never stored here.
  // Absent/malformed ⇒ every enterprise-capable agent stays active (pre-feature
  // behavior). Non-secret (agent names).
  ACTIVE_AGENTS: 'setup:active_agents',
  // REQ-GITHUB-008: enterprise GitHub provider config set in the Setup wizard (the
  // per-user Push & Deploy accordion is hidden in enterprise). GITHUB_PROVIDER_TYPE
  // selects 'app' | 'oauth'; the matching client id is non-secret (rides the
  // authorize URL) and stored plain; the matching client secret is stored encrypted
  // (kv-crypto). Distinct from the SaaS login OAUTH_* env so connecting GitHub for
  // repo access never piggybacks on the login app. Read by getGithubProvider in
  // enterprise mode (env vars remain the non-enterprise fallback).
  GITHUB_PROVIDER_TYPE: 'setup:github_provider_type',
  GITHUB_APP_CLIENT_ID: 'setup:github_app_client_id',
  GITHUB_APP_CLIENT_SECRET: 'setup:github_app_client_secret',
  GITHUB_OAUTH_CLIENT_ID: 'setup:github_oauth_client_id',
  GITHUB_OAUTH_CLIENT_SECRET: 'setup:github_oauth_client_secret',
  // Connect-to-Cloudflare OAuth client, admin-configured in the Setup wizard so a
  // user can authorize their OWN Cloudflare account (3-legged OAuth) instead of
  // pasting an API token. The client id is non-secret (rides the authorize URL)
  // and stored plain; the client secret is stored encrypted (kv-crypto). Read by
  // getCloudflareProvider. Non-enterprise only — enterprise has no per-user CF
  // deploy flow (it uses BROWSER_RENDER_TOKEN), so these are never set there.
  CLOUDFLARE_OAUTH_CLIENT_ID: 'setup:cloudflare_oauth_client_id',
  CLOUDFLARE_OAUTH_CLIENT_SECRET: 'setup:cloudflare_oauth_client_secret',
  // Deployment-level managed environment. The public trust selection is
  // committed last; PAT and freshness records are configuration-fingerprint scoped
  // so a failed repository/key replacement cannot overwrite the selected config.
  MANAGED_ENVIRONMENT_CONFIG: 'setup:managed_environment_config',
  MANAGED_ENVIRONMENT_PAT_PREFIX: 'setup:managed_environment_pat:',
  MANAGED_ENVIRONMENT_STATE_PREFIX: 'setup:managed_environment_state:',
  // Deployment-cache relocation is operational state, not part of the public
  // repository/key trust selection. Keeping it separate prevents an automatic
  // cache migration from overwriting a concurrent administrator selection.
  MANAGED_ENVIRONMENT_CACHE_MIGRATION: 'setup:managed_environment_cache_migration',
} as const;

export function getManagedEnvironmentPatKey(configFingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(configFingerprint)) throw new Error('Invalid managed environment configuration fingerprint');
  return `${SETUP_KEYS.MANAGED_ENVIRONMENT_PAT_PREFIX}${configFingerprint}`;
}

export function getManagedEnvironmentStateKey(configFingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(configFingerprint)) throw new Error('Invalid managed environment configuration fingerprint');
  return `${SETUP_KEYS.MANAGED_ENVIRONMENT_STATE_PREFIX}${configFingerprint}`;
}

/**
 * Strict hostname validation for the KV-stored custom domain (CF-018).
 * Accepts only a bare hostname: one or more DNS labels separated by single
 * dots, each label 1-63 chars of [a-z0-9-] not starting/ending with a hyphen.
 * Rejects schemes, paths, ports, userinfo, consecutive dots ('..'), and any
 * other character - so a poisoned KV value can never inject into the redirect
 * base URL.
 */
const CUSTOM_DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

function isValidCustomDomain(domain: string): boolean {
  return CUSTOM_DOMAIN_PATTERN.test(domain);
}

const baseUrlLogger = createLogger('kv-keys');

/**
 * Resolve the base URL for redirects using custom domain from KV or the request origin.
 * The custom domain is validated as a bare hostname (CF-018); an invalid value
 * falls back to the request origin rather than producing a malformed/poisoned URL.
 */
export async function getBaseUrl(kv: KVNamespace, requestUrl: string): Promise<string> {
  const customDomain = await kv.get(SETUP_KEYS.CUSTOM_DOMAIN);
  if (customDomain && isValidCustomDomain(customDomain)) {
    return `https://${customDomain}`;
  }
  if (customDomain) {
    baseUrlLogger.warn('Ignoring invalid custom_domain, falling back to request origin', { customDomain });
  }
  return new URL(requestUrl).origin;
}

/**
 * Fetch all KV keys matching a prefix, handling pagination safely.
 *
 * Cloudflare KV returns a maximum of 1000 keys per call. This function
 * iterates through all pages using cursor-based pagination, with a safety
 * limit to prevent infinite loops.
 *
 * @param kv - KV namespace binding
 * @param prefix - Key prefix to list (e.g., "user:" or "session:bucket:")
 * @returns Array of all matching keys across all pages
 * @throws If more than MAX_KV_LIST_ITERATIONS pages are encountered (indicates infinite pagination)
 */
export async function listAllKvKeys(kv: KVNamespace, prefix: string): Promise<KVNamespaceListKey<unknown>[]> {
  const keys: KVNamespaceListKey<unknown>[] = [];
  let cursor: string | undefined;
  let iterations = 0;
  do {
    const result = await kv.list(cursor ? { prefix, cursor } : { prefix });
    keys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
    iterations++;
  } while (cursor && iterations < MAX_KV_LIST_ITERATIONS);
  return keys;
}
