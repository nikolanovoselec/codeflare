import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { getPrewarmConfig } from '../prewarm-config.js';
import { createActivityTracker } from '../activity-tracker.js';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000', 10);

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

// ─── 2. Activity tracker state machine ──────────────────────────────────

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
