import { describe, it, expect, afterAll } from 'vitest';
import { apiRequest } from '../setup';

/**
 * Preset CRUD E2E tests.
 * Presets are per-user saved session configurations (max 3).
 */
describe('Presets API', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    // Clean up all created presets
    for (const id of createdIds) {
      await apiRequest(`/api/presets/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  const validPresetBody = {
    name: 'E2E Test Preset',
    tabs: [{ id: '1', command: 'bash', label: 'Bash' }],
  };

  it('GET /api/presets returns presets array', async () => {
    const res = await apiRequest('/api/presets');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.presets).toBeDefined();
    expect(Array.isArray(data.presets)).toBe(true);
  });

  it('POST /api/presets creates a preset', async () => {
    const res = await apiRequest('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPresetBody),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.preset).toBeDefined();
    expect(data.preset.id).toBeDefined();
    expect(data.preset.name).toBe('E2E Test Preset');
    expect(data.preset.tabs).toHaveLength(1);
    expect(data.preset.createdAt).toBeDefined();
    createdIds.push(data.preset.id);
  });

  it('GET /api/presets lists the created preset', async () => {
    const res = await apiRequest('/api/presets');
    expect(res.ok).toBe(true);
    const data = await res.json();
    const ids = data.presets.map((p: { id: string }) => p.id);
    expect(ids).toContain(createdIds[0]);
  });

  it('DELETE /api/presets/:id removes the preset', async () => {
    // Create a preset to delete
    const createRes = await apiRequest('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Delete', tabs: [{ id: '1', command: 'bash', label: 'Bash' }] }),
    });
    const created = await createRes.json();
    const deleteId = created.preset.id;

    const deleteRes = await apiRequest(`/api/presets/${deleteId}`, { method: 'DELETE' });
    expect(deleteRes.ok).toBe(true);
    const deleteData = await deleteRes.json();
    expect(deleteData.success).toBe(true);

    // Verify it's gone from the list
    const listRes = await apiRequest('/api/presets');
    const listData = await listRes.json();
    const ids = listData.presets.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(deleteId);
  });

  it('POST /api/presets beyond max limit returns 400', async () => {
    // Create presets up to the limit (MAX_PRESETS = 3)
    // We already have 1 from earlier, create 2 more
    for (let i = 0; i < 2; i++) {
      const res = await apiRequest('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Filler ${i}`, tabs: [{ id: '1', command: 'bash', label: 'Bash' }] }),
      });
      if (res.status === 201) {
        const data = await res.json();
        createdIds.push(data.preset.id);
      }
    }

    // Now the 4th should fail
    const overflowRes = await apiRequest('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Overflow', tabs: [{ id: '1', command: 'bash', label: 'Bash' }] }),
    });
    expect(overflowRes.ok).toBe(false);
    expect(overflowRes.status).toBe(400);
  });
});
