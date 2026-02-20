/**
 * Frontend Constants - Single source of truth for magic numbers
 * Keep in sync with backend constants where applicable (src/lib/constants.ts)
 */

// =============================================================================
// Polling Intervals
// =============================================================================

/** Interval for polling startup status during session initialization (ms) */
export const STARTUP_POLL_INTERVAL_MS = 1500;

/** Interval for polling session metrics when running (ms) */
export const METRICS_POLL_INTERVAL_MS = 5000;

/** Maximum consecutive polling errors before aborting startup */
export const MAX_STARTUP_POLL_ERRORS = 10;

// =============================================================================
// Terminal Connection
// =============================================================================

/** Maximum connection retries during initial connect */
export const MAX_CONNECTION_RETRIES = 45;

/** Delay between initial connection retry attempts (ms) */
export const CONNECTION_RETRY_DELAY_MS = 1500;

/** Maximum reconnection attempts for dropped connections */
export const MAX_RECONNECT_ATTEMPTS = 5;

/** Delay between reconnection attempts (ms) */
export const RECONNECT_DELAY_MS = 2000;

// =============================================================================
// UI Timing
// =============================================================================

/** Delay for CSS transitions to settle before layout operations (ms) */
export const CSS_TRANSITION_DELAY_MS = 100;

// =============================================================================
// WebSocket Close Codes
// =============================================================================

/** WebSocket close code for abnormal closure (connection failed) */
export const WS_CLOSE_ABNORMAL = 1006;

/** Application-level ping interval to keep idle WebSocket connections alive (ms) */
export const WS_PING_INTERVAL_MS = 25_000;

/** Watchdog timeout: close WebSocket if no data received within this window (ms) */
export const WS_WATCHDOG_TIMEOUT_MS = 45_000;

// =============================================================================
// Session
// =============================================================================

/** Maximum terminals per session. Keep in sync with src/lib/constants.ts:MAX_TABS (backend equivalent) */
export const MAX_TERMINALS_PER_SESSION = 6;

/** Interval for polling the session list to keep the dashboard up to date (ms) */
export const SESSION_LIST_POLL_INTERVAL_MS = 3_000;

/** Duration display refresh interval (ms) - for relative time updates */
export const DURATION_REFRESH_INTERVAL_MS = 60000;

/** Maximum polls when waiting for session to stop */
export const MAX_STOP_POLL_ATTEMPTS = 20;

/** Interval between stop-status polls (ms) */
export const STOP_POLL_INTERVAL_MS = 3000;

/** Maximum consecutive errors before giving up stop polling */
export const MAX_STOP_POLL_ERRORS = 5;

/** Session ID display length */
export const SESSION_ID_DISPLAY_LENGTH = 8;

// =============================================================================
// Storage
// =============================================================================

/** Delay before retrying a failed storage browse request (ms) */
export const STORAGE_BROWSE_RETRY_DELAY_MS = 2000;

/** Duration before auto-dismissing a completed upload toast (ms) */
export const UPLOAD_DISMISS_DELAY_MS = 5000;

// =============================================================================
// Mobile / Touch
// =============================================================================

/** Duration to show floating button labels after keyboard opens (ms) */
export const BUTTON_LABEL_VISIBLE_DURATION_MS = 3000;

/** Interval for checking URLs in the terminal buffer (ms) */
export const URL_CHECK_INTERVAL_MS = 2000;

// =============================================================================
// Terminal URL Detection
// =============================================================================

/**
 * URL patterns that trigger the floating "Open URL" / "Copy URL" button.
 * Only auth/OAuth URLs are shown — not every URL that appears in the terminal.
 * Covers: Claude Code, OpenCode, Codex, Gemini CLI, and generic OAuth flows.
 */
export const ACTIONABLE_URL_PATTERNS: RegExp[] = [
  /\/oauth\/authorize/i,
  /\/oauth2\/authorize/i,
  /\/login\/oauth/i,
  /\/auth\/callback/i,
  /\/device\/code/i,
  /\/device\/activate/i,
  /\/login\/device/i,
  /accounts\.google\.com\/o\/oauth2/i,
  /github\.com\/login\/device/i,
  /console\.anthropic\.com/i,
];

// =============================================================================
// View Transitions
// =============================================================================

/** Duration of dashboard expand/collapse CSS transition (ms) */
export const VIEW_TRANSITION_DURATION_MS = 300;

// =============================================================================
// Container Context Expiry
// =============================================================================

/** After this duration of inactivity, agent context is gone and container must be fully restarted (ms) */
export const CONTEXT_EXPIRY_MS = 3 * 60 * 1000; // 3m — matches backend sleepAfter for testing

/** Timeout for attempting WebSocket reconnection before falling back to full restart (ms) */
export const WS_RECONNECT_TIMEOUT_MS = 5_000;
