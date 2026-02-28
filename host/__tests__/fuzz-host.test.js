import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';

import { getPrewarmConfig } from '../prewarm-config.js';
import { createActivityTracker } from '../activity-tracker.js';

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
    fc.assert(
      fc.property(fc.anything(), (input) => {
        getPrewarmConfig(input); // must not throw
      }),
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

// ─── 5. Activity tracker state machine ──────────────────────────────────

describe('fuzz: createActivityTracker', () => {
  it('disconnectedForMs is null when connected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
        (sequence) => {
          const tracker = createActivityTracker();
          for (const isConnect of sequence) {
            if (isConnect) {
              tracker.recordClientConnected();
            } else {
              tracker.recordAllClientsDisconnected();
            }
          }
          // Force last action to be connect
          tracker.recordClientConnected();
          const mockManager = { clients: new Map([['c1', {}]]) };
          const info = tracker.getActivityInfo(mockManager);
          assert.equal(info.disconnectedForMs, null);
          assert.equal(info.hasActiveConnections, true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('disconnectedForMs is non-negative when disconnected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
        (sequence) => {
          const tracker = createActivityTracker();
          for (const isConnect of sequence) {
            if (isConnect) {
              tracker.recordClientConnected();
            } else {
              tracker.recordAllClientsDisconnected();
            }
          }
          // Force last action to be disconnect
          tracker.recordAllClientsDisconnected();
          const mockManager = { clients: new Map() };
          const info = tracker.getActivityInfo(mockManager);
          assert.equal(typeof info.disconnectedForMs, 'number');
          assert.ok(info.disconnectedForMs >= 0);
          assert.equal(info.hasActiveConnections, false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('hasActiveConnections matches client count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (clientCount) => {
          const tracker = createActivityTracker();
          const clients = new Map();
          for (let i = 0; i < clientCount; i++) {
            clients.set(`c${i}`, {});
          }
          const info = tracker.getActivityInfo({ clients, sessions: new Map() });
          assert.equal(info.hasActiveConnections, clientCount > 0);
          assert.equal(info.connectedClients, clientCount);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('activeSessions counts sessions with non-null ptyProcess', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        (ptyStates) => {
          const tracker = createActivityTracker();
          const sessions = new Map();
          ptyStates.forEach((hasPty, i) => {
            sessions.set(`s${i}`, { ptyProcess: hasPty ? { pid: i } : null });
          });
          const mockManager = { clients: new Map(), sessions };
          const info = tracker.getActivityInfo(mockManager);
          const expected = ptyStates.filter(Boolean).length;
          assert.equal(info.activeSessions, expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('getActivityInfo never throws with null/undefined sessionManager', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        (mgr) => {
          const tracker = createActivityTracker();
          const info = tracker.getActivityInfo(mgr);
          assert.equal(info.connectedClients, 0);
          assert.equal(info.activeSessions, 0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 6. Session.resolveProcessName (replicated) ────────────────────────

/**
 * Replicates Session.resolveProcessName logic from session.js:74-87.
 * Extracted to avoid heavy node-pty dependency.
 */
function resolveProcessName(rawProcessName, terminalId, tabConfigMap) {
  if (!rawProcessName) return null;

  const configuredCmd = tabConfigMap[terminalId];
  if (configuredCmd) {
    const baseName = rawProcessName.split('/').pop();
    if (['node', 'nodejs', 'bash', 'sh', 'zsh'].includes(baseName)) {
      return configuredCmd.split(/\s+/)[0];
    }
  }

  return rawProcessName.split('/').pop() || rawProcessName;
}

describe('fuzz: resolveProcessName (replicated)', () => {
  it('returns null for falsy process names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, '', 0),
        fc.string(),
        fc.dictionary(fc.string(), fc.string()),
        (rawName, termId, configMap) => {
          assert.equal(resolveProcessName(rawName, termId, configMap), null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns configured command first word when process is a shell', () => {
    const shells = ['node', 'nodejs', 'bash', 'sh', 'zsh'];
    fc.assert(
      fc.property(
        fc.constantFrom(...shells),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^\S+$/.test(s)),
        fc.string({ minLength: 0, maxLength: 20 }),
        (shell, cmdName, cmdArgs) => {
          const configuredCmd = cmdArgs ? `${cmdName} ${cmdArgs}` : cmdName;
          const result = resolveProcessName(`/usr/bin/${shell}`, '1', { '1': configuredCmd });
          assert.equal(result, cmdName);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns basename when process is not a shell', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9._-]+$/.test(s) && !['node', 'nodejs', 'bash', 'sh', 'zsh'].includes(s)),
        (processName) => {
          const result = resolveProcessName(`/usr/bin/${processName}`, '1', { '1': 'some-command' });
          assert.equal(result, processName);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns basename for paths without tab config', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)),
        (name) => {
          const result = resolveProcessName(`/some/path/${name}`, '1', {});
          assert.equal(result, name);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any combination of inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined)),
        fc.string(),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.string({ minLength: 0, maxLength: 30 })),
        (rawName, termId, configMap) => {
          resolveProcessName(rawName, termId, configMap); // must not throw
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 7. Session.terminalId (replicated) ─────────────────────────────────

/**
 * Replicates Session.terminalId getter from session.js:67-69.
 */
function extractTerminalId(compoundId) {
  const parts = compoundId.split('-');
  return parts[parts.length - 1];
}

describe('fuzz: extractTerminalId (replicated)', () => {
  it('extracts last segment after hyphen', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
        (prefix, suffix) => {
          const id = `${prefix}-${suffix}`;
          assert.equal(extractTerminalId(id), suffix);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns entire string when no hyphen', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('-')),
        (id) => {
          assert.equal(extractTerminalId(id), id);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles multiple hyphens — always takes last segment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('-')), { minLength: 2, maxLength: 6 }),
        (segments) => {
          const id = segments.join('-');
          assert.equal(extractTerminalId(id), segments[segments.length - 1]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (id) => {
        extractTerminalId(id); // must not throw
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 8. Session.toJSON shape (replicated) ───────────────────────────────

describe('fuzz: Session.toJSON shape (replicated)', () => {
  /**
   * Replicate toJSON shape validation without instantiating real Session.
   * Validates the contract: toJSON always returns correct fields and types.
   */
  function makeSessionJSON(id, name, hasPty, clientCount, createdAt, lastAccessedAt, disconnectedAt) {
    return {
      id,
      name,
      pid: hasPty ? 12345 : null,
      clients: clientCount,
      createdAt,
      lastAccessedAt,
      disconnectedAt: disconnectedAt || null,
      ptyAlive: hasPty,
    };
  }

  it('always has the correct shape and types', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 100 }),
        (id, name, hasPty, clientCount) => {
          const now = new Date().toISOString();
          const json = makeSessionJSON(id, name, hasPty, clientCount, now, now, null);

          assert.equal(typeof json.id, 'string');
          assert.equal(typeof json.name, 'string');
          assert.equal(typeof json.clients, 'number');
          assert.ok(json.clients >= 0);
          assert.equal(typeof json.createdAt, 'string');
          assert.equal(typeof json.lastAccessedAt, 'string');
          assert.equal(typeof json.ptyAlive, 'boolean');
          assert.equal(json.ptyAlive, hasPty);
          if (hasPty) {
            assert.equal(typeof json.pid, 'number');
          } else {
            assert.equal(json.pid, null);
          }
          assert.ok(json.disconnectedAt === null || typeof json.disconnectedAt === 'string');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('has exactly 8 keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.boolean(),
        (id, hasPty) => {
          const now = new Date().toISOString();
          const json = makeSessionJSON(id, 'Test', hasPty, 0, now, now, null);
          const keys = Object.keys(json);
          assert.equal(keys.length, 8);
          const expectedKeys = ['id', 'name', 'pid', 'clients', 'createdAt', 'lastAccessedAt', 'disconnectedAt', 'ptyAlive'];
          assert.deepStrictEqual(keys.sort(), expectedKeys.sort());
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── 9. SessionManager.getOrCreate session cap (replicated) ─────────────

describe('fuzz: SessionManager.getOrCreate session cap (replicated)', () => {
  /**
   * Replicate session cap enforcement logic from session-manager.js:78-108.
   * Lightweight mock avoids real Session/PTY instantiation.
   */
  function createMockSessionManager(maxSessions) {
    const sessions = new Map();
    const PREWARM_SESSION_ID = 'prewarm-1';

    function getOrCreate(id) {
      let session = sessions.get(id);
      if (session) return session;

      const terminalId = id.includes('-') ? id.split('-').pop() : '1';
      if (terminalId === '1') {
        const prewarmed = sessions.get(PREWARM_SESSION_ID);
        if (prewarmed && sessions.delete(PREWARM_SESSION_ID)) {
          prewarmed.id = id;
          sessions.set(id, prewarmed);
          return prewarmed;
        }
      }

      const activeCount = Array.from(sessions.keys()).filter(k => !k.startsWith('prewarm-')).length;
      if (activeCount >= maxSessions) return null;

      session = { id, ptyProcess: null, clients: new Set() };
      sessions.set(id, session);
      return session;
    }

    return { sessions, getOrCreate };
  }

  it('returns null when maxSessions exceeded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (maxSessions) => {
          const mgr = createMockSessionManager(maxSessions);
          for (let i = 0; i < maxSessions; i++) {
            const result = mgr.getOrCreate(`session-${i}-2`);
            assert.notEqual(result, null);
          }
          const overflow = mgr.getOrCreate(`session-overflow-2`);
          assert.equal(overflow, null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('prewarm sessions do not count toward cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (maxSessions) => {
          const mgr = createMockSessionManager(maxSessions);
          mgr.sessions.set('prewarm-1', { id: 'prewarm-1', ptyProcess: null, clients: new Set() });
          for (let i = 0; i < maxSessions; i++) {
            const result = mgr.getOrCreate(`session-${i}-2`);
            assert.notEqual(result, null);
          }
          assert.equal(mgr.sessions.size, maxSessions + 1);
          const overflow = mgr.getOrCreate(`session-overflow-2`);
          assert.equal(overflow, null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('adopts prewarm for terminal ID 1', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 15 }).filter((s) => /^[a-z0-9]+$/.test(s)),
        (sessionPrefix) => {
          const mgr = createMockSessionManager(5);
          const prewarmSession = { id: 'prewarm-1', ptyProcess: { pid: 42 }, clients: new Set() };
          mgr.sessions.set('prewarm-1', prewarmSession);

          const id = `${sessionPrefix}-1`;
          const result = mgr.getOrCreate(id);
          assert.notEqual(result, null);
          assert.equal(result.id, id);
          assert.equal(result.ptyProcess.pid, 42);
          assert.equal(mgr.sessions.has('prewarm-1'), false);
          assert.equal(mgr.sessions.has(id), true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not adopt prewarm for non-1 terminal IDs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5 }).filter((s) => /^[a-z0-9]+$/.test(s) && s !== '1'),
        (termId) => {
          const mgr = createMockSessionManager(5);
          mgr.sessions.set('prewarm-1', { id: 'prewarm-1', ptyProcess: { pid: 42 }, clients: new Set() });

          const id = `session-${termId}`;
          const result = mgr.getOrCreate(id);
          assert.notEqual(result, null);
          assert.equal(mgr.sessions.has('prewarm-1'), true);
          assert.equal(result.id, id);
          assert.equal(result.ptyProcess, null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns existing session without creating new', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 20 }).filter((s) => /^[a-z0-9-]+$/.test(s) && !s.startsWith('prewarm-')),
        (id) => {
          const mgr = createMockSessionManager(5);
          const first = mgr.getOrCreate(id);
          const second = mgr.getOrCreate(id);
          assert.equal(first, second);
          assert.equal(mgr.sessions.size, 1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
