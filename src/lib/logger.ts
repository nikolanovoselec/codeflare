/**
 * Available log levels in order of severity
 */
/** @internal */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Structure of a log entry
 */
/** @internal */
interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Module/component name */
  module: string;
  /** Optional request ID for tracing */
  requestId?: string;
  /** Log message */
  message: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
  /** Error details if logging an error */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Allow additional context fields */
  [key: string]: unknown;
}

/**
 * Logger interface
 * @internal
 */
export interface Logger {
  /** Log a debug message (not output by default) */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Log an info message */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log a warning message */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log an error message with optional Error object and additional data */
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
  /** Create a child logger with additional context */
  child(context: Record<string, unknown>): Logger;
}

/**
 * Numeric log levels for comparison
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Minimum log level to output
 * Configurable at runtime via setLogLevel()
 * Defaults to 'silent' in test environments to keep test output clean.
 * Detection: vitest injects __vitest_worker__ into globalThis in all runtimes (including Workers pool).
 */
const isTestEnv = '__vitest_worker__' in globalThis;
let minLogLevel: LogLevel = isTestEnv ? 'silent' : 'info';

/**
 * Set the minimum log level at runtime.
 * Call early in the request lifecycle (e.g., from env.LOG_LEVEL).
 */
export function setLogLevel(level: LogLevel): void {
  minLogLevel = level;
}

/**
 * Create a structured JSON logger
 *
 * Outputs logs in JSON format suitable for log aggregation services
 * like Cloudflare Logs, Datadog, or ELK stack.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const logger = createLogger('session-handler');
 * logger.info('Session created', { sessionId: 'abc123' });
 *
 * // With initial context
 * const logger = createLogger('api', { version: '1.0.0' });
 *
 * // Child logger for request context
 * const reqLogger = logger.child({ requestId: 'req-123', userId: 'user-456' });
 * reqLogger.info('Processing request');
 *
 * // Error logging
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   logger.error('Operation failed', err, { operationId: '123' });
 * }
 * ```
 *
 * Output format:
 * ```json
 * {
 *   "timestamp": "2024-01-15T10:30:00.000Z",
 *   "level": "info",
 *   "module": "session-handler",
 *   "message": "Session created",
 *   "data": { "sessionId": "abc123" }
 * }
 * ```
 *
 * @param module - Name of the module/component for log categorization
 * @param context - Optional initial context to include in all log entries
 * @returns Logger instance
 */
export function createLogger(module: string, context?: Record<string, unknown>): Logger {
  const baseContext = context || {};

  function log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[minLogLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      ...baseContext,
      ...(data && { data }),
      ...(error && {
        error: {
          name: error.name,
          message: error.message,
          ...(error.stack && { stack: error.stack }),
        },
      }),
    };

    const output = JSON.stringify(entry);

    switch (level) {
      case 'debug':
      case 'info':
        console.log(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    // Parameter order is (message, error, data) — not (message, data) like other methods —
    // because the Error object is more important than metadata for debugging.
    error: (msg, err, data) => log('error', msg, data, err),
    child: (ctx) => createLogger(module, { ...baseContext, ...ctx }),
  };
}
