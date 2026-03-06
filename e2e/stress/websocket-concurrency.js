import http from 'k6/http';
import { check, sleep } from 'k6';
import ws from 'k6/ws';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const wsConnectDuration = new Trend('ws_connect_duration', true);
const wsConnections = new Counter('ws_connections_opened');
const wsErrors = new Counter('ws_errors');
const rateLimitHits = new Counter('rate_limit_hits');

const BASE_URL = __ENV.E2E_BASE_URL;
const WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');
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

// Shared session ID (created in setup, cleaned up in teardown)
export function setup() {
  // Create a session for WebSocket testing
  const res = http.post(
    `${BASE_URL}/api/sessions`,
    JSON.stringify({ name: `ws-stress-${Date.now()}` }),
    { headers: HEADERS }
  );

  if (res.status !== 201) {
    console.error(`Failed to create session: ${res.status} ${res.body}`);
    return { sessionId: null };
  }

  const sessionId = res.json('id');
  console.log(`Created test session: ${sessionId}`);

  // Start container
  const startRes = http.post(
    `${BASE_URL}/api/container/start?sessionId=${sessionId}`,
    null,
    { headers: HEADERS }
  );
  console.log(`Container start: ${startRes.status}`);

  // Wait for container ready (poll with timeout)
  const maxWait = 60;
  for (let i = 0; i < maxWait; i++) {
    sleep(2);
    const statusRes = http.get(
      `${BASE_URL}/api/container/startup-status?sessionId=${sessionId}`,
      { headers: READ_HEADERS }
    );
    if (statusRes.status === 200) {
      try {
        const stage = statusRes.json('stage');
        if (stage === 'ready') {
          console.log(`Container ready after ${(i + 1) * 2}s`);
          return { sessionId };
        }
        if (stage === 'error') {
          console.error('Container failed to start');
          return { sessionId };
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  console.warn('Container did not reach ready state within timeout');
  return { sessionId };
}

export const options = {
  scenarios: {
    ws_connections: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 5 },   // 5 concurrent WebSocket connections
        { duration: '1m', target: 10 },   // Ramp to 10
        { duration: '1m', target: 10 },   // Hold
        { duration: '30s', target: 0 },   // Ramp down
      ],
    },
  },
  thresholds: {
    ws_connect_duration: ['p(95)<10000'], // WS connect under 10s
    errors: ['rate<0.3'],                 // Allow higher rate (WS rate limit = 30/min)
  },
};

export default function (data) {
  if (!data.sessionId) {
    sleep(5);
    return;
  }

  const terminalId = (__VU % 6) + 1; // Distribute across 6 terminal slots
  const wsEndpoint = `${WS_URL}/api/terminal/${data.sessionId}-${terminalId}/ws`;

  const startTime = Date.now();
  const res = ws.connect(wsEndpoint, { headers: READ_HEADERS }, function (socket) {
    wsConnections.add(1);
    wsConnectDuration.add(Date.now() - startTime);

    socket.on('open', () => {
      check(true, { 'ws connected': () => true });

      // Send a simple command
      socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    });

    socket.on('message', () => {
      // Receive messages
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
      errorRate.add(true);
    });

    // Keep connection open for 10-30 seconds
    const holdTime = 10 + Math.random() * 20;
    socket.setTimeout(function () {
      socket.close();
    }, holdTime * 1000);
  });

  if (res.status === 429) {
    rateLimitHits.add(1);
    sleep(15); // Back off on rate limit
  }

  sleep(2); // Respect 30 connections/min limit
}

export function teardown(data) {
  if (data.sessionId) {
    // Stop container
    http.post(
      `${BASE_URL}/api/sessions/${data.sessionId}/stop`,
      null,
      { headers: HEADERS }
    );
    sleep(2);
    // Delete session
    http.del(
      `${BASE_URL}/api/sessions/${data.sessionId}`,
      null,
      { headers: HEADERS }
    );
    console.log(`Cleaned up session: ${data.sessionId}`);
  }
}
