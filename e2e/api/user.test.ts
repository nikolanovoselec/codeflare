import { describe, it, expect } from 'vitest';
import { apiRequest } from '../setup';

describe('User profile endpoint', () => {
  it('GET /api/user returns authenticated user profile', async () => {
    const res = await apiRequest('/api/user');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.email).toBeTruthy();
    expect(data.authenticated).toBe(true);
    expect(data.role).toBeDefined();
    expect(data.bucketName).toBeDefined();
    expect(data.workerName).toBeDefined();
  });

  it('GET /api/user includes onboardingActive boolean', async () => {
    const res = await apiRequest('/api/user');
    const data = await res.json();
    expect(typeof data.onboardingActive).toBe('boolean');
  });

  it('GET /api/user/r2-status returns { ready: boolean }', async () => {
    const res = await apiRequest('/api/user/r2-status');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(typeof data.ready).toBe('boolean');
  });
});
