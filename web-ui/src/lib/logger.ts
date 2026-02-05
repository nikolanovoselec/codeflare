type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isTest = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test';
const isDev = !isTest && typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const minLevel: LogLevel = isDev ? 'debug' : 'warn';

function shouldLog(level: LogLevel): boolean {
  if (isTest) return false;
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

export const logger = {
  debug: (...args: unknown[]) => { if (shouldLog('debug')) console.debug('[DEBUG]', ...args); },
  info: (...args: unknown[]) => { if (shouldLog('info')) console.info('[INFO]', ...args); },
  warn: (...args: unknown[]) => { if (shouldLog('warn')) console.warn('[WARN]', ...args); },
  error: (...args: unknown[]) => { if (shouldLog('error')) console.error('[ERROR]', ...args); },
};
