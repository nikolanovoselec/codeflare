import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Behavioral tests for SessionManager.
 *
 * SessionManager delegates PTY lifecycle to Session objects. Here we
 * mock the Session class so tests run without node-pty / xterm and
 * focus on the map-management, cap-checking, and prewarm-adoption logic.
 */

// ── Fake Session used by all tests ──────────────────────────────────
class FakeSession {
  constructor(id, name, manual) {
    this.id = id;
    this.name = name;
    this.manual = manual;
    this.clients = new Set();
    this.ptyProcess = { pid: 999 };
    this.orphanTimeout = null;
    this._killed = false;
  }
  isPtyAlive() { return this.ptyProcess !== null; }
  kill() { this._killed = true; this.ptyProcess = null; }
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      pid: this.ptyProcess?.pid ?? null,
      clients: this.clients.size,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
      disconnectedAt: null,
      ptyAlive: this.isPtyAlive(),
    };
  }
}

// Mock the session module so SessionManager uses FakeSession
mock.module('../dist/session.js', {
  namedExports: { Session: FakeSession },
});

// Import *after* mock is registered so the mock takes effect
const { SessionManager, PREWARM_SESSION_ID } = await import('../dist/session-manager.js');

describe('SessionManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new SessionManager({ maxSessions: 3 });
  });

  // ── getOrCreate ────────────────────────────────────────────────────

  describe('getOrCreate()', () => {
    it('returns existing session when session ID matches', () => {
      const first = mgr.getOrCreate('sess-1', 'Terminal');
      const second = mgr.getOrCreate('sess-1', 'Terminal');
      assert.equal(first, second, 'should return the same object reference');
      assert.equal(mgr.size, 1, 'map should still have one entry');
    });

    it('returns null when activeCount >= maxSessions (session cap)', () => {
      mgr.getOrCreate('a-1', 'T1');
      mgr.getOrCreate('b-2', 'T2');
      mgr.getOrCreate('c-3', 'T3');
      const capped = mgr.getOrCreate('d-4', 'T4');
      assert.equal(capped, null, 'should be null when cap is reached');
      assert.equal(mgr.size, 3, 'should not have grown past maxSessions');
    });

    it('adopts PREWARM_SESSION_ID for terminal "-1"', () => {
      // Manually plant a prewarm session in the map
      const prewarm = new FakeSession(PREWARM_SESSION_ID, 'prewarm', false);
      mgr.sessions.set(PREWARM_SESSION_ID, prewarm);

      // Request a session whose terminal suffix is "1"
      const adopted = mgr.getOrCreate('user-1', 'Terminal');
      assert.equal(adopted, prewarm, 'should return the pre-warmed session object');
      assert.equal(adopted.id, 'user-1', 'adopted session id should be updated');
      assert.equal(mgr.sessions.has(PREWARM_SESSION_ID), false, 'prewarm key should be removed');
      assert.equal(mgr.sessions.has('user-1'), true, 'new key should exist');
    });

    it('does not adopt prewarm for terminal IDs other than "1"', () => {
      const prewarm = new FakeSession(PREWARM_SESSION_ID, 'prewarm', false);
      mgr.sessions.set(PREWARM_SESSION_ID, prewarm);

      const session = mgr.getOrCreate('user-2', 'Terminal');
      assert.notEqual(session, prewarm, 'should create a new session, not adopt prewarm');
      assert.equal(mgr.sessions.has(PREWARM_SESSION_ID), true, 'prewarm should still exist');
    });

    it('prewarm sessions are excluded from cap count', () => {
      // Plant a prewarm session — it should not count toward the cap
      mgr.sessions.set(PREWARM_SESSION_ID, new FakeSession(PREWARM_SESSION_ID, 'pw', false));

      mgr.getOrCreate('a-2', 'T1');
      mgr.getOrCreate('b-2', 'T2');
      mgr.getOrCreate('c-2', 'T3');
      // 3 real + 1 prewarm = 4 in map, but only 3 count toward cap
      assert.equal(mgr.size, 4);
      const fourth = mgr.getOrCreate('d-2', 'T4');
      assert.equal(fourth, null, 'cap should trigger at 3 real sessions');
    });

    it('clears orphanTimeout on adopted prewarm session', () => {
      const prewarm = new FakeSession(PREWARM_SESSION_ID, 'prewarm', false);
      prewarm.orphanTimeout = setTimeout(() => {}, 99999);
      mgr.sessions.set(PREWARM_SESSION_ID, prewarm);

      const adopted = mgr.getOrCreate('user-1', 'Terminal');
      assert.equal(adopted.orphanTimeout, null, 'orphanTimeout should be cleared');
    });
  });

  // ── cleanupDeadSessions ────────────────────────────────────────────

  describe('cleanupDeadSessions()', () => {
    it('removes only dead sessions (no PTY and no clients)', () => {
      const alive = new FakeSession('alive', 'T', false);
      alive.ptyProcess = { pid: 1 };

      const dead = new FakeSession('dead', 'T', false);
      dead.ptyProcess = null; // PTY dead
      dead.clients = new Set(); // no clients

      const hasClients = new FakeSession('has-clients', 'T', false);
      hasClients.ptyProcess = null;
      hasClients.clients = new Set(['ws1']); // still has a client

      mgr.sessions.set('alive', alive);
      mgr.sessions.set('dead', dead);
      mgr.sessions.set('has-clients', hasClients);

      mgr.cleanupDeadSessions();

      assert.equal(mgr.sessions.has('alive'), true, 'alive session should remain');
      assert.equal(mgr.sessions.has('dead'), false, 'dead session should be removed');
      assert.equal(mgr.sessions.has('has-clients'), true, 'session with clients should remain');
    });

    it('does nothing when all sessions are alive', () => {
      mgr.getOrCreate('a-2', 'T');
      mgr.getOrCreate('b-2', 'T');
      mgr.cleanupDeadSessions();
      assert.equal(mgr.size, 2, 'no sessions should be removed');
    });
  });

  // ── delete ─────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes session from active map and kills it', () => {
      const session = mgr.getOrCreate('sess-1', 'Terminal');
      const result = mgr.delete('sess-1');
      assert.equal(result, true, 'delete should return true');
      assert.equal(mgr.sessions.has('sess-1'), false, 'session should be gone from map');
      assert.equal(session._killed, true, 'kill() should have been called');
    });

    it('returns false for unknown session ID', () => {
      const result = mgr.delete('nonexistent');
      assert.equal(result, false, 'delete should return false for unknown ID');
    });
  });
});
