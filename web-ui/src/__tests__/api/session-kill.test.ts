import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as client from '../../api/client';
import { ApiError } from '../../api/fetch-helper';

// Access the planned public API only inside test execution: the RED suite must
// collect before killSession is implemented, not fail on a missing named export.
function killSession(id: string): Promise<void> {
  return (client as typeof client & { killSession: (id: string) => Promise<void> }).killSession(id);
}

describe('REQ-SESSION-038 AC2: KILL HTTP contract', () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let respond: () => Promise<Response>;

  beforeEach(() => {
    requests.length = 0;
    respond = async () => new Response(null, { status: 204 });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond();
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['', '{"success":true}'])(
    'POSTs only to the addressed kill endpoint with existing cookie/CSRF protections and resolves success (%s)', async body => {
      respond = async () => new Response(body, { status: 200 });
      await expect(killSession('session123abc')).resolves.toBeUndefined();
      // Intentional HTTP wire contract, paired with successful public API result.
      expect(requests).toEqual([{
        url: '/api/sessions/session123abc/kill',
        init: expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'manual',
          headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
        }),
      }]);
    },
  );

  it.each(['../other123', 'short', 'INVALID123', 'session123abc/stop', ''])(
    'rejects invalid session identity %j before any HTTP mutation', async id => {
      await expect(killSession(id)).rejects.toMatchObject({
        status: 400,
        message: 'Invalid session ID format',
      });
      expect(requests).toEqual([]);
    },
  );

  it.each([403, 409, 503])('surfaces HTTP %s failure rather than reporting success, and permits retry', async status => {
    respond = async () => Response.json({ error: 'KILL exit is not confirmed' }, { status });
    await expect(killSession('session123abc')).rejects.toMatchObject({
      status,
      message: 'KILL exit is not confirmed',
    });
    respond = async () => new Response(null, { status: 204 });
    await expect(killSession('session123abc')).resolves.toBeUndefined();
    expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
      ['POST', '/api/sessions/session123abc/kill'],
      ['POST', '/api/sessions/session123abc/kill'],
    ]);
  });

  it('rejects ambiguous network loss and lets the caller retry the same session', async () => {
    respond = async () => { throw new TypeError('Connection lost before confirmation'); };
    await expect(killSession('session123abc')).rejects.toThrow('Connection lost before confirmation');
    respond = async () => new Response(null, { status: 204 });
    await expect(killSession('session123abc')).resolves.toBeUndefined();
    expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
      ['POST', '/api/sessions/session123abc/kill'],
      ['POST', '/api/sessions/session123abc/kill'],
    ]);
  });

  it('preserves existing authentication-expiry handling for an Access redirect', async () => {
    respond = async () => new Response(null, { status: 302 });
    const result = killSession('session123abc');
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(requests).toEqual([{
      url: '/api/sessions/session123abc/kill',
      init: expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'manual' }),
    }]);
  });
});
