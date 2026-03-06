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
        { duration: '30s', target: 5 },   // Ramp to 5 users
        { duration: '1m', target: 10 },   // Ramp to 10 users
        { duration: '2m', target: 10 },   // Hold at 10 users
        { duration: '30s', target: 0 },   // Ramp down
      ],
    },
    // Spike test — sudden burst
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '4m30s', // Start after sustained load finishes
      stages: [
        { duration: '10s', target: 20 },  // Spike to 20 users
        { duration: '30s', target: 20 },  // Hold spike
        { duration: '10s', target: 0 },   // Drop
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],     // 95% of requests under 2s
    http_req_failed: ['rate<0.05'],        // Less than 5% errors
    errors: ['rate<0.1'],                  // Custom error rate under 10%
    health_duration: ['p(95)<500'],        // Health check fast
    session_list_duration: ['p(95)<3000'], // Session list under 3s
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

  sleep(1); // 1s think time between iterations
}
