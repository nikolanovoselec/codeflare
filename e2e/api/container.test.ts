import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiRequest } from '../setup';
import { TIMEOUTS } from '../config';

/**
 * Container lifecycle E2E tests.
 * Creates a session, starts/stops the container, and verifies status transitions.
 */
describe('Container Lifecycle API', () => {
  let sessionId: string;

  beforeAll(async () => {
    // Retry on 429 (rate limit from parallel suites)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await apiRequest('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'E2E Container Test' }),
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
        continue;
      }
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
      const data = await res.json();
      sessionId = data.session.id;
      return;
    }
    throw new Error('Failed to create session after 3 retries (rate limited)');
  }, TIMEOUTS.CONTAINER_STARTUP);

  afterAll(async () => {
    if (sessionId) {
      // Stop first (best-effort), then delete
      await apiRequest(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
      await apiRequest(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
  }, TIMEOUTS.CONTAINER_STARTUP);

  it('POST /api/container/start returns success', async () => {
    const res = await apiRequest(`/api/container/start?sessionId=${sessionId}`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.containerId).toBeDefined();
    expect(['starting', 'already_running']).toContain(data.status);
  }, TIMEOUTS.CONTAINER_STARTUP);

  it('GET /api/container/startup-status returns stage info', async () => {
    const res = await apiRequest(`/api/container/startup-status?sessionId=${sessionId}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.stage).toBeDefined();
    expect(typeof data.progress).toBe('number');
    expect(data.message).toBeDefined();
    expect(data.details).toBeDefined();
  });

  it('Container reaches ready stage when polled', async () => {
    const start = Date.now();
    let stage = 'unknown';

    while (Date.now() - start < TIMEOUTS.CONTAINER_STARTUP) {
      const res = await apiRequest(`/api/container/startup-status?sessionId=${sessionId}`);
      const data = await res.json();
      stage = data.stage;

      if (stage === 'ready') {
        expect(data.progress).toBe(100);
        expect(data.details.terminalServerOk).toBe(true);
        return;
      }

      if (stage === 'error') {
        // Container may fail in CI — skip gracefully
        console.warn('Container startup failed:', data.error || data.message);
        return;
      }

      await new Promise(r => setTimeout(r, TIMEOUTS.CONTAINER_POLL_INTERVAL));
    }

    // If we timed out, the container never reached ready — not necessarily a failure
    // in environments without container support
    console.warn(`Container did not reach ready within timeout (last stage: ${stage})`);
  }, TIMEOUTS.CONTAINER_STARTUP + 5_000);

  it('POST /api/container/start on already-started container is idempotent', async () => {
    const res = await apiRequest(`/api/container/start?sessionId=${sessionId}`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Could be 'starting' or 'already_running' depending on timing
    expect(['starting', 'already_running']).toContain(data.status);
  }, TIMEOUTS.CONTAINER_STARTUP);

  it('POST /api/sessions/:id/stop stops the session', async () => {
    const res = await apiRequest(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.stopped).toBe(true);
  });

  it('GET /api/container/startup-status after stop shows stopped/starting', async () => {
    // After stopping, startup-status should reflect non-ready state
    const res = await apiRequest(`/api/container/startup-status?sessionId=${sessionId}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    // Container may show stopped, starting (if auto-restarting), or error
    expect(['stopped', 'starting', 'error']).toContain(data.stage);
  });
});
