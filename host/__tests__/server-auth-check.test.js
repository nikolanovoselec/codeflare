// Real behavioral tests for REQ-SEC-022 (Container proxy bearer validation).
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
import { createRequestHandler } from '../dist/request-router.js';
import { createActivityTracker } from '../dist/activity-tracker.js';

// Drive the production handler without a listener, native PTY or filesystem fixture.
async function route(handler, path, authorization) {
  let status;
  let body;
  await handler({ url: path, method: 'GET', headers: authorization === undefined ? {} : { authorization } }, {
    writeHead(value) { status = value; },
    end(value) { body = JSON.parse(value); },
  });
  return { status, body };
}

describe('REQ-SEC-022: host inventory and heartbeat boundaries (RQ0044)', () => {
  it('keeps anonymous startup health minimal and denies heartbeat before protected effects', async () => {
    const saved = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'host-boundary-token';
    const activityTracker = createActivityTracker();
    const handler = createRequestHandler({
      activityTracker,
      sessionManager: { clients: new Set(), sessions: new Map(), get size() { throw new Error('Protected inventory read'); } },
      readiness() { throw new Error('Protected readiness read'); },
      log() {},
    });
    try {
      assert.deepEqual(await route(handler, '/health'), { status: 200, body: { status: 'healthy' } });
      for (const authorization of [undefined, 'Bearer wrong']) {
        assert.equal((await route(handler, '/activity', authorization)).status, 401);
        assert.equal(activityTracker.getActivityInfo(null).lastHeartbeatAt, null);
      }
      assert.equal((await route(handler, '/health', 'Bearer wrong')).status, 401);
      const authorized = await route(handler, '/activity', 'Bearer host-boundary-token');
      assert.equal(authorized.status, 200);
      assert.equal(typeof authorized.body.lastHeartbeatAt, 'number');
      assert.equal(authorized.body.lastHeartbeatAt, activityTracker.getActivityInfo(null).lastHeartbeatAt);
      delete process.env.CONTAINER_AUTH_TOKEN;
      assert.deepEqual(await route(handler, '/health'), { status: 200, body: { status: 'healthy' } });
      assert.equal((await route(handler, '/activity')).status, 503);
    } finally {
      if (saved === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = saved;
    }
  });
});

describe('checkContainerAuth / REQ-SEC-022 (container proxy bearer validation)', () => {
  // REQ-SEC-022 AC2 (terminal server validates token on all non-exempt paths)
  // + AC3 (whitelist /health and /activity only)
  describe('REQ-SEC-022 AC3: only /health and /activity are auth-exempt', () => {
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

  describe('REQ-SEC-022 AC2: protected paths require a matching Bearer token', () => {
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

    it('REQ-SEC-022 AC5: the internal agent-event drain is protected and never auth-exempt', () => {
      assert.equal(AUTH_EXEMPT_PATHS.has('/internal/agent-events/drain'), false);
      assert.equal(checkContainerAuth('/internal/agent-events/drain', undefined, 'expected-token').status, 401);
      assert.deepEqual(
        checkContainerAuth('/internal/agent-events/drain', 'Bearer expected-token', 'expected-token'),
        { allowed: true },
      );
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

    // REQ-SEC-022 token-comparison invariant: the comparison must be constant-time.
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
