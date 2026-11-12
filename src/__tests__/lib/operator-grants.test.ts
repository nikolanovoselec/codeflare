import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInvokeOperator, canManageOperator, observeOperatorAccessIdentity, resolveOperatorGroupIdentity } from '../../lib/access';
import { setLogLevel } from '../../lib/logger';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';

const human: VerifiedHumanAccessClaims = { subject: 'human-1', email: 'manager@example.test', issuer: 'https://team.cloudflareaccess.com',
  audiences: ['app'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300, groups: ['stale-group'] };
const empty = { users: [], groups: [] };
const user = { users: [human.email], groups: [] };
const group = { users: [], groups: [{ issuer: human.issuer, id: 'group-1' }] };
const identity = (groups: unknown, extra = {}) => new Response(JSON.stringify({ email: human.email, user_uuid: human.subject, groups, ...extra }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLogLevel('silent');
});

describe('REQ-OPERATOR-063: specific Access 503 classification', () => {
  function captureWarnings() {
    const entries: unknown[] = [];
    setLogLevel('warn');
    vi.spyOn(console, 'warn').mockImplementation((output: string) => {
      const entry = JSON.parse(output);
      // The complete log envelope is a privacy contract, not just selected fields.
      entries.push({ ...entry, timestamp: '<timestamp>' });
    });
    return entries;
  }
  const warning = (classification: string) => ({ timestamp: '<timestamp>', level: 'warn', module: 'access',
    message: 'Operator Access identity unavailable', data: { stage: 'identity', reason: 'http', status: 503, classification } });

  it.each(['1019', '1042'])('classifies exact public error code %s without retaining response data', async code => {
    const entries = captureWarnings();
    vi.stubGlobal('fetch', async () => new Response(`error code: ${code}`, { status: 503,
      headers: { 'set-cookie': 'private-cookie', 'x-private': human.email } }));
    expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual({ status: 'unavailable' });
    expect(entries).toEqual([warning(`cloudflare-${code}`)]);
  });

  it.each([
    'error code: 9999', '', '1019', 'Error 1042',
    JSON.stringify({ error: 'error code: 1019', email: human.email, token: 'private-token' }),
    '<html>error code: 1042 private-token</html>',
    'error code: 1019\nprivate-token',
  ])('leaves unknown or sensitive content unclassified without logging any body or hash: %j', async body => {
    const entries = captureWarnings();
    vi.stubGlobal('fetch', async () => new Response(body, { status: 503 }));
    expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual({ status: 'unavailable' });
    expect(entries).toEqual([warning('unclassified')]);
  });

  it.each(['stream overflow', 'declared overflow', 'broken body'])(
    'preserves original 503 on %s with closed log data', async mode => {
      const entries = captureWarnings();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'broken body') controller.error(new Error('private-token'));
          else controller.enqueue(new TextEncoder().encode('error code: 1019' + 'é'.repeat(4096)));
        },
        cancel() { cancelled = true; },
      });
      vi.stubGlobal('fetch', async () => new Response(body, { status: 503,
        headers: mode === 'declared overflow' ? { 'content-length': '8193' } : {} }));
      expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual({ status: 'unavailable' });
      expect(entries).toEqual([warning('unclassified')]);
      if (mode !== 'broken body') expect(cancelled).toBe(true);
    });

  it('bounds a stalled 503 body by the original fetch deadline', async () => {
    const entries = captureWarnings();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let cancelled = false;
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 503 }));
    const observation = observeOperatorAccessIdentity(human, 'fixture-access-token');
    await Promise.resolve();
    deadline.abort();
    expect(await observation).toEqual({ status: 'unavailable' });
    expect(cancelled).toBe(true);
    expect(entries).toEqual([warning('unclassified')]);
  });

  it.each([false, true])('logging failure cannot replace original 503; broken body=%s', async broken => {
    setLogLevel('warn');
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('private logger failure'); });
    vi.stubGlobal('fetch', async () => new Response(broken ? new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('private body failure')); },
    }) : 'error code: 1019', { status: 503 }));
    expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual({ status: 'unavailable' });
  });

  it('logging OFF preserves 503 and emits nothing', async () => {
    const entries = captureWarnings();
    setLogLevel('silent');
    vi.stubGlobal('fetch', async () => new Response('error code: 1042', { status: 503 }));
    expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual({ status: 'unavailable' });
    expect(entries).toEqual([]);
  });

  it.each([200, 401, 302, 408, 429, 500, 502, 504])('preserves identity/status semantics for HTTP %s', async status => {
    vi.stubGlobal('fetch', async () => status === 200 ? identity([{ id: 'group-1' }])
      : new Response('error code: 1019', { status }));
    expect(await observeOperatorAccessIdentity(human, 'fixture-access-token')).toEqual(status === 200
      ? { status: 'current', groups: ['group-1'] }
      : { status: [401, 302].includes(status) ? 'denied' : 'unavailable' });
  });
});

describe('REQ-OPERATOR-045: independent, current operator grants', () => {
  it('requires global eligibility and scoped ownership, while invocation is independent', () => {
    const grants = { managers: user, invokers: empty };
    expect(canManageOperator(human, grants, user)).toBe(true);
    expect(canManageOperator(human, grants, empty)).toBe(false);
    expect(canManageOperator(human, { managers: empty, invokers: user }, user)).toBe(false);
    expect(canInvokeOperator(human, grants)).toBe(false);
    expect(canInvokeOperator(human, { managers: empty, invokers: user })).toBe(true);
  });
  it('uses live stable IDs, not display names or old signed group claims, and observes revocation', async () => {
    const responses = [identity([{ id: 'group-1', name: 'Operators' }]), identity([]), identity([{ name: 'group-1' }])];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const first = await resolveOperatorGroupIdentity(human, 'fixture-access-token');
    expect(canInvokeOperator(first, { invokers: group })).toBe(true);
    expect(first).not.toHaveProperty('role');
    const revoked = await resolveOperatorGroupIdentity(human, 'fixture-access-token');
    expect(canInvokeOperator(revoked, { invokers: group })).toBe(false);
    const named = await resolveOperatorGroupIdentity(human, 'fixture-access-token');
    expect(canInvokeOperator(named, { invokers: group })).toBe(false);
    expect(canInvokeOperator(first, { invokers: { users: [], groups: [{ issuer: 'https://other.cloudflareaccess.com', id: 'group-1' }] } })).toBe(false);
  });
  it.each([
    () => identity([{ id: 'group-1' }], { email: 'other@example.test' }),
    () => identity([{ id: 'group-1' }], { user_uuid: 'other-human' }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example.test' } }),
  ])('rejects unverified identity despite an email grant and permits later verified recovery', async response => {
    const responses = [response(), identity([])];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    await expect(resolveOperatorGroupIdentity(human, 'fixture-access-token')).rejects.toThrow();
    const recovered = await resolveOperatorGroupIdentity(human, 'fixture-access-token');
    expect(canInvokeOperator(recovered, { invokers: group })).toBe(false);
    expect(canInvokeOperator(recovered, { invokers: user })).toBe(true);
  });
  it('preserves an email grant for verified identity without usable membership IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => identity(['group-1'])));
    const current = await resolveOperatorGroupIdentity(human, 'fixture-access-token');
    expect(canInvokeOperator(current, { invokers: group })).toBe(false);
    expect(canInvokeOperator(current, { invokers: user })).toBe(true);
  });
  it('does not forward credentials to an untrusted issuer and rejects expired authority', async () => {
    let exposedCredential: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      exposedCredential = new Headers(init?.headers).get('cookie');
      return identity([{ id: 'group-1' }]);
    }));
    await expect(resolveOperatorGroupIdentity({ ...human, issuer: 'https://untrusted.example.test' }, 'fixture-access-token'))
      .rejects.toThrow();
    // Security wire contract: the untrusted issuer must never receive the bearer cookie.
    expect(exposedCredential).toBeNull();
    expect(canManageOperator({ ...human, expiresAt: 1 }, { managers: user }, user)).toBe(false);
    expect(canInvokeOperator({ ...human, expiresAt: 1 }, { invokers: user })).toBe(false);
  });
});
