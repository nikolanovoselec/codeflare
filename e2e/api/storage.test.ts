import { describe, it, expect } from 'vitest';
import { apiRequest } from '../setup';

describe('Storage API', () => {
  it('GET /api/storage/browse returns objects array', async () => {
    const res = await apiRequest('/api/storage/browse');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.objects).toBeDefined();
    expect(Array.isArray(data.objects)).toBe(true);
    expect(data.prefixes).toBeDefined();
    expect(typeof data.isTruncated).toBe('boolean');
  });

  it('GET /api/storage/stats returns storage statistics', async () => {
    const res = await apiRequest('/api/storage/stats');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.totalSizeBytes).toBeGreaterThanOrEqual(0);
    expect(typeof data.totalFiles).toBe('number');
    expect(typeof data.totalFolders).toBe('number');
    expect(data.bucketName).toBeDefined();
  });

  it('POST /api/storage/seed/getting-started seeds files', async () => {
    const res = await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.written).toBeDefined();
    expect(Array.isArray(data.written)).toBe(true);
  });

  it('Browse after seeding shows files', async () => {
    // Seed first
    await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });

    const res = await apiRequest('/api/storage/browse');
    expect(res.ok).toBe(true);
    const data = await res.json();
    // After seeding, objects or prefixes should be non-empty
    const hasContent = data.objects.length > 0 || data.prefixes.length > 0;
    expect(hasContent).toBe(true);
  });
});
