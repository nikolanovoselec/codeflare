/**
 * Tests for safeCheckContainerHealth (CF-021)
 *
 * safeCheckContainerHealth avoids auto-starting stopped containers by
 * checking getState() first (read-only) before calling checkContainerHealth()
 * which uses container.fetch() (auto-starts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock circuit breakers to be pass-through
const passThroughCB = { execute: vi.fn((fn: () => Promise<unknown>) => fn()), reset: vi.fn() };
vi.mock('../../lib/circuit-breakers', () => ({
  getContainerHealthCB: () => passThroughCB,
}));

import { safeCheckContainerHealth } from '../../lib/container-helpers';

describe('safeCheckContainerHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls health check when container state is running', async () => {
    const healthData = { status: 'healthy', cpu: '10%', mem: '1.5/3.0G' };
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(healthData), { status: 200 })
      ),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(true);
    expect(result.data).toEqual(healthData);
    expect(mockContainer.getState).toHaveBeenCalledTimes(1);
    expect(mockContainer.fetch).toHaveBeenCalledTimes(1);
  });

  it('calls health check when container state is healthy', async () => {
    const healthData = { status: 'healthy' };
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(healthData), { status: 200 })
      ),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(true);
    expect(result.data).toEqual(healthData);
    expect(mockContainer.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips health check when container state is stopped', async () => {
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
      fetch: vi.fn(),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('stopped');
    // fetch should NOT be called - that would auto-start the container
    expect(mockContainer.fetch).not.toHaveBeenCalled();
  });

  it('skips health check when container state is created', async () => {
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'created' }),
      fetch: vi.fn(),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('created');
    expect(mockContainer.fetch).not.toHaveBeenCalled();
  });

  it('returns unknown status when getState() throws', async () => {
    const mockContainer = {
      getState: vi.fn().mockRejectedValue(new Error('DO not reachable')),
      fetch: vi.fn(),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('unknown');
    // fetch should NOT be called when getState fails
    expect(mockContainer.fetch).not.toHaveBeenCalled();
  });

  it('returns unhealthy when health check response is non-200', async () => {
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      fetch: vi.fn().mockResolvedValue(
        new Response('Service Unavailable', { status: 503 })
      ),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('503');
  });

  it('returns unhealthy when health check fetch throws', async () => {
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      fetch: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.error).toContain('Connection refused');
  });

  it('handles unknown state value by skipping health check', async () => {
    const mockContainer = {
      getState: vi.fn().mockResolvedValue({ status: 'terminating' }),
      fetch: vi.fn(),
    };

    const result = await safeCheckContainerHealth(mockContainer as any, 'test-container-id');

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('terminating');
    expect(mockContainer.fetch).not.toHaveBeenCalled();
  });
});
