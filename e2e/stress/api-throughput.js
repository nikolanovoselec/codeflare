import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const sessionListDuration = new Trend('session_list_duration', true);
const healthDuration = new Trend('health_duration', true);
const userDuration = new Trend('user_duration', true);
const preferencesGetDuration = new Trend('preferences_get_duration', true);
const storageBrowseDuration = new Trend('storage_browse_duration', true);

// Configurable concurrency via STRESS_TEST_CONCURRENCY env var
// When set, scales VU targets proportionally and reduces think times (rate limits are off)
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = 10;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }
const HIGH_CONCURRENCY = CONCURRENCY > 100;

const BASE_URL = __ENV.E2E_BASE_URL;
const AUTH_HEADERS = {
  'CF-Access-Client-Id': __ENV.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': __ENV.CF_ACCESS_CLIENT_SECRET,
  'X-Service-Auth': __ENV.CF_ACCESS_CLIENT_SECRET,
};

export const options = {
  scenarios: {
    // Ramp up concurrent users to test sustained load
    sustained_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: scaled(5) },
        { duration: '1m', target: scaled(10) },
        { duration: '2m', target: scaled(10) },
        { duration: '30s', target: 0 },
      ],
    },
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '4m30s',
      stages: [
        { duration: '10s', target: scaled(20) },
        { duration: '30s', target: scaled(20) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: [HIGH_CONCURRENCY ? 'p(95)<5000' : 'p(95)<2000'],
    http_req_failed: ['rate<0.05'],
    errors: ['rate<0.1'],
    health_duration: [HIGH_CONCURRENCY ? 'p(95)<2000' : 'p(95)<500'],
    session_list_duration: [HIGH_CONCURRENCY ? 'p(95)<8000' : 'p(95)<3000'],
  },
};

function authGet(path, metric) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: AUTH_HEADERS,
    tags: { endpoint: path },
  });

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'no server error': (r) => r.status < 500,
  });

  errorRate.add(!ok);
  if (metric) metric.add(res.timings.duration);

  return res;
}

export default function () {
  // Health check (no auth needed)
  const healthRes = http.get(`${BASE_URL}/health`, {
    tags: { endpoint: '/health' },
  });
  check(healthRes, { 'health ok': (r) => r.status === 200 });
  healthDuration.add(healthRes.timings.duration);

  // Authenticated API endpoints
  authGet('/api/sessions', sessionListDuration);
  authGet('/api/user', userDuration);
  authGet('/api/preferences', preferencesGetDuration);
  authGet('/api/storage/browse', storageBrowseDuration);

  // Batch status (lightweight polling endpoint)
  authGet('/api/sessions/batch-status');

  sleep(CONCURRENCY > 0 ? 0.3 : 1);
}
