import { describe, it, expect, afterAll } from 'vitest';
import { apiRequest } from '../setup';
import { TIMEOUTS } from '../config';
import {
  createSessionViaApi,
  deleteSessionViaApi,
  startContainerViaApi,
  stopSessionViaApi,
  setPreference,
  waitForContainerReadyViaApi,
} from '../helpers';

/**
 * Container lifecycle E2E tests — strict readiness assertions.
 * These tests verify full container startup, restart, Fast Start behavior,
 * and multi-session isolation.
 */
describe('Container Lifecycle - Strict Readiness', () => {
  const sessionIds: string[] = [];

  afterAll(async () => {
    // Restore fast start preference
    await setPreference('fastStartEnabled', true).catch(() => {});
    // Stop and delete all sessions created during tests
    for (const id of sessionIds) {
      await stopSessionViaApi(id).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      await deleteSessionViaApi(id).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    }
  }, TIMEOUTS.CONTAINER_STARTUP);

  it('starts and terminal server becomes functional', async () => {
    const { id } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(id);
    await startContainerViaApi(id);
    await waitForContainerReadyViaApi(id);

    // Verify terminal server health and metrics
    const res = await apiRequest(`/api/container/startup-status?sessionId=${id}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.stage).toBe('ready');
    expect(data.details.terminalServerOk).toBe(true);
    expect(typeof data.details.cpuPercent).toBe('number');
    expect(typeof data.details.memoryMb).toBe('number');
  }, 45_000);

  it('stops and restarts to ready', async () => {
    const { id } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(id);
    await startContainerViaApi(id);
    await waitForContainerReadyViaApi(id);

    // Stop the container
    await stopSessionViaApi(id);
    await new Promise(r => setTimeout(r, 2_000));

    // Verify it's no longer ready
    const stoppedRes = await apiRequest(`/api/container/startup-status?sessionId=${id}`);
    const stoppedData = await stoppedRes.json();
    expect(stoppedData.stage).not.toBe('ready');

    // Restart and wait for ready again
    await startContainerViaApi(id);
    await waitForContainerReadyViaApi(id);

    const readyRes = await apiRequest(`/api/container/startup-status?sessionId=${id}`);
    const readyData = await readyRes.json();
    expect(readyData.stage).toBe('ready');
    expect(readyData.details.terminalServerOk).toBe(true);
  }, 90_000);

  it('Fast Start ON completes under 60s', async () => {
    await setPreference('fastStartEnabled', true);
    const { id } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(id);
    await startContainerViaApi(id);
    const { elapsed } = await waitForContainerReadyViaApi(id);

    expect(elapsed).toBeLessThan(60_000);
    console.log(`[E2E] Fast Start ON: container ready in ${(elapsed / 1000).toFixed(1)}s`);
  }, 60_000);

  it('Fast Start OFF still starts', async () => {
    await setPreference('fastStartEnabled', false);
    const { id } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(id);
    await startContainerViaApi(id);
    const { stage } = await waitForContainerReadyViaApi(id, TIMEOUTS.CONTAINER_STARTUP_EXTENDED);

    expect(stage).toBe('ready');
  }, 120_000);

  it('two concurrent sessions do not interfere', async () => {
    const { id: idA } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(idA);
    await startContainerViaApi(idA);
    await waitForContainerReadyViaApi(idA);

    const { id: idB } = await createSessionViaApi({ agentType: 'bash' });
    sessionIds.push(idB);
    await startContainerViaApi(idB);
    await waitForContainerReadyViaApi(idB);

    // Stop session A
    await stopSessionViaApi(idA);
    await new Promise(r => setTimeout(r, 2_000));

    // Session B should still be ready
    const res = await apiRequest(`/api/container/startup-status?sessionId=${idB}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.stage).toBe('ready');
  }, 90_000);
});
