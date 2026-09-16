/**
 * Automatic JWT stamping decision tests. Network authorization is deliberately
 * absent: stamping runs only after another policy allows transport. Redirect and
 * real RP/backend acceptance remain integration evidence.
 */
import { describe, expect, it } from 'vitest';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';
import { parseJwtStampingPolicy, prepareJwtStampedRequest, shouldStampAccessJwt } from '../../operators/jwt-stamping';

const human = (expiresAt = Math.floor(Date.now() / 1000) + 300): VerifiedHumanAccessClaims => ({
  subject: 'human', email: 'human@example.test', issuer: 'https://access.example.test', audiences: ['audience'],
  issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt,
});

describe('REQ-OPERATOR-004: automatic human Access JWT stamping', () => {
  it('validates Off, exact/wildcard destination list and All without accepting URLs or IPs', () => {
    expect(parseJwtStampingPolicy({ mode: 'off', destinations: [] })).toEqual({ mode: 'off', destinations: [] });
    expect(parseJwtStampingPolicy({ mode: 'list', destinations: ['api.example.test', '*.services.example.test'] }))
      .toEqual({ mode: 'list', destinations: ['api.example.test', '*.services.example.test'] });
    expect(parseJwtStampingPolicy({ mode: 'all', destinations: [] })).toEqual({ mode: 'all', destinations: [] });
    for (const invalid of [{ mode: 'off', destinations: ['api.example.test'] }, { mode: 'all', destinations: ['x.test'] },
      { mode: 'list', destinations: [] }, { mode: 'list', destinations: ['https://api.example.test'] },
      { mode: 'list', destinations: ['127.0.0.1'] }, { mode: 'list', destinations: ['example.test/path'] }]) {
      expect(() => parseJwtStampingPolicy(invalid)).toThrow('JWT stamping');
    }
  });

  it('matches HTTPS exact/wildcard destinations with wildcard excluding its apex', () => {
    const policy = parseJwtStampingPolicy({ mode: 'list', destinations: ['api.example.test', '*.services.example.test'] });
    expect(shouldStampAccessJwt(policy, new URL('https://api.example.test/path'))).toBe(true);
    expect(shouldStampAccessJwt(policy, new URL('https://a.services.example.test/path'))).toBe(true);
    for (const url of ['http://api.example.test', 'https://services.example.test',
      'https://api.example.test.evil.test', 'https://other.example.test']) {
      expect(shouldStampAccessJwt(policy, new URL(url))).toBe(false);
    }
    expect(shouldStampAccessJwt({ mode: 'off', destinations: [] }, new URL('https://api.example.test'))).toBe(false);
    expect(shouldStampAccessJwt({ mode: 'all', destinations: [] }, new URL('https://any.example.test'))).toBe(true);
    expect(shouldStampAccessJwt({ mode: 'all', destinations: [] }, new URL('http://any.example.test'))).toBe(false);
  });

  it('strips spoofed assertions, stamps only eligible requests and preserves specialized Authorization', () => {
    const source = new Request('https://api.example.test/resource', { headers: {
      authorization: 'Bearer specialized', 'cf-access-jwt-assertion': 'caller-spoof', 'x-test': 'keep',
    } });
    const stamped = prepareJwtStampedRequest(source, { mode: 'list', destinations: ['api.example.test'] },
      { human: human(), accessJwt: 'verified.jwt' });
    expect(stamped.headers.get('cf-access-jwt-assertion')).toBe('verified.jwt');
    expect(stamped.headers.get('authorization')).toBe('Bearer specialized');
    expect(stamped.headers.get('x-test')).toBe('keep');
    const off = prepareJwtStampedRequest(source, { mode: 'off', destinations: [] },
      { human: human(), accessJwt: 'verified.jwt' });
    expect(off.headers.get('cf-access-jwt-assertion')).toBeNull();
    expect(off.headers.get('authorization')).toBe('Bearer specialized');
  });

  it('rejects expired authority when an eligible destination would be stamped', () => {
    expect(() => prepareJwtStampedRequest(new Request('https://api.example.test'),
      { mode: 'all', destinations: [] }, { human: human(Math.floor(Date.now() / 1000) - 1), accessJwt: 'expired.jwt' }))
      .toThrow('expired');
    const ineligible = prepareJwtStampedRequest(new Request('http://api.example.test', {
      headers: { 'cf-access-jwt-assertion': 'spoof' },
    }), { mode: 'all', destinations: [] }, { human: human(Math.floor(Date.now() / 1000) - 1), accessJwt: 'expired.jwt' });
    expect(ineligible.headers.get('cf-access-jwt-assertion')).toBeNull();
  });
});
