// REQ-VAULT-008 AC8+AC9: cleanupSessionVaultCache(sid) and
// sweepOrphanVaultCaches(activeSessionIds) clean up the per-session
// SilverBullet IndexedDB databases on session DELETE and on dashboard
// mount respectively. These are pure functions over IDB + localStorage
// + service-worker APIs; the tests stub each surface with vi.fn().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanupSessionVaultCache, sweepOrphanVaultCaches } from '../../lib/vault-cache';

type DbInfo = { name: string };

function installFakeIndexedDB(initialDbs: DbInfo[]) {
  const deleted: string[] = [];
  const fake = {
    databases: vi.fn(async () => initialDbs.slice()),
    deleteDatabase: vi.fn((name: string) => {
      deleted.push(name);
      // Mimic real IDB: deleteDatabase returns an IDBOpenDBRequest whose
      // onsuccess fires once the deletion commits. The production code
      // (deleteIDB in vault-cache.ts) now awaits this callback so the
      // blocked-event path no longer orphans deletes; tests must fire
      // onsuccess on the next microtask or the 5s safety timer trips
      // and the test exceeds vitest's 5s timeout.
      const req: { onsuccess: ((e?: unknown) => void) | null; onerror: ((e?: unknown) => void) | null; onblocked: ((e?: unknown) => void) | null } = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }),
  };
  (globalThis as unknown as { indexedDB: typeof fake }).indexedDB = fake;
  return { fake, deleted };
}

function installFakeLocalStorage() {
  const store = new Map<string, string>();
  const fake = {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    key: vi.fn((i: number) => Array.from(store.keys())[i] ?? null),
    get length() { return store.size; },
    clear: vi.fn(() => store.clear()),
  };
  (globalThis as unknown as { localStorage: typeof fake }).localStorage = fake;
  return { fake, store };
}

function installFakeServiceWorker() {
  const unregistered: string[] = [];
  const registrations: { scope: string; unregister: () => Promise<boolean> }[] = [];
  const sw = {
    getRegistrations: vi.fn(async () => registrations),
    getRegistration: vi.fn(async (scope?: string) => {
      const reg = registrations.find((r) => !scope || r.scope.includes(scope));
      return reg;
    }),
  };
  (globalThis as unknown as { navigator: { serviceWorker: typeof sw } }).navigator = { serviceWorker: sw };
  return { sw, registrations, unregistered };
}

describe('cleanupSessionVaultCache (REQ-VAULT-008 AC8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('deletes IDBs whose names contain the session id', async () => {
    const sid = 'abcdef12';
    const { fake } = installFakeIndexedDB([
      { name: `sb_files_${sid}_hash1` },
      { name: `sb_data_${sid}_hash1` },
      { name: 'sb_files_otherid_hash2' },
      { name: 'unrelated-db' },
    ]);
    installFakeLocalStorage();
    installFakeServiceWorker();
    await cleanupSessionVaultCache(sid);
    const deletedNames = fake.deleteDatabase.mock.calls.map((c) => c[0]);
    expect(deletedNames).toContain(`sb_files_${sid}_hash1`);
    expect(deletedNames).toContain(`sb_data_${sid}_hash1`);
    expect(deletedNames).not.toContain('sb_files_otherid_hash2');
    expect(deletedNames).not.toContain('unrelated-db');
  });

  it('removes the localStorage vault-session-<sid> marker', async () => {
    const sid = 'abcdef12';
    installFakeIndexedDB([]);
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}`, '1');
    store.set('vault-session-other', '1');
    installFakeServiceWorker();
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}`);
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-other');
  });

  it('unregisters service worker scoped to the session id', async () => {
    const sid = 'abcdef12';
    installFakeIndexedDB([]);
    installFakeLocalStorage();
    const { registrations } = installFakeServiceWorker();
    const unregisterSpy = vi.fn(async () => true);
    registrations.push({ scope: `https://codeflare.ch/api/vault/${sid}/`, unregister: unregisterSpy });
    registrations.push({ scope: `https://codeflare.ch/api/vault/other/`, unregister: vi.fn(async () => true) });
    await cleanupSessionVaultCache(sid);
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw if indexedDB.databases() rejects', async () => {
    const sid = 'abcdef12';
    (globalThis as unknown as { indexedDB: { databases: () => Promise<never>; deleteDatabase: (n: string) => void } }).indexedDB = {
      databases: () => Promise.reject(new Error('not supported')),
      deleteDatabase: vi.fn(),
    };
    installFakeLocalStorage();
    installFakeServiceWorker();
    await expect(cleanupSessionVaultCache(sid)).resolves.toBeUndefined();
  });

  it('does not throw if globals are missing (SSR / test pre-mount safety)', async () => {
    await expect(cleanupSessionVaultCache('abcdef12')).resolves.toBeUndefined();
  });
});

describe('sweepOrphanVaultCaches (REQ-VAULT-008 AC9)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('nukes IDBs whose sid is not in the active list', async () => {
    const { fake } = installFakeIndexedDB([
      { name: 'sb_files_active1_hash' },
      { name: 'sb_data_active1_hash' },
      { name: 'sb_files_orphan_hash' },
      { name: 'sb_data_orphan_hash' },
    ]);
    const { store } = installFakeLocalStorage();
    store.set('vault-session-active1', '1');
    store.set('vault-session-orphan', '1');
    installFakeServiceWorker();

    await sweepOrphanVaultCaches(['active1']);
    const deletedNames = fake.deleteDatabase.mock.calls.map((c) => c[0]);
    expect(deletedNames).toContain('sb_files_orphan_hash');
    expect(deletedNames).toContain('sb_data_orphan_hash');
    expect(deletedNames).not.toContain('sb_files_active1_hash');
    expect(deletedNames).not.toContain('sb_data_active1_hash');
  });

  it('is a no-op when all sessions are active', async () => {
    const { fake } = installFakeIndexedDB([
      { name: 'sb_files_a_h' },
      { name: 'sb_data_a_h' },
    ]);
    const { store } = installFakeLocalStorage();
    store.set('vault-session-a', '1');
    installFakeServiceWorker();
    await sweepOrphanVaultCaches(['a']);
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
  });

  it('removes orphan localStorage markers even if no IDB matches', async () => {
    installFakeIndexedDB([]);
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-orphan', '1');
    installFakeServiceWorker();
    await sweepOrphanVaultCaches([]);
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan');
  });
});
