// Real behavioral tests for REQ-SEC-012 (Container auth token per DO lifecycle).
//
// This file replaces the text-matching theater in server-security.test.js,
// which read server.ts source with readFileSync and asserted on string
// contents — a tdd-enforce antipattern that passes even if the implementation
// is replaced with a no-op containing the right strings.
//
// Strategy: the auth check is now a pure function (host/src/auth-check.ts).
// We import the compiled module and exercise every branch with real inputs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkContainerAuth, AUTH_EXEMPT_PATHS } from '../dist/auth-check.js';

describe('checkContainerAuth / REQ-SEC-012 (container auth token per DO lifecycle)', () => {
  // REQ-SEC-012 AC3 (terminal server validates token on all non-exempt paths)
  // + AC4 (whitelist /health and /activity only)
  describe('REQ-SEC-012 AC4: only /health and /activity are auth-exempt', () => {
    it('AUTH_EXEMPT_PATHS contains exactly /health and /activity (no others)', () => {
      assert.deepEqual([...AUTH_EXEMPT_PATHS].sort(), ['/activity', '/health']);
    });

    it('/health allowed regardless of header or env token', () => {
      assert.deepEqual(checkContainerAuth('/health', undefined, undefined), { allowed: true });
      assert.deepEqual(checkContainerAuth('/health', undefined, 'tok'), { allowed: true });
      assert.deepEqual(checkContainerAuth('/health', 'Bearer wrong', 'tok'), { allowed: true });
    });

    it('/activity allowed regardless of header or env token', () => {
      assert.deepEqual(checkContainerAuth('/activity', undefined, undefined), { allowed: true });
      assert.deepEqual(checkContainerAuth('/activity', 'Bearer wrong', 'tok'), { allowed: true });
    });
  });

  describe('REQ-SEC-012 AC3: protected paths require a matching Bearer token', () => {
    it('returns 503 when CONTAINER_AUTH_TOKEN is unset (server-not-ready, NOT silently skipping auth)', () => {
      const out = checkContainerAuth('/sessions', 'Bearer anything', undefined);
      assert.equal(out.allowed, false);
      assert.equal(out.status, 503);
      const parsed = JSON.parse(out.body);
      assert.match(parsed.error, /missing auth token|not configured/i);
    });

    it('returns 503 when CONTAINER_AUTH_TOKEN is empty string (same fail-closed branch)', () => {
      const out = checkContainerAuth('/sessions', 'Bearer anything', '');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 503);
    });

    it('returns 401 when Authorization header is missing', () => {
      const out = checkContainerAuth('/sessions', undefined, 'expected-token');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });

    it('returns 401 when Authorization header lacks Bearer prefix', () => {
      const out = checkContainerAuth('/sessions', 'expected-token', 'expected-token');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });

    it('returns 401 when Bearer token does not match', () => {
      const out = checkContainerAuth('/sessions', 'Bearer wrong', 'expected-token');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });

    it('returns 401 when Bearer token is empty string after the prefix', () => {
      const out = checkContainerAuth('/sessions', 'Bearer ', 'expected-token');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });

    it('returns { allowed: true } when Bearer token matches exactly', () => {
      const out = checkContainerAuth('/sessions', 'Bearer expected-token', 'expected-token');
      assert.deepEqual(out, { allowed: true });
    });

    it('returns { allowed: true } for the WebSocket upgrade path /terminal with matching token', () => {
      const out = checkContainerAuth('/terminal', 'Bearer good', 'good');
      assert.deepEqual(out, { allowed: true });
    });

    // REQ-SEC-012 token-comparison invariant: the comparison must be constant-time.
    // We can't directly observe timing in a unit test, but we can verify that
    // tokens of different lengths still compare correctly (a naive == would
    // short-circuit and leak length).
    it('rejects a shorter wrong token without crashing on length mismatch (constant-time path)', () => {
      const out = checkContainerAuth('/sessions', 'Bearer short', 'a-much-longer-expected-token');
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });

    it('rejects a longer wrong token without crashing on length mismatch', () => {
      const out = checkContainerAuth(
        '/sessions',
        'Bearer this-is-way-too-long-to-match',
        'short-token',
      );
      assert.equal(out.allowed, false);
      assert.equal(out.status, 401);
    });
  });
});
