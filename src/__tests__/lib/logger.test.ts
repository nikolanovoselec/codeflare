import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, setLogLevel, LogLevel, Logger } from '../../lib/logger';

describe('createLogger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    // Reset log level to default — other tests may set it to 'silent' via env bindings
    setLogLevel('info');
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:30:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function parseLogOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, any> | null {
    if (spy.mock.calls.length === 0) return null;
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    return JSON.parse(lastCall[0] as string);
  }

  describe('log levels', () => {
    it('logs info messages to console.log', () => {
      const logger = createLogger('test-module');
      logger.info('Test message');

      expect(consoleSpy.log).toHaveBeenCalled();
      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.level).toBe('info');
      expect(entry?.message).toBe('Test message');
    });

    it('logs warn messages to console.warn', () => {
      const logger = createLogger('test-module');
      logger.warn('Warning message');

      expect(consoleSpy.warn).toHaveBeenCalled();
      const entry = parseLogOutput(consoleSpy.warn);
      expect(entry?.level).toBe('warn');
      expect(entry?.message).toBe('Warning message');
    });

    it('logs error messages to console.error', () => {
      const logger = createLogger('test-module');
      logger.error('Error message');

      expect(consoleSpy.error).toHaveBeenCalled();
      const entry = parseLogOutput(consoleSpy.error);
      expect(entry?.level).toBe('error');
      expect(entry?.message).toBe('Error message');
    });

    it('does not log debug messages by default (min level is info)', () => {
      const logger = createLogger('test-module');
      logger.debug('Debug message');

      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
  });

  describe('structured output', () => {
    it('includes timestamp in ISO format', () => {
      const logger = createLogger('test-module');
      logger.info('Test');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.timestamp).toBe('2024-01-15T10:30:00.000Z');
    });

    it('includes module name', () => {
      const logger = createLogger('my-awesome-module');
      logger.info('Test');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.module).toBe('my-awesome-module');
    });

    it('outputs valid JSON', () => {
      const logger = createLogger('test');
      logger.info('Test message');

      const rawOutput = consoleSpy.log.mock.calls[0][0] as string;
      expect(() => JSON.parse(rawOutput)).not.toThrow();
    });
  });

  describe('additional data', () => {
    it('includes additional data in log entry', () => {
      const logger = createLogger('test-module');
      logger.info('User action', { userId: '123', action: 'login' });

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.data).toEqual({ userId: '123', action: 'login' });
    });

    it('handles nested data objects', () => {
      const logger = createLogger('test-module');
      logger.info('Complex data', {
        user: { id: '123', name: 'Test' },
        metadata: { count: 42 },
      });

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.data?.user).toEqual({ id: '123', name: 'Test' });
      expect(entry?.data?.metadata).toEqual({ count: 42 });
    });

    it('does not include data field when no data provided', () => {
      const logger = createLogger('test-module');
      logger.info('No data');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry).not.toHaveProperty('data');
    });
  });

  describe('error logging', () => {
    it('includes error details when error is provided', () => {
      const logger = createLogger('test-module');
      const testError = new Error('Something went wrong');
      testError.stack = 'Error: Something went wrong\n    at test.ts:1:1';

      logger.error('Operation failed', testError);

      const entry = parseLogOutput(consoleSpy.error);
      expect(entry?.error).toEqual({
        name: 'Error',
        message: 'Something went wrong',
        stack: 'Error: Something went wrong\n    at test.ts:1:1',
      });
    });

    it('includes both error and additional data', () => {
      const logger = createLogger('test-module');
      const testError = new Error('Database error');

      logger.error('Query failed', testError, { query: 'SELECT *', table: 'users' });

      const entry = parseLogOutput(consoleSpy.error);
      expect(entry?.error?.message).toBe('Database error');
      expect(entry?.data).toEqual({ query: 'SELECT *', table: 'users' });
    });

    it('handles error without stack trace', () => {
      const logger = createLogger('test-module');
      const testError = new Error('No stack');
      delete testError.stack;

      logger.error('Error occurred', testError);

      const entry = parseLogOutput(consoleSpy.error);
      expect(entry?.error?.name).toBe('Error');
      expect(entry?.error?.message).toBe('No stack');
      expect(entry?.error?.stack).toBeUndefined();
    });
  });

  describe('child logger', () => {
    it('creates child logger with additional context', () => {
      const logger = createLogger('test-module');
      const childLogger = logger.child({ requestId: 'req-123' });

      childLogger.info('Request received');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.requestId).toBe('req-123');
      expect(entry?.module).toBe('test-module');
    });

    it('child logger inherits parent context', () => {
      const logger = createLogger('test-module', { service: 'api' });
      const childLogger = logger.child({ requestId: 'req-123' });

      childLogger.info('Test');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.service).toBe('api');
      expect(entry?.requestId).toBe('req-123');
    });

    it('child context overrides parent context', () => {
      const logger = createLogger('test-module', { env: 'development' });
      const childLogger = logger.child({ env: 'production' });

      childLogger.info('Test');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.env).toBe('production');
    });

    it('child can create its own children', () => {
      const logger = createLogger('test-module');
      const child1 = logger.child({ level1: 'a' });
      const child2 = child1.child({ level2: 'b' });

      child2.info('Nested');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.level1).toBe('a');
      expect(entry?.level2).toBe('b');
    });
  });

  describe('setLogLevel', () => {
    afterEach(() => {
      // Reset to default
      setLogLevel('info');
    });

    it('allows debug messages when level set to debug', () => {
      setLogLevel('debug');
      const logger = createLogger('test');
      logger.debug('Debug visible');
      expect(consoleSpy.log).toHaveBeenCalled();
      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.level).toBe('debug');
    });

    it('suppresses info messages when level set to warn', () => {
      setLogLevel('warn');
      const logger = createLogger('test');
      logger.info('Should be hidden');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
  });

  describe('context from constructor', () => {
    it('includes initial context in all logs', () => {
      const logger = createLogger('test-module', {
        service: 'codeflare',
        version: '1.0.0',
      });

      logger.info('Startup');

      const entry = parseLogOutput(consoleSpy.log);
      expect(entry?.service).toBe('codeflare');
      expect(entry?.version).toBe('1.0.0');
    });
  });

  describe('all log methods', () => {
    it('debug method works', () => {
      // Note: debug is filtered by default min level
      // This test verifies the method exists and works at runtime
      const logger = createLogger('test');
      expect(() => logger.debug('test')).not.toThrow();
    });

    it('info method works', () => {
      const logger = createLogger('test');
      logger.info('test');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('warn method works', () => {
      const logger = createLogger('test');
      logger.warn('test');
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('error method works with just message', () => {
      const logger = createLogger('test');
      logger.error('test');
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('error method works with error object', () => {
      const logger = createLogger('test');
      logger.error('test', new Error('fail'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('error method works with error and data', () => {
      const logger = createLogger('test');
      logger.error('test', new Error('fail'), { extra: 'data' });
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });
});
