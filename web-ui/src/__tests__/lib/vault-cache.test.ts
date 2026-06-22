// REQ-VAULT-015 AC3+AC4: vault-cache deletes the SilverBullet IDBs for a
// removed session and sweeps orphan IDBs on dashboard mount.
//
// The deletion path relies on the boot-injected recorder (see
// src/routes/vault.ts injectVaultIdbRecorder) writing every sb_* IDB
// name SilverBullet opens into localStorage["vault-session-<sid>-idbs"]
// as a JSON array. cleanupSessionVaultCache and sweepOrphanVaultCaches
// read that array and call indexedDB.deleteDatabase per entry. They
// MUST NEVER enumerate via indexedDB.databases() — the regression
// described in vault-cache.ts pinned that as forbidden (the old
// implementation nuked the live session on every Dashboard mount).

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

function installFakeIndexedDB() {
  const deleteDatabase = vi.fn();
  const databases = vi.fn(async () => []);
  const idb = { deleteDatabase, databases };
  (globalThis as unknown as { indexedDB: typeof idb }).indexedDB = idb;
  return { idb, deleteDatabase, databases };
}

function clearGlobals() {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
}

describe('cleanupSessionVaultCache (REQ-VAULT-015 AC3)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  // REQ-VAULT-015 AC3 (deletes every sb_ database recorded for the session)
  it('deletes every recorded sb_ IDB for the session', async () => {
    const sid = 'abcdef12';
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}-idbs`, JSON.stringify([
      `sb_data_aaaaaaaa`,
      `sb_files_bbbbbbbb`,
    ]));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await cleanupSessionVaultCache(sid);
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
    expect(deleteDatabase).toHaveBeenCalledWith(`sb_data_aaaaaaaa`);
    expect(deleteDatabase).toHaveBeenCalledWith(`sb_files_bbbbbbbb`);
  });

  // REQ-VAULT-015 AC3 (removes localStorage["vault-session-<sid>-idbs"])
  it('removes the vault-session-<sid>-idbs mapping after deleting', async () => {
    const sid = 'abcdef12';
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}-idbs`, JSON.stringify([`sb_data_xxx`]));
    installFakeServiceWorker();
    installFakeIndexedDB();
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}-idbs`);
  });

  // REQ-VAULT-015 AC3 (removes localStorage["vault-session-<sid>"])
  it('removes the vault-session-<sid> marker (preserved from prior behaviour)', async () => {
    const sid = 'abcdef12';
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}`, '1');
    store.set('vault-session-other', '1');
    installFakeServiceWorker();
    installFakeIndexedDB();
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}`);
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-other');
  });

  // REQ-VAULT-015 AC3 (unregisters the SilverBullet service worker scoped to /api/vault/<sid>/)
  it('unregisters the service worker scoped to /api/vault/<sid>/ (preserved)', async () => {
    const sid = 'abcdef12';
    installFakeLocalStorage();
    const { registrations } = installFakeServiceWorker();
    installFakeIndexedDB();
    const targeted = vi.fn(async () => true);
    const untargeted = vi.fn(async () => true);
    registrations.push({ scope: `https://codeflare.ch/api/vault/${sid}/`, unregister: targeted });
    registrations.push({ scope: `https://codeflare.ch/api/vault/different/`, unregister: untargeted });
    await cleanupSessionVaultCache(sid);
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(untargeted).not.toHaveBeenCalled();
  });

  // REQ-VAULT-015 AC3 (graceful safety: missing -idbs mapping)
  it('is a graceful no-op when the -idbs mapping is missing', async () => {
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-abcdef12`, '1'); // marker present, no IDB mapping
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await cleanupSessionVaultCache('abcdef12');
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // REQ-VAULT-015 AC3 (graceful safety: malformed JSON)
  it('is a graceful no-op when the -idbs value is malformed JSON', async () => {
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-abcdef12-idbs`, '<<not json>>');
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await cleanupSessionVaultCache('abcdef12');
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // REQ-VAULT-015 AC3 (graceful safety: non-array JSON)
  it('is a graceful no-op when the -idbs value is not a JSON array', async () => {
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-abcdef12-idbs`, JSON.stringify({ not: 'an array' }));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await cleanupSessionVaultCache('abcdef12');
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // Principled-rejection invariant: NEVER enumerate IDBs via
  // indexedDB.databases(). The recorded mapping is the only source of
  // truth. If a future refactor reintroduces databases(), the live
  // session's IDB gets nuked on every Dashboard mount (the bug this
  // file was written to prevent).
  // REQ-VAULT-008 Constraint (IDB cleanup helpers MUST NEVER enumerate via indexedDB.databases())
  it('does NOT call indexedDB.databases() — only acts on recorded names', async () => {
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-abcdef12-idbs`, JSON.stringify([`sb_data_xxx`]));
    installFakeServiceWorker();
    const { databases } = installFakeIndexedDB();
    await cleanupSessionVaultCache('abcdef12');
    expect(databases).not.toHaveBeenCalled();
  });

  // REQ-VAULT-015 AC3 (graceful safety: missing globals)
  it('does not throw if globals are missing (SSR / test pre-mount safety)', async () => {
    await expect(cleanupSessionVaultCache('abcdef12')).resolves.toBeUndefined();
  });

  // REQ-VAULT-015 AC3 (graceful safety: missing indexedDB global)
  it('does not throw if indexedDB global is missing but localStorage exists', async () => {
    installFakeLocalStorage();
    installFakeServiceWorker();
    // No installFakeIndexedDB.
    await expect(cleanupSessionVaultCache('abcdef12')).resolves.toBeUndefined();
  });
});

describe('sweepOrphanVaultCaches (REQ-VAULT-015 AC4)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  // REQ-VAULT-015 AC4 (sweeps every -idbs entry; for sids NOT in active list, deletes recorded IDBs)
  it('deletes recorded sb_ IDBs for sessions that are not active', async () => {
    const { store } = installFakeLocalStorage();
    store.set('vault-session-active1-idbs', JSON.stringify(['sb_data_active1']));
    store.set('vault-session-orphan-idbs', JSON.stringify(['sb_data_orphan']));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await sweepOrphanVaultCaches(['active1']);
    expect(deleteDatabase).toHaveBeenCalledWith('sb_data_orphan');
    expect(deleteDatabase).not.toHaveBeenCalledWith('sb_data_active1');
  });

  // REQ-VAULT-015 AC4 (drops both vault-session-<sid> and -idbs entries for orphan sids)
  it('removes vault-session-<sid> and -idbs entries for orphan sessions', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-active1', '1');
    store.set('vault-session-orphan', '1');
    store.set('vault-session-orphan-idbs', JSON.stringify(['sb_files_orphan']));
    installFakeServiceWorker();
    installFakeIndexedDB();
    await sweepOrphanVaultCaches(['active1']);
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan');
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan-idbs');
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active1');
  });

  // REQ-VAULT-015 AC4 (active sessions are preserved; only orphan sids are swept)
  it('is a no-op when every marker matches an active session', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-a-idbs', JSON.stringify(['sb_data_a']));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await sweepOrphanVaultCaches(['a']);
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(fake.removeItem).not.toHaveBeenCalled();
  });

  // REQ-VAULT-015 AC4 (sweep iterates every -idbs entry; -idbs alone is sufficient to identify a sid for cleanup)
  it('treats a -idbs orphan with no plain marker as still an orphan', async () => {
    // The recorder may write the -idbs entry before the dashboard ever
    // writes the plain marker (or the plain marker may have been
    // already cleaned). Either way, the -idbs entry is the source of
    // truth for the sid and must drive the sweep.
    const { store } = installFakeLocalStorage();
    store.set('vault-session-onlyidbs-idbs', JSON.stringify(['sb_data_o']));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await sweepOrphanVaultCaches([]);
    expect(deleteDatabase).toHaveBeenCalledWith('sb_data_o');
  });

  // REQ-VAULT-015 AC4 (graceful safety: missing localStorage)
  it('does not throw if localStorage is missing', async () => {
    await expect(sweepOrphanVaultCaches(['active1'])).resolves.toBeUndefined();
  });

  // REQ-VAULT-015 AC4 (graceful safety: malformed -idbs value)
  it('handles malformed -idbs values gracefully (no throw, nothing deleted)', async () => {
    const { store } = installFakeLocalStorage();
    store.set('vault-session-bad-idbs', 'not-json');
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await sweepOrphanVaultCaches([]);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // Principled-rejection invariant: NEVER enumerate IDBs via
  // indexedDB.databases() in the sweep path either. See the equivalent
  // guard in the cleanup describe block.
  // REQ-VAULT-008 Constraint (sweep path also MUST NEVER call indexedDB.databases())
  it('does NOT call indexedDB.databases() — only acts on recorded names', async () => {
    const { store } = installFakeLocalStorage();
    store.set('vault-session-orphan-idbs', JSON.stringify(['sb_data_orphan']));
    installFakeServiceWorker();
    const { databases } = installFakeIndexedDB();
    await sweepOrphanVaultCaches([]);
    expect(databases).not.toHaveBeenCalled();
  });
});

// REQ-VAULT-018 AC8: the durable full-prewarm marker lets a reload skip remounting
// the bootstrap iframe. It lives under the same `vault-session-*` namespace the
// cache sweep manages, so the sweep MUST treat `<sid>-prewarmed` as belonging to
// `<sid>` (preserve it for active sessions, drop it for orphans/deletes) instead
// of mistaking it for a bogus orphan session and erasing it on every Layout mount.
describe('REQ-VAULT-018 AC8: full-prewarm marker (vault-session-<sid>-prewarmed) lifecycle', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  it('preserves the prewarmed marker for an ACTIVE session during an orphan sweep', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-active01-prewarmed', '1');
    store.set('vault-session-active01-idbs', JSON.stringify(['sb_data_a', 'sb_files_b']));
    installFakeServiceWorker();
    installFakeIndexedDB();

    await sweepOrphanVaultCaches(['active01']);

    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active01-prewarmed');
    expect(store.has('vault-session-active01-prewarmed')).toBe(true);
  });

  it('removes the prewarmed marker for an ORPHAN session during a sweep', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-orphan9-prewarmed', '1');
    installFakeServiceWorker();
    installFakeIndexedDB();

    await sweepOrphanVaultCaches([]);

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan9-prewarmed');
    expect(store.has('vault-session-orphan9-prewarmed')).toBe(false);
  });

  it('removes the prewarmed marker on session DELETE', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-deadbeef-prewarmed', '1');
    installFakeServiceWorker();
    installFakeIndexedDB();

    await cleanupSessionVaultCache('deadbeef');

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-deadbeef-prewarmed');
    expect(store.has('vault-session-deadbeef-prewarmed')).toBe(false);
  });
});
