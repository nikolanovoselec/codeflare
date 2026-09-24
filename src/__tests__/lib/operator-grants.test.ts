import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInvokeOperator, canManageOperator, resolveOperatorGroupIdentity } from '../../lib/access';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';

const human: VerifiedHumanAccessClaims = { subject: 'human-1', email: 'manager@example.test', issuer: 'https://team.cloudflareaccess.com',
  audiences: ['app'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300, groups: ['stale-group'] };
const empty = { users: [], groups: [] };
const user = { users: [human.email], groups: [] };
const group = { users: [], groups: [{ issuer: human.issuer, id: 'group-1' }] };
const identity = (groups: unknown, extra = {}) => new Response(JSON.stringify({ email: human.email, user_uuid: human.subject, groups, ...extra }));
afterEach(() => vi.unstubAllGlobals());

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
    () => identity(['group-1']),
  ])('denies group authority on uncertain identity without losing an explicit user grant', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
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
    const current = await resolveOperatorGroupIdentity({ ...human, issuer: 'https://untrusted.example.test' }, 'fixture-access-token');
    expect(current.groups).toEqual([]);
    // Security wire contract: the untrusted issuer must never receive the bearer cookie.
    expect(exposedCredential).toBeNull();
    expect(canManageOperator({ ...human, expiresAt: 1 }, { managers: user }, user)).toBe(false);
    expect(canInvokeOperator({ ...human, expiresAt: 1 }, { invokers: user })).toBe(false);
  });
});
