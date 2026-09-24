import { describe, expect, it, vi } from 'vitest';

const passThroughCB = { execute: (fn: () => Promise<unknown>) => fn(), reset: vi.fn() };
vi.mock('../../lib/circuit-breakers', () => ({ getContainerHealthCB: () => passThroughCB }));

import { safeCheckContainerHealth } from '../../lib/container-helpers';

// SDK fetch can start a replacement. These fixtures throw if the health probe
// ever takes that path, rather than asserting a private mock call count.
function existingRuntime(status: string, forward: () => Promise<Response>) {
  return {
    getState: async () => ({ status }),
    fetch: async () => { throw new Error('SDK fetch would auto-start a container'); },
    forwardExisting: forward,
  };
}

describe('safeCheckContainerHealth / REQ-SESSION-012', () => {
  it.each(['running', 'stopped', 'stopped_with_code'])('accepts a responding survivor despite SDK %s', async (status) => {
    const healthData = { status: 'healthy', cpu: '10%', mem: '1.5/3.0G' };
    const runtime = existingRuntime(status, async () => new Response(JSON.stringify(healthData), { status: 200 }));
    const result = await safeCheckContainerHealth(runtime as any, 'test-container-id');
    expect(result).toMatchObject({ healthy: true, data: healthData });
  });

  it('does not depend on persisted SDK state being available', async () => {
    const runtime = {
      ...existingRuntime('stopped', async () => new Response(JSON.stringify({ status: 'healthy' }), { status: 200 })),
      getState: async () => { throw new Error('stale SDK state unavailable'); },
    };
    expect((await safeCheckContainerHealth(runtime as any, 'test-container-id')).healthy).toBe(true);
  });

  it('returns retryable unavailability without waking an absent runtime', async () => {
    const runtime = existingRuntime('stopped', async () => new Response('Not running', { status: 503 }));
    const result = await safeCheckContainerHealth(runtime as any, 'test-container-id');
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('503');
  });

  it('does not infer stopped from a failed private-port probe', async () => {
    const runtime = existingRuntime('running', async () => { throw new Error('Connection refused'); });
    const result = await safeCheckContainerHealth(runtime as any, 'test-container-id');
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});
