/**
 * REQ-ENTERPRISE-004 / REQ-ENTERPRISE-010: enterprise Access-group resolution.
 *
 * parseAccessGroups turns the (comma/newline) setup value into a list — a single
 * value stays a one-element list (back-compat with the original single-group
 * config). resolveUserAccessGroup intersects the user's get-identity groups with
 * the configured list and returns the single matched group (first by configured
 * order if several match — an IdP misconfiguration). It fails CLOSED (null) on any
 * missing input or error so the gate never admits, nor attributes, on uncertainty.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseAccessGroups, resolveUserAccessGroup } from '../../lib/access';

const AUTH_DOMAIN = 'team.cloudflareaccess.com';
const TOKEN = 'cf-auth-token';

function mockGetIdentity(groups: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ groups }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('parseAccessGroups', () => {
  it('returns [] for null / undefined / blank', () => {
    expect(parseAccessGroups(null)).toEqual([]);
    expect(parseAccessGroups(undefined)).toEqual([]);
    expect(parseAccessGroups('')).toEqual([]);
    expect(parseAccessGroups('   ')).toEqual([]);
  });

  it('parses a single group to a one-element list (back-compat)', () => {
    expect(parseAccessGroups('engineers')).toEqual(['engineers']);
  });

  it('splits comma- and newline-separated groups and trims each', () => {
    expect(parseAccessGroups('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseAccessGroups('a\n b\n')).toEqual(['a', 'b']);
    expect(parseAccessGroups('codeflare_admins, codeflare_developers')).toEqual([
      'codeflare_admins',
      'codeflare_developers',
    ]);
  });
});

describe('resolveUserAccessGroup', () => {
  it('returns null and makes NO get-identity call when no groups are configured', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, [])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the matched group when the user is a member of one configured group (object element)', async () => {
    mockGetIdentity([{ id: 'g1', name: 'codeflare_admins' }]);
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['codeflare_admins', 'codeflare_developers'])).toBe(
      'codeflare_admins',
    );
  });

  it('matches a plain-string group element', async () => {
    mockGetIdentity(['codeflare_developers']);
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['codeflare_admins', 'codeflare_developers'])).toBe(
      'codeflare_developers',
    );
  });

  it('returns null when the user is in none of the configured groups', async () => {
    mockGetIdentity([{ name: 'some_other_group' }]);
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['codeflare_admins'])).toBeNull();
  });

  it('returns the FIRST configured match when several match (IdP misconfiguration)', async () => {
    mockGetIdentity([{ name: 'codeflare_developers' }, { name: 'codeflare_admins' }]);
    // Configured order decides: admins is listed first, so admins wins.
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['codeflare_admins', 'codeflare_developers'])).toBe(
      'codeflare_admins',
    );
  });

  it('fails closed (null) AND makes no get-identity call when token or auth domain is missing', async () => {
    // Spy returns a VALID identity: the test passes only because the guard
    // short-circuits before fetch, not because a failed fetch happens to be null.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ groups: [{ name: 'x' }] }), { status: 200 }),
    );
    expect(await resolveUserAccessGroup(null, AUTH_DOMAIN, ['x'])).toBeNull();
    expect(await resolveUserAccessGroup(TOKEN, null, ['x'])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed (null) AND makes no get-identity call when the auth domain is not *.cloudflareaccess.com (SSRF guard)', async () => {
    // If the host guard were removed, the impl would fetch evil.example.com and the
    // mocked 200 would still yield null — so asserting null alone proves nothing.
    // Asserting NO fetch is what proves the guard actually blocks the outbound call.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ groups: [{ name: 'x' }] }), { status: 200 }),
    );
    expect(await resolveUserAccessGroup(TOKEN, 'evil.example.com', ['x'])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed (null) when get-identity returns non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 403 }));
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['x'])).toBeNull();
  });

  it('fails closed (null) when the get-identity fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network');
    });
    expect(await resolveUserAccessGroup(TOKEN, AUTH_DOMAIN, ['x'])).toBeNull();
  });
});
