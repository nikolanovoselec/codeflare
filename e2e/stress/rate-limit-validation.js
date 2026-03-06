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

export const options = {
  scenarios: {
    // Single VU to get deterministic rate limit behavior
    validate_session_limit: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    // We MUST see at least one 429
    rate_limit_429s: ['count>0'],
    // No unexpected errors (5xx, network failures)
    unexpected_errors: ['rate<0.05'],
  },
};

export default function () {
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
      const sessions = listRes.json();
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          if (s.name && s.name.startsWith('ratelimit-test-')) {
            http.del(`${BASE_URL}/api/sessions/${s.id}`, null, { headers: HEADERS });
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
