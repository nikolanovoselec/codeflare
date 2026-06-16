import { describe, expect, it, vi } from 'vitest';
import { requestBrowserStoragePersistence } from '../../lib/browser-storage-persistence';

type TestStorageManager = NonNullable<Parameters<typeof requestBrowserStoragePersistence>[0]>;

function storageManager(overrides: Partial<TestStorageManager> = {}): TestStorageManager {
  return overrides as TestStorageManager;
}

describe('requestBrowserStoragePersistence', () => {
  it('reports unsupported when the browser has no storage manager', async () => {
    await expect(requestBrowserStoragePersistence(undefined)).resolves.toEqual({ supported: false });
  });

  it('returns already-persisted status without asking again', async () => {
    const persist = vi.fn(async () => false);
    const result = await requestBrowserStoragePersistence(storageManager({
      persisted: vi.fn(async () => true),
      persist,
      estimate: vi.fn(async () => ({ usage: 12, quota: 34 })),
    }));

    expect(result).toEqual({ supported: true, persisted: true, granted: true, usage: 12, quota: 34 });
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence when not already persisted', async () => {
    const result = await requestBrowserStoragePersistence(storageManager({
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => true),
    }));

    expect(result).toEqual({ supported: true, persisted: true, granted: true });
  });

  it('does not treat a denied persistence request as fatal', async () => {
    const result = await requestBrowserStoragePersistence(storageManager({
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => false),
    }));

    expect(result).toEqual({ supported: true, persisted: false, granted: false });
  });

  it('still reports persistence support when quota estimation fails', async () => {
    const result = await requestBrowserStoragePersistence(storageManager({
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => true),
      estimate: vi.fn(async () => { throw new Error('blocked'); }),
    }));

    expect(result).toEqual({ supported: true, persisted: true, granted: true });
  });
});
