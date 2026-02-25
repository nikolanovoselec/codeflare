import { describe, it, expect } from 'vitest';
import { apiRequest } from '../setup';

describe('Storage API', () => {
  it('GET /api/storage/browse returns entries array', async () => {
    const res = await apiRequest('/api/storage/browse');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('GET /api/storage/stats returns storage statistics', async () => {
    const res = await apiRequest('/api/storage/stats');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.totalBytes).toBeGreaterThanOrEqual(0);
    expect(data.fileCounts).toBeDefined();
    expect(data.usage).toBeDefined();
  });

  it('POST /api/storage/seed/getting-started seeds files', async () => {
    const res = await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.files).toBeDefined();
  });

  it('Browse after seeding shows files', async () => {
    // Seed first
    await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });

    const res = await apiRequest('/api/storage/browse');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.entries.length).toBeGreaterThan(0);
  });
});
