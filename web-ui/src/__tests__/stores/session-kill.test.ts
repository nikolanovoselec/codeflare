import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Like session.test.ts, model the mounted runtime through the terminal store's
// public ownership behavior. Hoisted factory state is initialized before imports.
const runtime = vi.hoisted(() => ({ ownedSessionIds: new Set<string>() }));
vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    dispose: vi.fn(),
    disposeSession: (id: string) => { runtime.ownedSessionIds.delete(id); },
    ownsSession: (id: string) => runtime.ownedSessionIds.has(id),
    triggerLayoutResize: vi.fn(),
    registerSessionStoppedCallback: vi.fn(),
  },
  sendInputToTerminal: vi.fn(() => false),
  registerProcessNameCallback: vi.fn(),
}));
vi.mock('../../api/storage', () => ({
  recreateAgentConfigs: vi.fn().mockResolvedValue({ success: true, written: [], skipped: [], deleted: [], warnings: [] }),
  upgradeAgentConfigs: vi.fn().mockResolvedValue({ success: true, written: [], skipped: [], deleted: [], warnings: [] }),
}));
vi.mock('../../lib/vault-cache', () => ({
  cleanupSessionVaultCache: vi.fn().mockResolvedValue(undefined),
  sweepOrphanVaultCaches: vi.fn().mockResolvedValue(undefined),
}));

import { sessionStore } from '../../stores/session';
import { terminalStore } from '../../stores/terminal';
import { STOP_POLL_INTERVAL_MS } from '../../lib/constants';

type Lifecycle = 'starting' | 'running' | 'unreachable' | 'stopping' | 'stopped';
type Projection = { status: Lifecycle; lifecycle: Lifecycle; generation: number; revision: number };
const target = 'killtest01';
const other = 'otherlive01';
const killPath = `/api/sessions/${target}/kill`;
const stopPath = `/api/sessions/${target}/stop`;

// No new named export or planned method is accessed during collection.
function killSession(id: string): Promise<void> {
  return (sessionStore as typeof sessionStore & { killSession: (id: string) => Promise<void> }).killSession(id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('REQ-SESSION-038: session KILL through the public store and HTTP boundary', () => {
  let projections: Record<string, Projection>;
  let mutations: Array<{ method: string; path: string }>;
  let replyToKill: () => Promise<Response>;
  let replyToStop: () => Promise<Response>;
  let replyToStatus: () => Promise<Response>;

  function project(id: string, status: Lifecycle, revision: number) {
    projections[id] = { status, lifecycle: status, generation: 4, revision };
  }

  function row(id: string) {
    return sessionStore.sessions.find(session => session.id === id);
  }

  function tabs(id: string) {
    return sessionStore.getTerminalsForSession(id)?.tabs.map(tab => tab.id);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    runtime.ownedSessionIds.clear();
    sessionStore.stopAllPolling();
    sessionStore.stopSessionListPolling();
    sessionStore.setActiveSession(null);
    sessionStore.clearError();
    sessionStore._resetMissCounters();
    sessionStore._resetStartupGuards();
    sessionStore._resetAuthExpired();
    sessionStore._resetManagedCheckState();
    projections = {};
    project(target, 'running', 10);
    project(other, 'running', 10);
    mutations = [];
    replyToKill = async () => new Response(null, { status: 204 });
    replyToStop = async () => new Response(null, { status: 204 });
    replyToStatus = async () => Response.json({ statuses: projections });

    // Real client parsing and mutation requests; no mocked client exports or
    // private cleanup spies. Wire assertions below protect command semantics.
    let listedSessionIds: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET') mutations.push({ method, path: url });
      if (url === killPath && method === 'POST') return replyToKill();
      if (url === stopPath && method === 'POST') return replyToStop();
      if (url === '/api/sessions/batch-status' && method === 'GET') return replyToStatus();
      if (url === '/api/sessions/ancillary-status' && method === 'GET') return Response.json({ maxSessions: 3 });
      if (url === '/api/sessions' && method === 'GET') {
        return Response.json({ sessions: listedSessionIds.map(id => ({
          id,
          name: id === target ? 'Retained workspace' : 'Other session',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastAccessedAt: '2026-01-01T00:00:00.000Z',
          workspace: 'terminal',
          terminalMode: 'classic',
          ...projections[id],
        })) });
      }
      throw Error(`Unexpected session HTTP request: ${method} ${url}`);
    });
    // Clear prior ordered projections before reusing these fixture identities.
    await sessionStore.loadSessions();
    listedSessionIds = [target, other];
    await sessionStore.loadSessions();
    sessionStore.initializeTerminalsForSession(target);
    sessionStore.initializeTerminalsForSession(other);
    runtime.ownedSessionIds.add(target);
    runtime.ownedSessionIds.add(other);
    sessionStore.setActiveSession(target);
  });

  afterEach(() => {
    sessionStore.stopAllPolling();
    sessionStore.stopSessionListPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['starting', 'running', 'unreachable', 'stopping'] as const)(
    'AC4/AC7: retains the %s row and runtime until newer authoritative stopped evidence', async status => {
      project(target, status, 11);
      await sessionStore.loadSessions();
      const originalTabs = tabs(target);
      const otherTabs = tabs(other);
      const killing = killSession(target);
      await vi.advanceTimersByTimeAsync(0);

      expect(mutations).toEqual([{ method: 'POST', path: killPath }]);
      expect(row(target)).toMatchObject({ id: target, name: 'Retained workspace', workspace: 'terminal', terminalMode: 'classic' });
      expect(row(target)?.status).not.toBe('stopped');
      expect(terminalStore.ownsSession?.(target)).toBe(true);
      expect(tabs(target)).toEqual(originalTabs);

      project(target, 'stopping', 12);
      await sessionStore.refreshSessionStatuses();
      expect(row(target)).toMatchObject({ status: 'stopping', lifecycle: 'stopping', generation: 4, revision: 12 });
      expect(terminalStore.ownsSession?.(target)).toBe(true);

      // A stale stopped response must not dispose the accepted generation.
      project(target, 'stopped', 10);
      await sessionStore.refreshSessionStatuses();
      expect(row(target)).toMatchObject({ status: 'stopping', revision: 12 });
      expect(terminalStore.ownsSession?.(target)).toBe(true);

      project(target, 'stopped', 13);
      await sessionStore.refreshSessionStatuses();
      await killing;
      expect(row(target)).toMatchObject({
        id: target, name: 'Retained workspace', workspace: 'terminal', terminalMode: 'classic',
        status: 'stopped', lifecycle: 'stopped', generation: 4, revision: 13,
      });
      expect(sessionStore.activeSessionId).toBe(target);
      expect(tabs(target)).toEqual(originalTabs);
      expect(terminalStore.ownsSession?.(target)).toBe(false);
      expect(row(other)).toMatchObject({ status: 'running', revision: 10 });
      expect(tabs(other)).toEqual(otherTabs);
      expect(terminalStore.ownsSession?.(other)).toBe(true);
      expect(mutations).toEqual([{ method: 'POST', path: killPath }]);
    },
  );

  it.each(['HTTP caller', 'confirmation poll'] as const)(
    'AC2/AC4/AC6/AC7: suppresses duplicate KILL submissions without waiting for the Stop %s', async phase => {
      const stopReply = deferred<Response>();
      const killReply = deferred<Response>();
      replyToStop = () => stopReply.promise;
      replyToKill = () => killReply.promise;
      const stopping = sessionStore.stopSession(target);
      try {
        if (phase === 'confirmation poll') {
          stopReply.resolve(new Response(null, { status: 204 }));
          await vi.advanceTimersByTimeAsync(STOP_POLL_INTERVAL_MS);
          expect(row(target)?.status).toBe('stopping');
        }
        const killing = killSession(target);
        const duplicate = killSession(target);
        await vi.advanceTimersByTimeAsync(0);
        // Intentional wire sequence: Stop may remain unresolved, but exactly one
        // KILL command reaches this generation, and neither command deletes it.
        expect(mutations).toEqual([
          { method: 'POST', path: stopPath },
          { method: 'POST', path: killPath },
        ]);
        expect(row(target)?.status).not.toBe('stopped');
        expect(terminalStore.ownsSession?.(target)).toBe(true);

        killReply.resolve(new Response(null, { status: 204 }));
        await vi.advanceTimersByTimeAsync(0);
        project(target, 'stopped', 12);
        // Ordinary authoritative refresh must work even while Stop's HTTP caller
        // is still waiting; local Stop ownership must not mask KILL confirmation.
        await sessionStore.refreshSessionStatuses();
        expect(row(target)).toMatchObject({ id: target, status: 'stopped', generation: 4, revision: 12 });
        expect(terminalStore.ownsSession?.(target)).toBe(false);
        expect(sessionStore.getTerminalsForSession(target)).not.toBeNull();
        await Promise.all([killing, duplicate]);
      } finally {
        killReply.resolve(new Response(null, { status: 204 }));
        stopReply.resolve(new Response(null, { status: 204 }));
        await vi.advanceTimersByTimeAsync(STOP_POLL_INTERVAL_MS);
        // Settle the existing Stop poll even when a RED assertion fails before
        // confirmation is supplied; teardown must not turn it into a timeout.
        sessionStore.stopAllPolling();
        await stopping;
      }
      expect(row(target)).toMatchObject({ id: target, status: 'stopped' });
      expect(row(other)?.status).toBe('running');
      expect(mutations).toEqual([
        { method: 'POST', path: stopPath },
        { method: 'POST', path: killPath },
      ]);
    },
  );

  it.each(['failed', 'ambiguous'] as const)(
    'AC4/AC5/AC7: a %s KILL shows failure, preserves the session/runtime and permits same-session retry', async outcome => {
      const originalTabs = tabs(target);
      replyToKill = outcome === 'failed'
        ? async () => Response.json({ error: 'Force exit could not be confirmed' }, { status: 503 })
        : async () => { throw new TypeError('Connection lost before force-exit confirmation'); };
      await killSession(target);
      expect(sessionStore.error).toContain(outcome === 'failed' ? 'Force exit could not be confirmed' : 'Connection lost');
      expect(row(target)).toMatchObject({ id: target, name: 'Retained workspace' });
      expect(row(target)?.status).not.toBe('stopped');
      expect(terminalStore.ownsSession?.(target)).toBe(true);
      expect(tabs(target)).toEqual(originalTabs);

      project(target, 'stopping', 11);
      await sessionStore.refreshSessionStatuses();
      expect(row(target)).toMatchObject({ status: 'stopping', generation: 4, revision: 11 });
      expect(terminalStore.ownsSession?.(target)).toBe(true);
      sessionStore.clearError();
      replyToKill = async () => new Response(null, { status: 204 });
      const retry = killSession(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(mutations).toEqual([
        { method: 'POST', path: killPath },
        { method: 'POST', path: killPath },
      ]);
      expect(row(target)?.status).not.toBe('stopped');
      expect(terminalStore.ownsSession?.(target)).toBe(true);
      project(target, 'stopped', 12);
      await sessionStore.refreshSessionStatuses();
      await retry;
      expect(row(target)).toMatchObject({ id: target, status: 'stopped', generation: 4, revision: 12 });
      expect(tabs(target)).toEqual(originalTabs);
      expect(terminalStore.ownsSession?.(target)).toBe(false);
      expect(row(other)?.status).toBe('running');
    },
  );

  it('AC4/AC7: accepted KILL with missing or unavailable status does not invent stopped or delete the mounted session', async () => {
    const originalTabs = tabs(target);
    const killing = killSession(target);
    await vi.advanceTimersByTimeAsync(0);
    replyToStatus = async () => Response.json({ statuses: { [other]: projections[other] } });
    for (let attempt = 0; attempt < 3; attempt++) await sessionStore.refreshSessionStatuses();
    expect(row(target)).toMatchObject({ id: target, name: 'Retained workspace' });
    expect(row(target)?.status).not.toBe('stopped');
    expect(terminalStore.ownsSession?.(target)).toBe(true);
    expect(tabs(target)).toEqual(originalTabs);

    replyToStatus = async () => { throw new TypeError('Status temporarily unavailable'); };
    await sessionStore.refreshSessionStatuses();
    expect(row(target)?.status).not.toBe('stopped');
    expect(terminalStore.ownsSession?.(target)).toBe(true);
    project(target, 'stopped', 12);
    replyToStatus = async () => Response.json({ statuses: projections });
    await sessionStore.refreshSessionStatuses();
    await killing;
    expect(row(target)).toMatchObject({ id: target, status: 'stopped', generation: 4, revision: 12 });
    expect(terminalStore.ownsSession?.(target)).toBe(false);
    expect(tabs(target)).toEqual(originalTabs);
    expect(mutations).toEqual([{ method: 'POST', path: killPath }]);
  });
});
