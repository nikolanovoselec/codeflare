// REQ-VAULT-008 AC8+AC9: vault-cache cleans up dashboard-side bookkeeping
// (localStorage markers + per-session service-worker registration) on
// session DELETE and on dashboard mount.
//
// IDB deletion is intentionally NOT part of this contract. SilverBullet's
// IDB names are `sb_<type>_<sha256>` where the hash inputs include the
// session id transitively (via the request URL) but the sid is not a
// literal name segment. The dashboard does not have the inputs needed to
// reproduce that hash (encryption key, spaceFolderPath, baseURI), so it
// can't safely identify which IDB belongs to which session by name alone.
// The previous code naively parsed `parts[2]` as the sid, which never
// matched a real session id, and the sweep nuked every SB IDB on every
// Dashboard mount -- forcing SilverBullet to rebuild its cache and
// resync from scratch on every reopen. Removing IDB deletion is a
// trade-off: stale IDBs leak until the per-origin storage quota evicts
// them, which is dramatically better UX than nuking the live session's
// IDB. The full sid->IDB mapping fix is tracked in sdd/pending.md under
// REQ-VAULT-008 AC3 (blocked on SilverBullet upstream).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanupSessionVaultCache, sweepOrphanVaultCaches } from '../../lib/vault-cache';

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
  const registrations: { scope: string; unregister: () => Promise<boolean> }[] = [];
  const sw = {
    getRegistrations: vi.fn(async () => registrations),
    getRegistration: vi.fn(async (scope?: string) => registrations.find((r) => !scope || r.scope.includes(scope))),
  };
  (globalThis as unknown as { navigator: { serviceWorker: typeof sw } }).navigator = { serviceWorker: sw };
  return { sw, registrations };
}

describe('cleanupSessionVaultCache (REQ-VAULT-008 AC8)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { navigator?: unknown }).navigator;
    // Survive mid-test assertion failure: clear the IDB stub the
    // regression-guard tests install (otherwise a failed assertion
    // would leak the stub into subsequent suites).
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it('removes the localStorage vault-session-<sid> marker for the deleted session', async () => {
    const sid = 'abcdef12';
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}`, '1');
    store.set('vault-session-other', '1');
    installFakeServiceWorker();
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}`);
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-other');
  });

  it('unregisters the service-worker scoped to the deleted session', async () => {
    const sid = 'abcdef12';
    installFakeLocalStorage();
    const { registrations } = installFakeServiceWorker();
    const targeted = vi.fn(async () => true);
    const untargeted = vi.fn(async () => true);
    registrations.push({ scope: `https://codeflare.ch/api/vault/${sid}/`, unregister: targeted });
    registrations.push({ scope: `https://codeflare.ch/api/vault/different/`, unregister: untargeted });
    await cleanupSessionVaultCache(sid);
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(untargeted).not.toHaveBeenCalled();
  });

  it('does not throw if globals are missing (SSR / test pre-mount safety)', async () => {
    await expect(cleanupSessionVaultCache('abcdef12')).resolves.toBeUndefined();
  });

  // Regression guard: the previous implementation listed IndexedDB and
  // tried to parse session ids out of `sb_<type>_<hash>` names. Reverting
  // to that behaviour would nuke every SilverBullet IDB on every cleanup
  // call. This test fails if cleanupSessionVaultCache ever calls
  // indexedDB.databases() or indexedDB.deleteDatabase() again.
  it('does NOT touch IndexedDB (regression guard for the rebuild-on-reopen bug)', async () => {
    const databases = vi.fn(async () => []);
    const deleteDatabase = vi.fn();
    (globalThis as unknown as { indexedDB: { databases: typeof databases; deleteDatabase: typeof deleteDatabase } }).indexedDB = {
      databases,
      deleteDatabase,
    };
    installFakeLocalStorage();
    installFakeServiceWorker();
    await cleanupSessionVaultCache('abcdef12');
    expect(databases).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });
});

describe('sweepOrphanVaultCaches (REQ-VAULT-008 AC9)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { navigator?: unknown }).navigator;
    // Survive mid-test assertion failure: clear the IDB stub the
    // regression-guard tests install (otherwise a failed assertion
    // would leak the stub into subsequent suites).
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it('removes vault-session-<sid> markers for sessions that are no longer active', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-active1', '1');
    store.set('vault-session-orphan', '1');
    installFakeServiceWorker();
    await sweepOrphanVaultCaches(['active1']);
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan');
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active1');
  });

  it('is a no-op when every marker matches an active session (must not touch the active session\'s IDB)', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-a', '1');
    installFakeServiceWorker();
    await sweepOrphanVaultCaches(['a']);
    expect(fake.removeItem).not.toHaveBeenCalled();
  });

  it('does not throw if localStorage is missing', async () => {
    await expect(sweepOrphanVaultCaches(['active1'])).resolves.toBeUndefined();
  });

  // Regression guard: the previous implementation iterated
  // indexedDB.databases() and deleted any DB whose `parts[2]` segment
  // wasn't in the active set. Since real SB IDB names are
  // `sb_<type>_<sha256>` (no sid segment), every name appeared "orphan"
  // and the sweep nuked the live session's cache on every Dashboard
  // mount. Force this code path to NEVER touch IDB again.
  it('does NOT touch IndexedDB (regression guard for the rebuild-on-reopen bug)', async () => {
    const databases = vi.fn(async () => []);
    const deleteDatabase = vi.fn();
    (globalThis as unknown as { indexedDB: { databases: typeof databases; deleteDatabase: typeof deleteDatabase } }).indexedDB = {
      databases,
      deleteDatabase,
    };
    const { store } = installFakeLocalStorage();
    store.set('vault-session-orphan', '1');
    installFakeServiceWorker();
    await sweepOrphanVaultCaches([]);
    expect(databases).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });
});
