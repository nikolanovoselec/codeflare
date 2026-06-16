import { describe, expect, it, vi } from 'vitest';
import { checkVaultLocalReadiness } from '../../lib/vault-local-readiness';

function createStorage(entries: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(entries));
  return {
    get length() { return store.size; },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => { store.delete(key); }),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
  };
}

function createIndexedDb(names: string[], includeDatabasesApi = true) {
  const idb = {
    open: vi.fn(),
    deleteDatabase: vi.fn(),
    cmp: vi.fn(),
  } as unknown as IDBFactory & { databases?: () => Promise<Array<{ name: string }>> };
  if (includeDatabasesApi) {
    idb.databases = vi.fn(async () => names.map((name) => ({ name })));
  }
  return idb;
}

function createServiceWorker(active = true) {
  const registration = active
    ? { scope: 'https://codeflare.example/api/vault/session-1/', active: { state: 'activated' as ServiceWorkerState } }
    : { scope: 'https://codeflare.example/api/vault/session-1/', active: null };
  return {
    getRegistration: vi.fn(async () => registration),
    getRegistrations: vi.fn(async () => [registration]),
  } as unknown as ServiceWorkerContainer;
}

describe('checkVaultLocalReadiness', () => {
  it('reports ready when this browser has recorded sb_data/sb_files DBs and an active service worker', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc', 'sb_files_def']),
    });

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result).toMatchObject({
      ready: true,
      recordedDbs: ['sb_data_abc', 'sb_files_def'],
      hasIndexedDbDatabasesApi: true,
      serviceWorkerState: 'activated',
    });
  });

  it('does not report ready when the recorder has not seen SilverBullet DBs in this browser', async () => {
    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: createStorage(),
      indexedDbRef: createIndexedDb([]),
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('no-recorder');
  });

  it('does not report ready until both the data and files DBs were recorded', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc']),
    });

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb(['sb_data_abc']),
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('missing-sb-files');
  });

  it('uses indexedDB.databases only to verify one recorded data DB and one recorded files DB still exist', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc', 'sb_files_def']),
    });
    const idb = createIndexedDb(['sb_data_abc']);

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: idb,
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('missing-idb-database');
    expect(idb.open).not.toHaveBeenCalled();
  });

  it('allows stale extra recorded DB names when one data DB and one files DB still exist', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_old', 'sb_files_old', 'sb_data_abc', 'sb_files_def']),
    });

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result.ready).toBe(true);
  });

  it('falls back to recorder and service-worker proof when indexedDB.databases is unavailable', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc', 'sb_files_def']),
    });

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb([], false),
      serviceWorkerRef: createServiceWorker(true),
    });

    expect(result.ready).toBe(true);
    expect(result.hasIndexedDbDatabasesApi).toBe(false);
  });

  it('does not report ready without an active per-session service worker', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc', 'sb_files_def']),
    });

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: createServiceWorker(false),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('missing-service-worker');
  });
});
