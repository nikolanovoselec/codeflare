import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import encoding from 'k6/encoding';

const errorRate = new Rate('errors');
const uploadDuration = new Trend('upload_duration', true);
const downloadDuration = new Trend('download_duration', true);
const browseDuration = new Trend('browse_duration', true);
const deleteDuration = new Trend('delete_duration', true);
const filesUploaded = new Counter('files_uploaded');
const rateLimitHits = new Counter('rate_limit_hits');

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

// Generate test content of varying sizes
function generateContent(sizeKB) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let content = '';
  const targetLen = sizeKB * 1024;
  while (content.length < targetLen) {
    content += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return content;
}

// Pre-generate test payloads
const SMALL_CONTENT = encoding.b64encode(generateContent(1));   // 1 KB
const MEDIUM_CONTENT = encoding.b64encode(generateContent(50)); // 50 KB
const LARGE_CONTENT = encoding.b64encode(generateContent(500)); // 500 KB

export const options = {
  scenarios: {
    storage_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 3 },
        { duration: '2m', target: 5 },   // 5 concurrent users doing storage ops
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    upload_duration: ['p(95)<10000'],    // Upload under 10s (includes R2 latency)
    download_duration: ['p(95)<5000'],
    browse_duration: ['p(95)<3000'],
    errors: ['rate<0.15'],
  },
};

export default function () {
  const filePrefix = `stress-test/${__VU}`;
  const timestamp = Date.now();

  group('storage upload cycle', () => {
    // Pick random file size
    const sizes = [
      { name: 'small', content: SMALL_CONTENT },
      { name: 'medium', content: MEDIUM_CONTENT },
      { name: 'large', content: LARGE_CONTENT },
    ];
    const size = sizes[Math.floor(Math.random() * sizes.length)];
    const key = `${filePrefix}/${size.name}-${timestamp}.txt`;

    // Upload
    const uploadRes = http.post(
      `${BASE_URL}/api/storage/upload`,
      JSON.stringify({ key, content: size.content }),
      { headers: HEADERS, tags: { endpoint: 'POST /api/storage/upload' } }
    );

    if (uploadRes.status === 429) {
      rateLimitHits.add(1);
      sleep(10);
      return;
    }

    const uploaded = check(uploadRes, {
      'upload ok': (r) => r.status === 200 || r.status === 201,
    });
    errorRate.add(!uploaded);
    uploadDuration.add(uploadRes.timings.duration);
    if (uploaded) filesUploaded.add(1);

    if (!uploaded) return;

    sleep(0.5);

    // Browse
    const browseRes = http.get(
      `${BASE_URL}/api/storage/browse?prefix=${encodeURIComponent(filePrefix)}`,
      { headers: READ_HEADERS, tags: { endpoint: 'GET /api/storage/browse' } }
    );
    check(browseRes, { 'browse ok': (r) => r.status === 200 });
    browseDuration.add(browseRes.timings.duration);

    sleep(0.5);

    // Download
    const downloadRes = http.get(
      `${BASE_URL}/api/storage/download?key=${encodeURIComponent(key)}`,
      { headers: READ_HEADERS, tags: { endpoint: 'GET /api/storage/download' } }
    );
    check(downloadRes, { 'download ok': (r) => r.status === 200 });
    downloadDuration.add(downloadRes.timings.duration);

    sleep(0.5);

    // Delete
    const deleteRes = http.post(
      `${BASE_URL}/api/storage/delete`,
      JSON.stringify({ keys: [key] }),
      { headers: HEADERS, tags: { endpoint: 'POST /api/storage/delete' } }
    );
    check(deleteRes, { 'delete ok': (r) => r.status === 200 || r.status === 204 });
    deleteDuration.add(deleteRes.timings.duration);
  });

  sleep(2);
}
