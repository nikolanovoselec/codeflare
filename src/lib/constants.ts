// Port constants (single source of truth)
// Terminal server handles all endpoints: WebSocket, health, metrics
export const TERMINAL_SERVER_PORT = 8080;

// Session ID validation.
// SAST-false-positive: session IDs are KV namespace keys, NOT auth tokens.
// Authentication is JWT-based; knowing a session ID without a valid JWT
// grants zero access. The pattern validates format only, not entropy.
export const SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/;

// Default allowed origin patterns for CORS
// These are used if ALLOWED_ORIGINS environment variable is not set
export const DEFAULT_ALLOWED_ORIGINS = ['.workers.dev'];

/** Delay after setting bucket name before proceeding */
export const BUCKET_NAME_SETTLE_DELAY_MS = 100;

/** Request ID display length */
export const REQUEST_ID_LENGTH = 8;

/** Valid X-Request-ID pattern: 1-64 chars, alphanumeric plus dash and underscore */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** CORS max age in seconds */
export const CORS_MAX_AGE_SECONDS = 86400;

/** Maximum session name length */
export const MAX_SESSION_NAME_LENGTH = 100;

/** Container ID display truncation length */
export const CONTAINER_ID_DISPLAY_LENGTH = 24;

/** Cloudflare API base URL */
export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Rate limit key used when no user or IP is available */
export const ANONYMOUS_RATE_LIMIT_KEY = 'anonymous';

/** Timeout for container fetch operations (5 seconds for cold start) */
export const CONTAINER_FETCH_TIMEOUT = 5000;

/** Maximum number of saved presets per user */
export const MAX_PRESETS = 3;

/** Number of terminal tabs per session */
// Keep in sync with web-ui/src/lib/constants.ts:MAX_TERMINALS_PER_SESSION
export const MAX_TABS = 6;

/** WebSocket rate limit: sliding window duration (ms) */
export const WS_RATE_LIMIT_WINDOW_MS = 60_000;

/** WebSocket rate limit: max connections per window */
export const WS_RATE_LIMIT_MAX_CONNECTIONS = 30;

/** WebSocket rate limit: KV TTL for rate limit entries (seconds) */
export const WS_RATE_LIMIT_TTL_SECONDS = 120;

/**
 * Max time to wait for a container to answer a terminal WebSocket upgrade before
 * failing fast with a retryable close. A healthy container answers in <1s and
 * warming-up containers are short-circuited earlier; this only bounds a hung /
 * unreachable container so the client is not left "connecting" for tens of seconds.
 */
export const CONTAINER_WS_FORWARD_TIMEOUT_MS = 10_000;

/**
 * Protected paths — blocks browse/upload/download/delete/move via the storage API.
 * Validated in storage/validation.ts validateKey().
 *
 * Use cases:
 * - Multi-tenant deployments where admins can browse other users' storage
 * - Preventing accidental exposure of secrets (API keys, SSH keys) in shared-screen scenarios
 * - Compliance requirements that mandate certain paths are only accessible via terminal
 *
 * Deliberately empty today: each user's storage is bucket-scoped and they already have
 * unrestricted terminal access to the same files. Blocking paths in the UI just forces
 * users to use the terminal for the same operation.
 *
 * To re-enable, add paths like: ['.claude/', '.anthropic/', '.ssh/', '.config/', '.claude.json']
 */
export const PROTECTED_PATHS: string[] = [];

/**
 * REQ-GITHUB-003: non-secret placeholder GH_TOKEN handed to enterprise containers.
 * git / `gh` / Copilot run in authed mode with this, but the real per-user token
 * never enters the container — the GitHubInterceptor strips this placeholder and
 * stamps the real token at the github.com / api.github.com boundary. It is
 * identical for all users by design: per-user scoping is the interceptor's
 * per-session bucket binding, never this value. Matches entrypoint.sh's
 * ENTERPRISE_PLACEHOLDER_TOKEN.
 */
export const ENTERPRISE_GH_TOKEN_PLACEHOLDER = 'codeflare-enterprise';

/**
 * REQ-ENTERPRISE-016: placeholder R2 S3 credentials emitted into the container when strict
 * Gateway egress is active, so the real R2 key never enters the container. rclone signs with
 * this placeholder; the EgressController strips it and re-signs with the worker-held key at
 * the R2 boundary. Any non-empty, pipe-free string works (the placeholder signature is
 * discarded). Deliberately the SAME canonical value as {@link ENTERPRISE_GH_TOKEN_PLACEHOLDER}
 * (`'codeflare-enterprise'`, matching entrypoint.sh's `ENTERPRISE_PLACEHOLDER_TOKEN`) — every
 * enterprise non-secret placeholder credential is this one value by design. Kept a separate
 * literal (NOT aliased to `ENTERPRISE_GH_TOKEN_PLACEHOLDER`) so it reads correctly for R2 and
 * does not trip knip's duplicate-export check.
 */
export const ENTERPRISE_R2_KEY_PLACEHOLDER = 'codeflare-enterprise';

/**
 * REQ-BROWSER-008: placeholder Cloudflare API token emitted into the container as
 * CLOUDFLARE_API_TOKEN in enterprise mode when an admin Browser Rendering token IS
 * configured, so the browser-run MCP servers / Pi `browser_*` extension run in authed
 * mode but never hold the real credential. The CloudflareBrowserInterceptor strips this
 * placeholder and injects the real admin Browser Rendering token at the
 * api.cloudflare.com boundary (and only for the wizard-configured browser account's
 * `/browser-rendering/*` path). Same canonical value as the other enterprise placeholders
 * (`'codeflare-enterprise'`, matching entrypoint.sh's `ENTERPRISE_PLACEHOLDER_TOKEN`);
 * kept a separate literal (NOT aliased) so it reads correctly here and does not trip
 * knip's duplicate-export check.
 */
export const ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER = 'codeflare-enterprise';

/**
 * REQ-ENTERPRISE-012: default per-route context window (tokens) for an enterprise
 * dynamic route. The Setup wizard prefills each route's context-window field with
 * this value and the admin can raise it (e.g. a 1M-context BYOK model) or reset back
 * to it. entrypoint.sh uses it as the fallback when a route has no configured window.
 * 256000 is the safe floor across the current Workers-AI route models (kimi-k2.6
 * 262144 / gemma-4-26b 256000); declaring at-or-below the real model window keeps Pi's
 * proactive compaction firing before the provider's hard context limit.
 */
export const DEFAULT_ROUTE_CONTEXT_WINDOW = 256000;

/** Default max concurrent running sessions for regular users */
const DEFAULT_MAX_SESSIONS_USER = 3;

/** Default max concurrent running sessions for admin users */
const DEFAULT_MAX_SESSIONS_ADMIN = 10;

/**
 * Resolve the session limit for the given role from env vars, falling back to defaults.
 * Uses explicit NaN check (not || fallback) so that MAX_SESSIONS_*=0 is respected.
 */
export function getMaxSessions(role: string | undefined, env: { MAX_SESSIONS_USER?: string; MAX_SESSIONS_ADMIN?: string }): number {
  const envVal = parseInt(role === 'admin' ? (env.MAX_SESSIONS_ADMIN || '') : (env.MAX_SESSIONS_USER || ''));
  const defaultVal = role === 'admin' ? DEFAULT_MAX_SESSIONS_ADMIN : DEFAULT_MAX_SESSIONS_USER;
  return Number.isNaN(envVal) ? defaultVal : envVal;
}

