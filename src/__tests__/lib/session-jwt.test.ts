import { describe, it, expect } from 'vitest';
import { signSessionJWT, verifySessionJWT } from '../../lib/session-jwt';

const TEST_SECRET = 'test-secret-key-for-hmac-256-signing';

describe('session-jwt', () => {
  describe('signSessionJWT', () => {
    it('produces a valid 3-part base64url JWT', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
      // Each part should be base64url (no +, /, or =)
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('includes iat and exp with correct TTL', async () => {
      const before = Math.floor(Date.now() / 1000);
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
        7200, // 2 hours
      );
      const after = Math.floor(Date.now() / 1000);

      const payload = await verifySessionJWT(token, TEST_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.iat).toBeGreaterThanOrEqual(before);
      expect(payload!.iat).toBeLessThanOrEqual(after);
      expect(payload!.exp - payload!.iat).toBe(7200);
    });

    it('defaults TTL to 3600 seconds', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const payload = await verifySessionJWT(token, TEST_SECRET);
      expect(payload!.exp - payload!.iat).toBe(3600);
    });
  });

  describe('verifySessionJWT', () => {
    it('returns payload for valid token', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const payload = await verifySessionJWT(token, TEST_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.email).toBe('alice@example.com');
      expect(payload!.sub).toBe('12345');
      expect(payload!.ghLogin).toBe('alice');
    });

    it('returns null for expired token', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
        -1, // already expired
      );
      const payload = await verifySessionJWT(token, TEST_SECRET);
      expect(payload).toBeNull();
    });

    it('returns null for tampered payload', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const parts = token.split('.');
      // Tamper with the payload
      const tampered = `${parts[0]}.${btoa('{"email":"evil@example.com","sub":"99999","ghLogin":"evil","iat":0,"exp":9999999999}').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.${parts[2]}`;
      const payload = await verifySessionJWT(tampered, TEST_SECRET);
      expect(payload).toBeNull();
    });

    it('returns null for tampered signature', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}.${parts[2]}TAMPERED`;
      const payload = await verifySessionJWT(tampered, TEST_SECRET);
      expect(payload).toBeNull();
    });

    it('returns null for wrong secret', async () => {
      const token = await signSessionJWT(
        { email: 'alice@example.com', sub: '12345', ghLogin: 'alice' },
        TEST_SECRET,
      );
      const payload = await verifySessionJWT(token, 'wrong-secret');
      expect(payload).toBeNull();
    });

    it('returns null for malformed token', async () => {
      expect(await verifySessionJWT('not-a-jwt', TEST_SECRET)).toBeNull();
      expect(await verifySessionJWT('a.b', TEST_SECRET)).toBeNull();
      expect(await verifySessionJWT('', TEST_SECRET)).toBeNull();
      expect(await verifySessionJWT('a.b.c.d', TEST_SECRET)).toBeNull();
    });
  });

  describe('shouldRefreshJWT / REQ-AUTH-008 AC1/AC2 (cookie auto-refresh middleware: refresh when < 15 min remaining on 1h TTL)', () => {
    const now = () => Math.floor(Date.now() / 1000);

    it('returns true when payload expires in less than 15 minutes', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now() - 2700, exp: now() + 600 } as any;
      expect(shouldRefreshJWT(payload)).toBe(true);
    });

    it('returns false when payload has more than 15 minutes remaining', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now(), exp: now() + 3000 } as any;
      expect(shouldRefreshJWT(payload)).toBe(false);
    });

    it('returns false when payload is already expired (does not extend dead sessions)', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now() - 7200, exp: now() - 100 } as any;
      expect(shouldRefreshJWT(payload)).toBe(false);
    });

    it('returns true at the boundary (exactly 14:59 remaining)', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now() - 2700, exp: now() + 899 } as any;
      expect(shouldRefreshJWT(payload)).toBe(true);
    });

    // CF-045: the threshold is strict `< 15 min`. At exactly 900s remaining the
    // comparison (900 < 900) is false, so a token sitting precisely on the
    // boundary is NOT refreshed. The next second below it is.
    it('returns false at exactly 15:00 remaining (strict < boundary)', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now() - 2700, exp: now() + 900 } as any;
      expect(shouldRefreshJWT(payload)).toBe(false);
    });

    it('returns false just over the boundary (15:01 remaining)', async () => {
      const { shouldRefreshJWT } = await import('../../lib/session-jwt');
      const payload = { email: 'u@x.com', sub: 's', ghLogin: 'g', iat: now() - 2700, exp: now() + 901 } as any;
      expect(shouldRefreshJWT(payload)).toBe(false);
    });
  });
});
