import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const sessionCreateDuration = new Trend('session_create_duration', true);
const sessionDeleteDuration = new Trend('session_delete_duration', true);
const sessionsCreated = new Counter('sessions_created');
const sessionsDeleted = new Counter('sessions_deleted');
const rateLimitHits = new Counter('rate_limit_hits');

// Configurable concurrency via STRESS_TEST_CONCURRENCY env var
// Scales VU count only — think times stay realistic
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = 3;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }

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

// Randomized think time
function think(minS, maxS) {
  sleep(minS + Math.random() * (maxS - minS));
}

export const options = {
  scenarios: {
    session_churn: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: scaled(3) },
        { duration: '2m', target: scaled(3) },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    session_create_duration: ['p(95)<5000'],
    session_delete_duration: ['p(95)<3000'],
    errors: ['rate<0.15'],
  },
};

export default function () {
  group('session lifecycle', () => {
    // Create session — user clicks "New Session"
    const name = `stress-${Date.now()}-${__VU}`;
    const createRes = http.post(
      `${BASE_URL}/api/sessions`,
      JSON.stringify({ name }),
      { headers: HEADERS, tags: { endpoint: 'POST /api/sessions' } }
    );

    if (createRes.status === 429) {
      rateLimitHits.add(1);
      sleep(15);
      return;
    }

    const created = check(createRes, {
      'session created (201)': (r) => r.status === 201,
    });
    errorRate.add(!created);
    sessionCreateDuration.add(createRes.timings.duration);

    if (!created) return;
    sessionsCreated.add(1);

    let sessionId;
    try {
      sessionId = createRes.json('session.id');
    } catch {
      return;
    }

    // User sees the new session, looks at dashboard
    think(3, 8);

    // List sessions — dashboard auto-polls
    const listRes = http.get(`${BASE_URL}/api/sessions`, {
      headers: READ_HEADERS,
      tags: { endpoint: 'GET /api/sessions' },
    });
    check(listRes, { 'list ok': (r) => r.status === 200 });

    // User checks the session details
    think(2, 5);

    // Get specific session
    const getRes = http.get(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: READ_HEADERS,
      tags: { endpoint: 'GET /api/sessions/:id' },
    });
    check(getRes, { 'get session ok': (r) => r.status === 200 });

    // User works in the session for a while, then decides to clean up
    think(5, 15);

    // Delete session
    const deleteRes = http.del(`${BASE_URL}/api/sessions/${sessionId}`, null, {
      headers: HEADERS,
      tags: { endpoint: 'DELETE /api/sessions/:id' },
    });

    if (deleteRes.status === 429) {
      rateLimitHits.add(1);
      sleep(15);
      return;
    }

    const deleted = check(deleteRes, {
      'session deleted': (r) => r.status === 200 || r.status === 204,
    });
    errorRate.add(!deleted);
    sessionDeleteDuration.add(deleteRes.timings.duration);
    if (deleted) sessionsDeleted.add(1);
  });

  // User doesn't create/delete sessions every few seconds — big gap between cycles
  think(10, 30);
}
