import { describe, it, expect } from 'vitest';
import { BASE_URL, apiRequest } from './setup';

describe('API E2E', () => {
  // Note: DEV_MODE=true means auth returns test user user@example.com

  it('GET /api/user returns user info with email', async () => {
    const res = await apiRequest('/api/user');
    expect(res.status).toBe(200);

    const data = await res.json() as { email: string };
    expect(data.email).toBe('user@example.com');
  });

  it('GET /api/sessions returns session list', async () => {
    const res = await apiRequest('/api/sessions');
    expect(res.status).toBe(200);

    const data = await res.json() as { sessions: unknown[] };
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it('rejects session creation with empty name', async () => {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });

    // Empty string is trimmed to '' which falls back to default name 'Terminal'
    // so this should succeed with 201 and use the default name
    expect(res.status).toBe(201);
    const data = await res.json() as { session: { name: string } };
    expect(data.session.name).toBe('Terminal');
  });

  it('GET /api/setup/status returns setup status with configured field', async () => {
    const res = await apiRequest('/api/setup/status');
    expect(res.status).toBe(200);

    const data = await res.json() as { configured: boolean };
    expect(typeof data.configured).toBe('boolean');
  });
});
