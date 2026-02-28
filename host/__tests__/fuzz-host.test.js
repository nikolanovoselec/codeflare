import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';

import { getPrewarmConfig } from '../prewarm-config.js';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000', 10);

// ─── Replicated functions from server.js ───────────────────────────────

const MAX_CONTROL_MSG_LENGTH = 200;

/**
 * Replicates WS message classification from server.js:357-384.
 * Length-gated JSON parse: only attempts parse on short strings starting with '{'.
 */
function classifyWsMessage(data) {
  if (typeof data === 'string' && data.length < MAX_CONTROL_MSG_LENGTH && data.startsWith('{')) {
    try {
      return { type: 'json', parsed: JSON.parse(data) };
    } catch {
      return { type: 'raw' };
    }
  }
  return { type: 'raw' };
}

/**
 * Replicates resize validation from server.js:368-370.
 */
function isValidResize(cols, rows) {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    cols > 0 &&
    cols < 10000 &&
    rows > 0 &&
    rows < 10000
  );
}

/**
 * Replicates safeTokenCompare from server.js:141-148.
 * Timing-safe comparison using Buffer lengths (not string lengths).
 */
function safeTokenCompare(provided, expected) {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// ─── 1. getPrewarmConfig ───────────────────────────────────────────────

describe('fuzz: getPrewarmConfig', () => {
  it('returns { command: null } for non-array / empty inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(''), fc.integer(), fc.object()),
        (input) => {
          const result = getPrewarmConfig(input);
          assert.deepStrictEqual(result, { command: null });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('extracts first word of tab 1 command', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^\S+$/.test(s)),
        fc.string({ minLength: 0, maxLength: 30 }),
        (cmd, args) => {
          const fullCommand = args.length > 0 ? `${cmd} ${args}` : cmd;
          const config = [{ id: '1', command: fullCommand, label: 'test' }];
          const result = getPrewarmConfig(config);
          assert.equal(result.command, cmd);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles tabs with empty command strings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', undefined, null),
        (cmd) => {
          const config = [{ id: '1', command: cmd, label: 'test' }];
          const result = getPrewarmConfig(config);
          assert.deepStrictEqual(result, { command: null });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any input', () => {
    const tabEntry = fc.record({
      id: fc.string({ minLength: 0, maxLength: 5 }),
      command: fc.string({ minLength: 0, maxLength: 30 }),
      label: fc.string({ minLength: 0, maxLength: 20 }),
    });
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.constant(''),
          fc.integer(),
          fc.object(),
          fc.array(tabEntry, { minLength: 0, maxLength: 5 }),
        ),
        (input) => {
          getPrewarmConfig(input); // must not throw
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 2. WS message classification (replicated) ────────────────────────

describe('fuzz: classifyWsMessage', () => {
  it('strings >= 200 chars are always raw even if valid JSON', () => {
    fc.assert(
      fc.property(
        fc.json().filter((s) => s.length < 180),
        (json) => {
          const padded = json + ' '.repeat(MAX_CONTROL_MSG_LENGTH - json.length + 1);
          assert.ok(padded.length >= MAX_CONTROL_MSG_LENGTH);
          const result = classifyWsMessage(padded);
          assert.equal(result.type, 'raw');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('strings not starting with { are always raw', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.startsWith('{')),
        (str) => {
          const result = classifyWsMessage(str);
          assert.equal(result.type, 'raw');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('valid JSON < 200 chars starting with { is classified as json', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue(), {
          minKeys: 1,
          maxKeys: 3,
        }),
        (obj) => {
          const str = JSON.stringify(obj);
          if (str.length < MAX_CONTROL_MSG_LENGTH && str.startsWith('{')) {
            const result = classifyWsMessage(str);
            assert.equal(result.type, 'json');
            assert.equal(JSON.stringify(result.parsed), str);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        classifyWsMessage(input); // must not throw
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 3. Resize validation (replicated) ────────────────────────────────

describe('fuzz: isValidResize', () => {
  it('accepts cols and rows in 1-9999', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 9999 }),
        (cols, rows) => {
          assert.equal(isValidResize(cols, rows), true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects 0, negative, >= 10000, NaN, and non-numbers', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(0),
          fc.constant(-1),
          fc.constant(10000),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.string(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        fc.integer({ min: 1, max: 9999 }),
        (bad, good) => {
          assert.equal(isValidResize(bad, good), false);
          assert.equal(isValidResize(good, bad), false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (a, b) => {
        isValidResize(a, b); // must not throw
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 4. safeTokenCompare (replicated) ──────────────────────────────────

describe('fuzz: safeTokenCompare', () => {
  it('returns true only for identical strings', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (token) => {
        assert.equal(safeTokenCompare(token, token), true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns false for different-length strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (a, b) => {
          if (Buffer.from(a).length !== Buffer.from(b).length) {
            assert.equal(safeTokenCompare(a, b), false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any string inputs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        safeTokenCompare(a, b); // must not throw
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
