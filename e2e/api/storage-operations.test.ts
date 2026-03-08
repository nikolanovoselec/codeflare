import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiRequest } from '../setup';
import { TIMEOUTS } from '../config';
import { createSessionViaApi } from '../helpers';

/**
 * Storage CRUD operation E2E tests.
 * Requires a running container for R2-backed storage.
 *
 * Note: e2e/api/storage.test.ts already tests GET /api/storage/browse,
 * GET /api/storage/stats, and POST /api/storage/seed/getting-started.
 * This file tests upload, download, delete, and move operations.
 */
describe('Storage Operations API', () => {
  let sessionId: string;
  const testFileName = `e2e-test-${Date.now()}.txt`;
  const testFileContent = btoa('Hello from E2E storage test');
  const testSubFolder = `e2e-subfolder-${Date.now()}`;

  beforeAll(async () => {
    const session = await createSessionViaApi({ name: 'E2E Storage Ops Test' });
    sessionId = session.id;

    // Start container
    await apiRequest(`/api/container/start?sessionId=${sessionId}`, { method: 'POST' });

    // Wait for container ready
    const start = Date.now();
    while (Date.now() - start < TIMEOUTS.CONTAINER_STARTUP) {
      const statusRes = await apiRequest(`/api/container/startup-status?sessionId=${sessionId}`);
      const statusData = await statusRes.json();

      if (statusData.stage === 'ready') {
        break;
      }
      if (statusData.stage === 'error') {
        console.warn('Container startup failed, storage tests will be skipped');
        break;
      }

      await new Promise(r => setTimeout(r, TIMEOUTS.CONTAINER_POLL_INTERVAL));
    }
  }, TIMEOUTS.CONTAINER_STARTUP + 10_000);

  afterAll(async () => {
    if (sessionId) {
      // Clean up test files (best-effort)
      await apiRequest('/api/storage/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [testFileName, `${testSubFolder}/${testFileName}`, `renamed-${testFileName}`] }),
      }).catch(() => {});

      // Stop and delete session
      await apiRequest(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
      await apiRequest(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
  }, TIMEOUTS.CONTAINER_STARTUP);

  it('POST /api/storage/upload uploads a file', async () => {
    // Storage upload works without container (direct R2), but test with container context
    const res = await apiRequest('/api/storage/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: testFileName, content: testFileContent }),
    });
    expect(res.ok).toBe(true);
  });

  it('GET /api/storage/browse shows uploaded file', async () => {
    const res = await apiRequest('/api/storage/browse');
    expect(res.ok).toBe(true);
    const data = await res.json();
    const fileNames = data.objects.map((o: { key: string }) => o.key);
    expect(fileNames).toContain(testFileName);
  });

  it('POST /api/storage/upload to subfolder places file correctly', async () => {
    const subKey = `${testSubFolder}/${testFileName}`;
    const res = await apiRequest('/api/storage/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: subKey, content: testFileContent }),
    });
    expect(res.ok).toBe(true);

    // Verify it shows up in browse with prefix
    const browseRes = await apiRequest(`/api/storage/browse?prefix=${encodeURIComponent(testSubFolder + '/')}`);
    expect(browseRes.ok).toBe(true);
    const browseData = await browseRes.json();
    const keys = browseData.objects.map((o: { key: string }) => o.key);
    expect(keys).toContain(subKey);
  });

  it('GET /api/storage/download returns file content', async () => {
    const res = await apiRequest(`/api/storage/download?key=${encodeURIComponent(testFileName)}`);
    expect(res.ok).toBe(true);
    // Download returns the raw file content
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it('POST /api/storage/move renames a file', async () => {
    const newName = `renamed-${testFileName}`;
    const res = await apiRequest('/api/storage/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: testFileName, destination: newName }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.source).toBe(testFileName);
    expect(data.destination).toBe(newName);

    // Verify old file is gone and new file exists
    const browseRes = await apiRequest('/api/storage/browse');
    const browseData = await browseRes.json();
    const keys = browseData.objects.map((o: { key: string }) => o.key);
    expect(keys).not.toContain(testFileName);
    expect(keys).toContain(newName);

    // Move it back so cleanup works
    await apiRequest('/api/storage/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: newName, destination: testFileName }),
    });
  });

  it('POST /api/storage/delete removes a file', async () => {
    // Upload a throwaway file
    const throwawayKey = `e2e-delete-test-${Date.now()}.txt`;
    await apiRequest('/api/storage/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: throwawayKey, content: testFileContent }),
    });

    const res = await apiRequest('/api/storage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [throwawayKey] }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.deleted).toContain(throwawayKey);

    // Verify it's gone
    const browseRes = await apiRequest('/api/storage/browse');
    const browseData = await browseRes.json();
    const keys = browseData.objects.map((o: { key: string }) => o.key);
    expect(keys).not.toContain(throwawayKey);
  });

  it('POST /api/storage/delete with multiple keys batch-deletes', async () => {
    const keys = [`e2e-batch-1-${Date.now()}.txt`, `e2e-batch-2-${Date.now()}.txt`];

    // Upload both
    for (const key of keys) {
      await apiRequest('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, content: testFileContent }),
      });
    }

    // Batch delete
    const res = await apiRequest('/api/storage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.deleted.length).toBe(2);
  });

  it('POST /api/storage/delete with prefixes deletes folder contents server-side', async () => {
    const folderPrefix = `e2e-prefix-delete-${Date.now()}/`;
    const fileKeys = [
      `${folderPrefix}file-a.txt`,
      `${folderPrefix}file-b.txt`,
      `${folderPrefix}sub/file-c.txt`,
    ];

    // Upload files into the folder
    for (const key of fileKeys) {
      await apiRequest('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, content: testFileContent }),
      });
    }

    // Verify files exist
    const browseRes = await apiRequest(`/api/storage/browse?prefix=${encodeURIComponent(folderPrefix)}`);
    const browseData = await browseRes.json();
    expect(browseData.objects.length + browseData.prefixes.length).toBeGreaterThan(0);

    // Delete entire folder via prefix
    const res = await apiRequest('/api/storage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [folderPrefix] }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.deletedPrefixes).toBeDefined();
    expect(data.deletedPrefixes.length).toBe(1);
    expect(data.deletedPrefixes[0].prefix).toBe(folderPrefix);
    expect(data.deletedPrefixes[0].count).toBe(3);

    // Verify folder is empty
    const verifyRes = await apiRequest(`/api/storage/browse?prefix=${encodeURIComponent(folderPrefix)}`);
    const verifyData = await verifyRes.json();
    expect(verifyData.objects.length).toBe(0);
  });

  it('POST /api/storage/delete with mixed keys and prefixes', async () => {
    const folderPrefix = `e2e-mixed-delete-${Date.now()}/`;
    const standaloneKey = `e2e-mixed-standalone-${Date.now()}.txt`;
    const folderKey = `${folderPrefix}nested-file.txt`;

    // Upload standalone file and folder file
    for (const key of [standaloneKey, folderKey]) {
      await apiRequest('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, content: testFileContent }),
      });
    }

    // Delete both in one call
    const res = await apiRequest('/api/storage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [standaloneKey], prefixes: [folderPrefix] }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.deleted).toContain(standaloneKey);
    expect(data.deletedPrefixes[0].prefix).toBe(folderPrefix);
    expect(data.deletedPrefixes[0].count).toBe(1);
  });
});
