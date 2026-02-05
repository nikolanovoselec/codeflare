// Port constants (single source of truth)
// Terminal server handles all endpoints: WebSocket, health, metrics
export const TERMINAL_SERVER_PORT = 8080;

// Session ID validation
export const SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/;

// Default allowed origin patterns for CORS
// These are used if ALLOWED_ORIGINS environment variable is not set
export const DEFAULT_ALLOWED_ORIGINS = ['.workers.dev'];

/** Idle timeout before container sleeps (5 minutes) */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Delay after setting bucket name before proceeding */
export const BUCKET_NAME_SETTLE_DELAY_MS = 100;

/** Request ID display length */
export const REQUEST_ID_LENGTH = 8;

/** Valid X-Request-ID pattern: 1-64 chars, alphanumeric plus dash and underscore */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** CORS max age in seconds */
export const CORS_MAX_AGE_SECONDS = 86400;

/** DO ID validation pattern */
export const DO_ID_PATTERN = /^[a-f0-9]{64}$/i;

/** Maximum session name length */
export const MAX_SESSION_NAME_LENGTH = 100;

/** Container ID display truncation length */
export const CONTAINER_ID_DISPLAY_LENGTH = 24;

/** Activity poll interval for container idle detection (5 minutes) */
export const ACTIVITY_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Number of retries for activity endpoint fetch before giving up this poll cycle */
export const ACTIVITY_FETCH_MAX_RETRIES = 3;

/** Delay between activity endpoint retry attempts */
export const ACTIVITY_FETCH_RETRY_DELAY_MS = 2000;

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

/** Protected paths that cannot be uploaded, deleted, or moved */
export const PROTECTED_PATHS = ['.claude/', '.anthropic/', '.ssh/', '.config/', '.claude.json'];
