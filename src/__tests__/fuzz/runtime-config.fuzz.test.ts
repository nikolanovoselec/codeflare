/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant - not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AppError, SetupError, RateLimitError, CircuitBreakerOpenError } from '../../lib/error-types';
import { TabConfigSchema } from '../../lib/schemas';
import { createLogger, setLogLevel } from '../../lib/logger';
import { toApiSession } from '../../lib/session-helpers';
import { getSetupCompleteCache, setSetupCompleteCache, resetSetupCache } from '../../lib/cache-reset';
import { getConfigsForMode, getPreseedKeysNotInMode } from '../../lib/r2-seed';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// XML escape/decode round-trip - protects against injection in DeleteObjects
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TabConfigSchema - Zod schema validation must reject invalid tab configs
// ---------------------------------------------------------------------------
describe('Fuzz: TabConfigSchema', () => {
  it('safeParse never throws on arbitrary objects', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = TabConfigSchema.safeParse(input);
        expect(typeof result.success).toBe('boolean');
        // safeParse must ALWAYS return a result, never throw
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects tab IDs outside 1-6 range', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[1-6]$/.test(s)),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects oversized command (>200 chars)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ minLength: 201, maxLength: 500 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects oversized label (>50 chars)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 51, maxLength: 200 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts valid tab configs with IDs 1-6', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects non-string field types', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (badValue) => {
          const result = TabConfigSchema.safeParse({ id: badValue, command: 'bash', label: 'shell' });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// createLogger / setLogLevel - logger must never throw on arbitrary data
// ---------------------------------------------------------------------------
describe('Fuzz: createLogger / setLogLevel', () => {
  it('createLogger never throws on arbitrary module name and context', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        (moduleName, context) => {
          // Must not throw - logger creation is unconditional
          const logger = createLogger(moduleName, context);
          expect(typeof logger.debug).toBe('function');
          expect(typeof logger.info).toBe('function');
          expect(typeof logger.warn).toBe('function');
          expect(typeof logger.error).toBe('function');
          expect(typeof logger.child).toBe('function');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('log methods never throw on arbitrary data', () => {
    // Set to silent to avoid console noise during fuzz runs
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        (message, data) => {
          const logger = createLogger('fuzz-test');
          // None of these should throw
          logger.debug(message, data);
          logger.info(message, data);
          logger.warn(message, data);
          logger.error(message, new Error('test'), data);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('setLogLevel accepts all valid log levels without throwing', () => {
    const levels = ['debug', 'info', 'warn', 'error', 'silent'] as const;
    for (const level of levels) {
      expect(() => setLogLevel(level)).not.toThrow();
    }
    // Reset to silent for remaining tests
    setLogLevel('silent');
  });

  it('child logger inherits and merges context', () => {
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        (moduleName, parentCtx, childCtx) => {
          const parent = createLogger(moduleName, parentCtx);
          const child = parent.child(childCtx);
          // Child must be a valid logger - never throws
          expect(typeof child.info).toBe('function');
          child.info('test');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('error serialization handles arbitrary Error subclasses', () => {
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (name, message) => {
          const err = new Error(message);
          err.name = name;
          const logger = createLogger('fuzz-error');
          // Must not throw even with unusual error properties
          logger.error('test error', err);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// toApiSession - must strip userId and lastStatusCheck, preserve rest
// ---------------------------------------------------------------------------
describe('Fuzz: toApiSession', () => {
  it('always strips userId and lastStatusCheck', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string(),
          name: fc.string(),
          userId: fc.string(),
          createdAt: fc.string(),
          lastAccessedAt: fc.string(),
          status: fc.oneof(fc.constant('stopped' as const), fc.constant('running' as const), fc.constant(undefined)),
          lastStatusCheck: fc.oneof(fc.integer(), fc.constant(undefined)),
          lastStartedAt: fc.oneof(fc.string(), fc.constant(undefined)),
          lastActiveAt: fc.oneof(fc.string(), fc.constant(undefined)),
          agentType: fc.oneof(fc.string(), fc.constant(undefined)),
        }),
        (session) => {
          const result = toApiSession(session as any);
          // userId and lastStatusCheck MUST be stripped
          expect('userId' in result).toBe(false);
          expect('lastStatusCheck' in result).toBe(false);
          // Other fields must be preserved
          expect(result.id).toBe(session.id);
          expect(result.name).toBe(session.name);
          expect(result.createdAt).toBe(session.createdAt);
          expect(result.lastAccessedAt).toBe(session.lastAccessedAt);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the original session object', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (id, name, userId) => {
          const session = {
            id,
            name,
            userId,
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
            lastStatusCheck: 12345,
          };
          const original = { ...session };
          toApiSession(session as any);
          // Original must not be mutated
          expect(session).toEqual(original);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves optional fields when present', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (agentType, lastStartedAt, lastActiveAt) => {
          const session = {
            id: 'test',
            name: 'test',
            userId: 'user@test.com',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
            agentType,
            lastStartedAt,
            lastActiveAt,
          };
          const result = toApiSession(session as any);
          expect(result.agentType).toBe(agentType);
          expect(result.lastStartedAt).toBe(lastStartedAt);
          expect(result.lastActiveAt).toBe(lastActiveAt);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// cache-reset state machine - model-based testing with fc.commands()
// ---------------------------------------------------------------------------
describe('Fuzz: cache-reset state machine', () => {
  // Model: tracks what setupCompleteCache should be
  class CacheModel {
    value: boolean | null = null;
  }

  class CacheReal {
    // Uses the actual module functions
  }

  class SetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    constructor(readonly value: boolean | null) {}
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      setSetupCompleteCache(this.value);
      m.value = this.value;
      expect(getSetupCompleteCache()).toBe(m.value);
    }
    toString(): string {
      return `set(${this.value})`;
    }
  }

  class GetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      const actual = getSetupCompleteCache();
      expect(actual).toBe(m.value);
    }
    toString(): string {
      return 'get()';
    }
  }

  class ResetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      resetSetupCache();
      m.value = null;
      expect(getSetupCompleteCache()).toBe(null);
    }
    toString(): string {
      return 'reset()';
    }
  }

  const cacheCommands = [
    fc.constantFrom(true, false, null).map((v) => new SetCacheCommand(v)),
    fc.constant(new GetCacheCommand()),
    fc.constant(new ResetCacheCommand()),
  ];

  it('resetSetupCache always returns state to null regardless of prior state', () => {
    fc.assert(
      fc.property(
        fc.commands(cacheCommands, { maxCommands: 50 }),
        (cmds) => {
          // Reset to known state before each run
          resetSetupCache();
          const model = new CacheModel();
          const real = new CacheReal();
          fc.modelRun(() => ({ model, real }), cmds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('set then get always returns the set value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(true, false, null),
        (value) => {
          setSetupCompleteCache(value);
          expect(getSetupCompleteCache()).toBe(value);
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 3) }, // only 3 possible values
    );
  });

  it('multiple resets are idempotent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (count) => {
          setSetupCompleteCache(true);
          for (let i = 0; i < count; i++) {
            resetSetupCache();
          }
          expect(getSetupCompleteCache()).toBe(null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// SetupError, RateLimitError, CircuitBreakerOpenError - constructor + toJSON
// ---------------------------------------------------------------------------
describe('Fuzz: error-types constructors and toJSON', () => {
  it('SetupError toJSON has { success: false, steps, error, code } shape', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({
            step: fc.string(),
            status: fc.string(),
            error: fc.oneof(fc.string(), fc.constant(undefined)),
          }),
          { maxLength: 10 },
        ),
        (message, steps) => {
          const err = new SetupError(message, steps);
          const json = err.toJSON();
          expect(json.success).toBe(false);
          expect(json.steps).toBe(steps);
          expect(json.error).toBe(message);
          expect(json.code).toBe('SETUP_ERROR');
          // SetupError extends AppError
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(400);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('RateLimitError has correct defaults and toJSON shape', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(undefined)),
        (message) => {
          const err = message !== undefined ? new RateLimitError(message) : new RateLimitError();
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(429);
          expect(err.code).toBe('RATE_LIMIT_ERROR');
          const json = err.toJSON();
          expect(typeof json.error).toBe('string');
          expect(json.code).toBe('RATE_LIMIT_ERROR');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('CircuitBreakerOpenError has correct shape for any service name', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (service) => {
          const err = new CircuitBreakerOpenError(service);
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(503);
          expect(err.code).toBe('CIRCUIT_BREAKER_OPEN');
          expect(err.message).toContain(service);
          const json = err.toJSON();
          expect(json.code).toBe('CIRCUIT_BREAKER_OPEN');
          expect(typeof json.error).toBe('string');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('AppError subclass hierarchy is correct', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (message, service) => {
          const setup = new SetupError(message, []);
          const rateLimit = new RateLimitError(message);
          const circuitBreaker = new CircuitBreakerOpenError(service);
          // All extend AppError
          expect(setup instanceof AppError).toBe(true);
          expect(rateLimit instanceof AppError).toBe(true);
          expect(circuitBreaker instanceof AppError).toBe(true);
          // All extend Error
          expect(setup instanceof Error).toBe(true);
          expect(rateLimit instanceof Error).toBe(true);
          expect(circuitBreaker instanceof Error).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('SetupError steps array is preserved exactly (no cloning)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            step: fc.string(),
            status: fc.constantFrom('pending', 'running', 'done', 'error'),
          }),
          { maxLength: 20 },
        ),
        (steps) => {
          const err = new SetupError('test', steps);
          // Reference equality - steps are not cloned
          expect(err.steps).toBe(steps);
          expect(err.toJSON().steps).toBe(steps);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isTextContentType / isImageContentType - replicated from preview.ts (non-exported)
// ---------------------------------------------------------------------------
describe('Fuzz: isTextContentType / isImageContentType', () => {
  // Replicated from src/routes/storage/preview.ts (not exported)
  function isTextContentType(contentType: string): boolean {
    if (contentType.startsWith('text/')) return true;
    if (contentType === 'application/json') return true;
    if (contentType === 'application/xml') return true;
    if (contentType === 'application/javascript') return true;
    if (contentType === 'application/typescript') return true;
    if (contentType === 'application/x-yaml') return true;
    if (contentType === 'application/toml') return true;
    if (contentType === 'application/x-sh') return true;
    return false;
  }

  // Replicated from src/routes/storage/preview.ts (not exported)
  function isImageContentType(contentType: string): boolean {
    return contentType.startsWith('image/');
  }

  it('isTextContentType never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const result = isTextContentType(ct);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('isImageContentType never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const result = isImageContentType(ct);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('all text/* types are recognized as text', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9._-]{1,30}$/),
        (subtype) => {
          expect(isTextContentType(`text/${subtype}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('all image/* types are recognized as image', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9._+-]{1,30}$/),
        (subtype) => {
          expect(isImageContentType(`image/${subtype}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('text and image are mutually exclusive', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const isText = isTextContentType(ct);
        const isImage = isImageContentType(ct);
        // A content type cannot be both text and image
        expect(isText && isImage).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('known application/* text types are recognized', () => {
    const textAppTypes = [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/toml',
      'application/x-sh',
    ];
    for (const ct of textAppTypes) {
      expect(isTextContentType(ct)).toBe(true);
    }
  });

  it('unknown application/* types are not recognized as text', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,20}$/).filter(
          (s) => !['json', 'xml', 'javascript', 'typescript', 'x-yaml', 'toml', 'x-sh'].includes(s),
        ),
        (subtype) => {
          expect(isTextContentType(`application/${subtype}`)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('non-image non-text types return false for both', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('audio/', 'video/', 'font/', 'model/', 'multipart/'),
        fc.stringMatching(/^[a-z0-9._+-]{1,20}$/),
        (prefix, subtype) => {
          const ct = prefix + subtype;
          expect(isTextContentType(ct)).toBe(false);
          expect(isImageContentType(ct)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Session mode - agent config filtering invariants
// ---------------------------------------------------------------------------
describe('Session mode config filtering', () => {
  it('filtering by any valid mode always returns non-empty', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('default' as const, 'advanced' as const),
        (mode) => {
          const configs = getConfigsForMode(mode);
          expect(configs.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('"advanced" filtered count >= "default" filtered count', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const defaultCount = getConfigsForMode('default').length;
          const advancedCount = getConfigsForMode('advanced').length;
          expect(advancedCount).toBeGreaterThanOrEqual(defaultCount);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('getPreseedKeysNotInMode("advanced", true) is always empty', () => {
    // contextModeEnabled=true: full advanced set is in scope, nothing to clean up.
    // The default for the optional flag is false (fail-closed for tier gating),
    // so omitting it would correctly flag context-mode keys for cleanup; pass
    // true here to assert the "advanced superset" property explicitly.
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          expect(getPreseedKeysNotInMode('advanced', true)).toEqual([]);
        },
      ),
      { numRuns: 10 },
    );
  });
});