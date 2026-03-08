import { describe, it, expect, afterAll } from 'vitest';
import { apiRequest } from '../setup';

describe('Preferences API', () => {
  let originalPrefs: Record<string, unknown>;

  afterAll(async () => {
    // Reset preferences to original state
    if (originalPrefs) {
      await apiRequest('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(originalPrefs),
      });
    }
  });

  it('GET /api/preferences returns object', async () => {
    const res = await apiRequest('/api/preferences');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
    originalPrefs = data;
  });

  it('PATCH /api/preferences updates and persists', async () => {
    const patchRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceSyncEnabled: true }),
    });
    expect(patchRes.ok).toBe(true);

    const getRes = await apiRequest('/api/preferences');
    const data = await getRes.json();
    expect(data.workspaceSyncEnabled).toBe(true);
  });

  it('PATCH fastStartEnabled persists across requests', async () => {
    // Disable fast start
    const patchRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fastStartEnabled: false }),
    });
    expect(patchRes.ok).toBe(true);

    // Confirm persistence via GET
    const getRes = await apiRequest('/api/preferences');
    const data = await getRes.json();
    expect(data.fastStartEnabled).toBe(false);

    // Restore to true
    const restoreRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fastStartEnabled: true }),
    });
    expect(restoreRes.ok).toBe(true);

    // Verify restore
    const verifyRes = await apiRequest('/api/preferences');
    const verifyData = await verifyRes.json();
    expect(verifyData.fastStartEnabled).toBe(true);
  });

  it('PATCH sessionMode to "default" persists across GET', async () => {
    const patchRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'default' }),
    });
    expect(patchRes.ok).toBe(true);

    const getRes = await apiRequest('/api/preferences');
    const data = await getRes.json();
    expect(data.sessionMode).toBe('default');
  });

  it('PATCH sessionMode to "advanced" persists across GET', async () => {
    const patchRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'advanced' }),
    });
    expect(patchRes.ok).toBe(true);

    const getRes = await apiRequest('/api/preferences');
    const data = await getRes.json();
    expect(data.sessionMode).toBe('advanced');
  });

  it('PATCH rejects invalid sessionMode', async () => {
    const patchRes = await apiRequest('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'expert' }),
    });
    expect(patchRes.status).toBe(400);
  });
});
