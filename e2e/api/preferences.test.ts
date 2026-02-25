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
});
