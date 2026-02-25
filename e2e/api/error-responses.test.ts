import { describe, it, expect } from 'vitest';
import { apiRequest, BASE_URL } from '../setup';

describe('Error responses', () => {
  it('GET nonexistent session returns 404', async () => {
    const res = await apiRequest('/api/sessions/nonexistent999');
    expect(res.status).toBe(404);
  });

  it('POST session with invalid body type returns 400 or 429', async () => {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"not-an-object"',
    });
    // Rate limiter runs before validation, so may return 429 if other tests
    // have consumed the session-create budget in the same 1-minute window
    expect([400, 429]).toContain(res.status);
  });

  it('DELETE without X-Requested-With header returns 403', async () => {
    // Use raw fetch to skip apiRequest's auto-added X-Requested-With header
    // Must include X-Service-Auth so auth passes — we're testing CSRF, not auth
    const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID!;
    const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;
    const res = await fetch(`${BASE_URL}/api/sessions/some-id`, {
      method: 'DELETE',
      headers: {
        'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
        'X-Service-Auth': CF_ACCESS_CLIENT_SECRET,
      },
    });
    expect(res.status).toBe(403);
  });

  it('POST storage/delete with empty paths returns 400', async () => {
    const res = await apiRequest('/api/storage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    expect(res.status).toBe(400);
  });
});
