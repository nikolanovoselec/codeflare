import { describe, it, expect } from 'vitest';
import { apiRequest } from '../setup';

describe('Health endpoints', () => {
  it('GET /health returns ok status', async () => {
    const res = await apiRequest('/health');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /api/health returns ok with valid timestamp', async () => {
    const res = await apiRequest('/api/health');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
    expect(new Date(data.timestamp).toISOString()).toBe(data.timestamp);
  });
});
