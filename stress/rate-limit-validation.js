import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

// This test validates that rate limits ARE enforced.
// It must run WITHOUT STRESS_TEST_MODE=active on the worker.

const rateLimitHits = new Counter('rate_limit_429s');
const unexpectedErrors = new Rate('unexpected_errors');

const BASE_URL = __ENV.E2E_BASE_URL;
const HEADERS = {
  'CF-Access-Client-Id': __ENV.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': __ENV.CF_ACCESS_CLIENT_SECRET,
  'X-Service-Auth': __ENV.CF_ACCESS_CLIENT_SECRET,
  'X-Requested-With': 'fetch',
  'Content-Type': 'application/json',
};
const READ_HEADERS = {
  'CF-Access-Client-Id': __ENV.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': __ENV.CF_ACCESS_CLIENT_SECRET,
  'X-Service-Auth': __ENV.CF_ACCESS_CLIENT_SECRET,
};

// Rate limit caps (must match worker config)
const SESSION_CREATE_LIMIT = 10; // per minute
const BURST_SIZE = SESSION_CREATE_LIMIT + 5; // send more than the limit

const PREFERENCES_PATCH_LIMIT = 20; // per minute
const PREFERENCES_BURST_SIZE = PREFERENCES_PATCH_LIMIT + 5;

export const options = {
  scenarios: {
    // Single VU to get deterministic rate limit behavior
    validate_session_limit: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '3m',
      exec: 'sessionLimitTest',
    },
    // Validate PATCH /api/preferences rate limit
    validate_preferences_limit: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '2m',
      startTime: '3m10s',
      exec: 'preferencesLimitTest',
    },
  },
  thresholds: {
    // We MUST see at least one 429
    rate_limit_429s: ['count>0'],
    // No unexpected errors (5xx, network failures).
    // NB: unexpectedErrors only ever receives .add(true), so this reads as
    // "exactly zero", not "under 5%". Left as-is deliberately — zero is the
    // right bar for a 5xx — but the threshold overstates its own tolerance.
    unexpected_errors: ['rate<0.05'],
    // k6 does NOT fail a run on failed check()s. Without this, every check in
    // this file is decorative — including 'successes did not exceed rate limit
    // cap' at the bottom, which is the single assertion that would catch a
    // limiter letting everything through. That is the entire point of the suite.
    checks: ['rate>0.99'],
  },
};

export function sessionLimitTest() {
  let successCount = 0;
  let limitedCount = 0;

  // Burst: send BURST_SIZE session creates rapidly
  for (let i = 0; i < BURST_SIZE; i++) {
    const name = `ratelimit-test-${Date.now()}-${i}`;
    const res = http.post(
      `${BASE_URL}/api/sessions`,
      JSON.stringify({ name }),
      { headers: HEADERS, tags: { endpoint: 'POST /api/sessions' } }
    );

    if (res.status === 201) {
      successCount++;
    } else if (res.status === 429) {
      limitedCount++;
      rateLimitHits.add(1);

      // Verify rate limit headers are present
      check(res, {
        '429 has Retry-After or rate limit info': (r) =>
          r.headers['Retry-After'] !== undefined ||
          r.headers['X-Ratelimit-Limit'] !== undefined ||
          r.body.includes('Rate limit'),
      });
    } else {
      // Unexpected status
      unexpectedErrors.add(true);
      console.error(`Unexpected status ${res.status}: ${res.body}`);
    }

    // Tiny pause to avoid overwhelming DNS/TLS, but fast enough to hit limits
    sleep(0.1);
  }

  console.log(`Session creates: ${successCount} succeeded, ${limitedCount} rate-limited out of ${BURST_SIZE}`);

  check(limitedCount > 0, {
    'rate limit was enforced (got at least one 429)': (v) => v,
  });

  check(successCount > 0, {
    'some requests succeeded before limit': (v) => v,
  });

  check(successCount <= SESSION_CREATE_LIMIT, {
    'successes did not exceed rate limit cap': (v) => v,
  });

  // Clean up created sessions
  sleep(1);
  const listRes = http.get(`${BASE_URL}/api/sessions`, {
    headers: READ_HEADERS,
  });
  if (listRes.status === 200) {
    try {
      // GET /api/sessions returns { sessions: [...] } (src/routes/session/crud.ts),
      // never a bare array. Array.isArray() on the envelope was always false, so
      // this loop never executed — inside a try with an empty catch, so nothing
      // said so — and every run left up to 10 container-backed
      // ratelimit-test-* sessions in the live deployment, permanently.
      const sessions = listRes.json('sessions');
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          if (s.name && s.name.startsWith('ratelimit-test-')) {
            http.del(`${BASE_URL}/api/sessions/${s.id}`, null, { headers: HEADERS });
          }
        }
      }
    } catch (e) {
      // Still non-fatal — a failed cleanup must not fail the load test — but
      // silence is what let the bug above survive. Say something.
      console.warn(`cleanup failed, sessions may have leaked: ${e}`);
    }
  }
}

export function preferencesLimitTest() {
  let successCount = 0;
  let limitedCount = 0;

  // Burst: send PREFERENCES_BURST_SIZE PATCH requests rapidly
  for (let i = 0; i < PREFERENCES_BURST_SIZE; i++) {
    const mode = i % 2 === 0 ? 'default' : 'advanced';
    const res = http.patch(
      `${BASE_URL}/api/preferences`,
      JSON.stringify({ sessionMode: mode }),
      { headers: HEADERS, tags: { endpoint: 'PATCH /api/preferences' } }
    );

    if (res.status === 200) {
      successCount++;
    } else if (res.status === 429) {
      limitedCount++;
      rateLimitHits.add(1);
    } else {
      unexpectedErrors.add(true);
      console.error(`Preferences PATCH unexpected status ${res.status}: ${res.body}`);
    }

    sleep(0.1);
  }

  console.log(`Preferences PATCH: ${successCount} succeeded, ${limitedCount} rate-limited out of ${PREFERENCES_BURST_SIZE}`);

  check(limitedCount > 0, {
    'preferences rate limit was enforced (got at least one 429)': (v) => v,
  });
}

export default function () {
  sessionLimitTest();
}
