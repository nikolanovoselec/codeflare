import { describe, it, expect } from 'vitest';
import { apiRequest } from '../setup';

describe('Setup status endpoint', () => {
  it('GET /api/setup/status returns configured true', async () => {
    const res = await apiRequest('/api/setup/status');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.configured).toBe(true);
  });

  it('customDomain field is a string if present', async () => {
    const res = await apiRequest('/api/setup/status');
    const data = await res.json();
    if ('customDomain' in data && data.customDomain !== null && data.customDomain !== undefined) {
      expect(typeof data.customDomain).toBe('string');
    }
  });
});
