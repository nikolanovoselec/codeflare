import { describe, expect, it, vi } from 'vitest';
import { checkVaultLocalReadiness, checkVaultKeyRecoverable, markVaultFullyPrewarmed, hasVaultFullyPrewarmed } from '../../lib/vault-local-readiness';

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

  // REQ-VAULT-021: the SW now registers under the bucket-stable `/api/vault/<token>/`
  // scope, which differs from the session id the dashboard checks readiness for.
  // The lookup must match any vault-scoped registration, not one named by sid.
  it('finds the vault service worker even when its scope segment is the bucket token, not the session id', async () => {
    const storage = createStorage({
      'vault-session-session-1-idbs': JSON.stringify(['sb_data_abc', 'sb_files_def']),
    });
    const tokenScopedSw = {
      getRegistration: vi.fn(async () => undefined),
      getRegistrations: vi.fn(async () => [
        { scope: 'https://codeflare.example/api/vault/0123456789abcdef0123456789abcdef/', active: { state: 'activated' as ServiceWorkerState } },
      ]),
    } as unknown as ServiceWorkerContainer;

    const result = await checkVaultLocalReadiness('session-1', {
      localStorageRef: storage,
      indexedDbRef: createIndexedDb(['sb_data_abc', 'sb_files_def']),
      serviceWorkerRef: tokenScopedSw,
    });

    expect(result.ready).toBe(true);
    expect(result.serviceWorkerState).toBe('activated');
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

describe('REQ-VAULT-022 AC2: full-prewarm marker keyed to the container start', () => {
  it('reports warm for the same container start that recorded the marker (a page reload)', () => {
    const storage = createStorage();
    expect(hasVaultFullyPrewarmed('session-1', 'start-1', storage)).toBe(false);
    markVaultFullyPrewarmed('session-1', 'start-1', storage);
    expect(hasVaultFullyPrewarmed('session-1', 'start-1', storage)).toBe(true);
  });

  it('reports NOT warm when the container start advanced, forcing a clean re-init on a resumed session', () => {
    const storage = createStorage();
    markVaultFullyPrewarmed('session-1', 'start-1', storage);
    // The container was stopped and resumed: lastStartedAt advanced, so the persisted
    // marker no longer counts as warm and the vault re-initializes like a fresh session.
    expect(hasVaultFullyPrewarmed('session-1', 'start-2', storage)).toBe(false);
  });

  it('reports NOT warm when the current container start has not polled in yet, so a resumed session never skips onto a stale store', () => {
    const storage = createStorage();
    // On a page reload/return the batch-status poll has not re-delivered
    // lastStartedAt yet, so the current start is momentarily null. A null current
    // start is NOT proof the container is the same one, so it must never authorize
    // a reload-skip (that is exactly what let a RESUMED session flip green and skip
    // prewarm onto stale files). The reload-skip effect re-runs and arms once the
    // start polls in and matches.
    markVaultFullyPrewarmed('session-1', 'start-1', storage);
    expect(hasVaultFullyPrewarmed('session-1', null, storage)).toBe(false);
    expect(hasVaultFullyPrewarmed('session-1', undefined, storage)).toBe(false);
  });

  it('a start-less prewarm records no marker, so it re-prewarms next time rather than over-skipping', () => {
    const storage = createStorage();
    // Prewarm proved out before lastStartedAt was known: with no real start to
    // match against later, recording nothing is correct — the next visit re-prewarms
    // (safe) instead of skipping onto a store whose container it cannot verify.
    markVaultFullyPrewarmed('session-1', null, storage);
    markVaultFullyPrewarmed('session-1', '', storage);
    expect(hasVaultFullyPrewarmed('session-1', 'start-1', storage)).toBe(false);
  });

  it('never reads warm against an empty store', () => {
    // A fresh session before any prewarm: no marker exists, so it must never
    // over-skip onto a non-existent store.
    expect(hasVaultFullyPrewarmed('session-1', 'start-1', createStorage())).toBe(false);
    expect(hasVaultFullyPrewarmed('session-1', null, createStorage())).toBe(false);
  });

  it('scopes the marker per session so another session is not falsely reported warm', () => {
    const storage = createStorage();
    markVaultFullyPrewarmed('session-1', 'start-1', storage);
    expect(hasVaultFullyPrewarmed('session-2', 'start-1', storage)).toBe(false);
  });

  it('reports not-prewarmed and swallows write errors when storage is unavailable', () => {
    expect(hasVaultFullyPrewarmed('session-1', 'start-1', null)).toBe(false);
    expect(() => markVaultFullyPrewarmed('session-1', 'start-1', null)).not.toThrow();
  });
});
