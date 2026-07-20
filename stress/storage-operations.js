import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import encoding from 'k6/encoding';

const errorRate = new Rate('errors');
const uploadDuration = new Trend('upload_duration', true);
const downloadDuration = new Trend('download_duration', true);
const browseDuration = new Trend('browse_duration', true);
const deleteDuration = new Trend('delete_duration', true);
const prefixDeleteDuration = new Trend('prefix_delete_duration', true);
const filesUploaded = new Counter('files_uploaded');
const rateLimitHits = new Counter('rate_limit_hits');

// Configurable concurrency via STRESS_TEST_CONCURRENCY env var
// Scales VU count only — think times stay realistic (humans don't click faster with more users)
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = 5;
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

// Realistic file sizes for a cloud IDE
const SMALL_CONTENT = encoding.b64encode(generateContent(1));   // 1 KB - config file
const MEDIUM_CONTENT = encoding.b64encode(generateContent(20)); // 20 KB - source file
const LARGE_CONTENT = encoding.b64encode(generateContent(50));  // 50 KB - large source file

// Randomized think time — simulates a human reading/thinking between actions
function think(minS, maxS) {
  sleep(minS + Math.random() * (maxS - minS));
}

export const options = {
  scenarios: {
    storage_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: scaled(3) },
        { duration: '2m', target: scaled(5) },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    upload_duration: ['p(95)<10000'],
    download_duration: ['p(95)<5000'],
    browse_duration: ['p(95)<3000'],
    errors: ['rate<0.15'],
  },
};

export default function () {
  const filePrefix = `stress-test/${__VU}`;
  const timestamp = Date.now();

  group('storage upload cycle', () => {
    // Pick random file size (weighted toward small — most real edits are small)
    const rand = Math.random();
    const size = rand < 0.6
      ? { name: 'small', content: SMALL_CONTENT }
      : rand < 0.9
        ? { name: 'medium', content: MEDIUM_CONTENT }
        : { name: 'large', content: LARGE_CONTENT };
    const key = `${filePrefix}/${size.name}-${timestamp}.txt`;

    // Upload — user saves a file
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

    // User works in editor for a few seconds before browsing files
    think(3, 8);

    // Browse — user opens file panel
    const browseRes = http.get(
      `${BASE_URL}/api/storage/browse?prefix=${encodeURIComponent(filePrefix)}`,
      { headers: READ_HEADERS, tags: { endpoint: 'GET /api/storage/browse' } }
    );
    check(browseRes, { 'browse ok': (r) => r.status === 200 });
    browseDuration.add(browseRes.timings.duration);

    // User scans the file list
    think(2, 5);

    // Download — user opens a file
    const downloadRes = http.get(
      `${BASE_URL}/api/storage/download?key=${encodeURIComponent(key)}`,
      { headers: READ_HEADERS, tags: { endpoint: 'GET /api/storage/download' } }
    );
    check(downloadRes, { 'download ok': (r) => r.status === 200 });
    downloadDuration.add(downloadRes.timings.duration);

    // User reads the file content
    think(2, 5);

    // Delete — user cleans up
    const deleteRes = http.post(
      `${BASE_URL}/api/storage/delete`,
      JSON.stringify({ keys: [key] }),
      { headers: HEADERS, tags: { endpoint: 'POST /api/storage/delete' } }
    );
    check(deleteRes, { 'delete ok': (r) => r.status === 200 || r.status === 204 });
    deleteDuration.add(deleteRes.timings.duration);
  });

  // ~20% of iterations: user deletes an entire folder (prefix delete)
  if (Math.random() < 0.2) {
    think(2, 5);

    group('folder prefix delete', () => {
      const folderPrefix = `${filePrefix}/folder-${timestamp}`;
      const folderFiles = [`${folderPrefix}/a.txt`, `${folderPrefix}/b.txt`, `${folderPrefix}/c.txt`];

      // Upload a few files into a folder
      for (const fKey of folderFiles) {
        http.post(
          `${BASE_URL}/api/storage/upload`,
          JSON.stringify({ key: fKey, content: SMALL_CONTENT }),
          { headers: HEADERS, tags: { endpoint: 'POST /api/storage/upload' } }
        );
      }

      think(1, 3);

      // Delete entire folder via prefix
      const prefixDeleteRes = http.post(
        `${BASE_URL}/api/storage/delete`,
        JSON.stringify({ prefixes: [`${folderPrefix}/`] }),
        { headers: HEADERS, tags: { endpoint: 'POST /api/storage/delete (prefix)' } }
      );
      check(prefixDeleteRes, {
        'prefix delete ok': (r) => r.status === 200,
        'prefix delete has count': (r) => {
          try {
            const body = JSON.parse(r.body);
            return body.deletedPrefixes && body.deletedPrefixes.length > 0 && body.deletedPrefixes[0].count >= 0;
          } catch { return false; }
        },
      });
      prefixDeleteDuration.add(prefixDeleteRes.timings.duration);
    });
  }

  // User does other stuff before next file operation (typing code, reading docs)
  think(5, 15);
}
