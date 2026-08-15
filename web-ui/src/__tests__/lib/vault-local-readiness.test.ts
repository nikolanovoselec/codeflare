import { describe, expect, it, vi } from 'vitest';
import { checkVaultLocalReadiness, checkVaultKeyRecoverable, markVaultFullyPrewarmed, hasVaultFullyPrewarmed } from '../../lib/vault-local-readiness';

const CURRENT_SCOPE = 'https://codeflare.example/api/vault/0123456789abcdef0123456789abcdef/';
const LEGACY_SCOPE = 'https://codeflare.example/api/vault/abcdef12/';
const IDB_KEY = 'vault-session-session-1-idbs';
const SCOPE_KEY = 'vault-session-session-1-scope';

function createStorage(entries: Record<string, string> = {}, addCurrentScope = true): Storage {
  const initialEntries = addCurrentScope && IDB_KEY in entries && !(SCOPE_KEY in entries)
    ? { ...entries, [SCOPE_KEY]: CURRENT_SCOPE }
    : entries;
  const store = new Map(Object.entries(initialEntries));
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

function createReadyStorage(recordedDbs = ['sb_data_abc', 'sb_files_def']): Storage {
  return createStorage({
    [IDB_KEY]: JSON.stringify(recordedDbs),
    [SCOPE_KEY]: CURRENT_SCOPE,
  });
}

function createServiceWorker(active = true, registrations?: Array<{ scope: string; active: { state: ServiceWorkerState } | null }>) {
  const current = {
    scope: CURRENT_SCOPE,
    active: active ? { state: 'activated' as ServiceWorkerState } : null,
  };
  const available = registrations ?? [current];
  return {
    getRegistration: vi.fn(async (clientUrl?: string) =>
      available.find((registration) => registration.scope === clientUrl)),
    getRegistrations: vi.fn(async () => available),
  } as unknown as ServiceWorkerContainer;
}

// REQ-VAULT-018: Vault control gating and on-demand prewarm trigger

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

  it('requires the active service worker at the exact scope recorded with the current databases', async () => {
    const serviceWorker = createServiceWorker(true, [
      { scope: LEGACY_SCOPE, active: { state: 'activated' } },
      { scope: CURRENT_SCOPE, active: { state: 'activated' } },
    ]);

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: createReadyStorage(),
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: serviceWorker,
    });

    expect(result.ready).toBe(true);
    expect(serviceWorker.getRegistration).toHaveBeenCalledWith(CURRENT_SCOPE);
    expect(serviceWorker.getRegistrations).not.toHaveBeenCalled();
  });

  it('does not let an orphaned legacy registration satisfy current readiness', async () => {
    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: createReadyStorage(),
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: createServiceWorker(true, [
        { scope: LEGACY_SCOPE, active: { state: 'activated' } },
      ]),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('missing-service-worker');
  });

  it('forces the unchanged prewarm lifecycle when legacy readiness has no recorded scope', async () => {
    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: createStorage({ [IDB_KEY]: JSON.stringify(['sb_data_old', 'sb_files_old']) }, false),
      indexedDbRef: createIndexedDb(['sb_data_old', 'sb_files_old']),
      serviceWorkerRef: createServiceWorker(true, [
        { scope: LEGACY_SCOPE, active: { state: 'activated' } },
      ]),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('missing-service-worker-scope');
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

  it('accepts an activating current worker during update but rejects a redundant worker', async () => {
    const run = (state: ServiceWorkerState) => checkVaultLocalReadiness('session-1', {
      localStorageRef: createReadyStorage(),
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: createServiceWorker(true, [{ scope: CURRENT_SCOPE, active: { state } }]),
    });

    await expect(run('activating')).resolves.toMatchObject({ ready: true, serviceWorkerState: 'activating' });
    await expect(run('redundant')).resolves.toMatchObject({ ready: false, reason: 'missing-service-worker' });
  });
});

describe('REQ-VAULT-019: checkVaultKeyRecoverable', () => {
  const okResponse = (key: unknown) => ({ ok: true, json: async () => ({ key }) }) as unknown as Response;

  it('GETs the session /.vault-key endpoint with credentials and returns true on a non-empty key', async () => {
    const fetchRef = vi.fn(async () => okResponse('deadbeefkey')) as unknown as typeof fetch;
    const result = await checkVaultKeyRecoverable('session-1', { fetchRef });
    expect(result).toBe(true);
    expect(fetchRef).toHaveBeenCalledWith(
      '/api/vault/session-1/.vault-key',
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'include' }),
    );
  });

  it('returns false when the endpoint responds non-2xx (server key recovery failed)', async () => {
    const fetchRef = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Key recovery failed' }) }) as unknown as Response) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef })).toBe(false);
  });

  it('returns false when the key is empty or missing', async () => {
    const empty = vi.fn(async () => okResponse('')) as unknown as typeof fetch;
    const missing = vi.fn(async () => okResponse(undefined)) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: empty })).toBe(false);
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: missing })).toBe(false);
  });

  it('returns false when the request throws (cookie stripped / network down)', async () => {
    const fetchRef = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef })).toBe(false);
  });

  it('returns false when no fetch implementation is available', async () => {
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: null })).toBe(false);
  });
});

describe('REQ-VAULT-022 AC2: full-prewarm marker', () => {
  it('records and reports the per-session full-prewarm marker', () => {
    const storage = createStorage();
    expect(hasVaultFullyPrewarmed('session-1', storage)).toBe(false);
    markVaultFullyPrewarmed('session-1', storage);
    expect(hasVaultFullyPrewarmed('session-1', storage)).toBe(true);
  });

  it('scopes the marker per session so another session is not falsely reported warm', () => {
    const storage = createStorage();
    markVaultFullyPrewarmed('session-1', storage);
    expect(hasVaultFullyPrewarmed('session-2', storage)).toBe(false);
  });

  it('reports not-prewarmed and swallows write errors when storage is unavailable', () => {
    expect(hasVaultFullyPrewarmed('session-1', null)).toBe(false);
    expect(() => markVaultFullyPrewarmed('session-1', null)).not.toThrow();
  });
});
