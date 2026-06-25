// REQ-VAULT-015 AC3+AC4 (as reconciled by REQ-VAULT-021): vault-cache removes
// the per-session localStorage markers on session DELETE and orphan sweep, and
// MUST NOT delete the bucket-stable SilverBullet IndexedDB stores or unregister
// the bucket-stable service worker — those persist across sessions by design
// (REQ-VAULT-021), so tearing them down on a per-session event would erase the
// next session's vault and force a full re-index.

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

describe('cleanupSessionVaultCache (REQ-VAULT-015 AC3 / REQ-VAULT-021)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  // REQ-VAULT-021: the IndexedDB store is bucket-stable and shared across all of
  // a user's sessions; per-session DELETE must NOT delete it.
  it('does NOT delete the recorded sb_ IndexedDB stores (bucket-stable persistence)', async () => {
    const sid = 'abcdef12';
    const { store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}-idbs`, JSON.stringify(['sb_data_aaaaaaaa', 'sb_files_bbbbbbbb']));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await cleanupSessionVaultCache(sid);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  // REQ-VAULT-021: the vault SW is bucket-stable; per-session DELETE must NOT
  // unregister it (the next session reuses it for a fast open).
  it('does NOT unregister the vault service worker', async () => {
    const sid = 'abcdef12';
    installFakeLocalStorage();
    const { registrations } = installFakeServiceWorker();
    installFakeIndexedDB();
    const unregister = vi.fn(async () => true);
    registrations.push({ scope: `https://codeflare.ch/api/vault/${sid}/`, unregister });
    await cleanupSessionVaultCache(sid);
    expect(unregister).not.toHaveBeenCalled();
  });

  it('removes the vault-session-<sid>-idbs mapping', async () => {
    const sid = 'abcdef12';
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}-idbs`, JSON.stringify(['sb_data_xxx']));
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}-idbs`);
  });

  it('removes the vault-session-<sid> marker and leaves other sessions intact', async () => {
    const sid = 'abcdef12';
    const { fake, store } = installFakeLocalStorage();
    store.set(`vault-session-${sid}`, '1');
    store.set('vault-session-other', '1');
    await cleanupSessionVaultCache(sid);
    expect(fake.removeItem).toHaveBeenCalledWith(`vault-session-${sid}`);
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-other');
  });

  it('is a graceful no-op for an empty sid', async () => {
    const { fake } = installFakeLocalStorage();
    await cleanupSessionVaultCache('');
    expect(fake.removeItem).not.toHaveBeenCalled();
  });

  it('does not throw if globals are missing (SSR / test pre-mount safety)', async () => {
    await expect(cleanupSessionVaultCache('abcdef12')).resolves.toBeUndefined();
  });
});

describe('sweepOrphanVaultCaches (REQ-VAULT-015 AC4 / REQ-VAULT-021)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  it('does NOT delete the recorded sb_ IndexedDB stores for orphan sessions (bucket-stable persistence)', async () => {
    const { store } = installFakeLocalStorage();
    store.set('vault-session-active1-idbs', JSON.stringify(['sb_data_active1']));
    store.set('vault-session-orphan-idbs', JSON.stringify(['sb_data_orphan']));
    installFakeServiceWorker();
    const { deleteDatabase } = installFakeIndexedDB();
    await sweepOrphanVaultCaches(['active1']);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('removes vault-session-<sid> and -idbs markers for orphan sessions, preserving active', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-active1', '1');
    store.set('vault-session-orphan', '1');
    store.set('vault-session-orphan-idbs', JSON.stringify(['sb_files_orphan']));
    await sweepOrphanVaultCaches(['active1']);
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan');
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan-idbs');
    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active1');
  });

  it('is a no-op when every marker matches an active session', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-a-idbs', JSON.stringify(['sb_data_a']));
    await sweepOrphanVaultCaches(['a']);
    expect(fake.removeItem).not.toHaveBeenCalled();
  });

  it('treats a -idbs orphan with no plain marker as still an orphan', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-onlyidbs-idbs', JSON.stringify(['sb_data_o']));
    await sweepOrphanVaultCaches([]);
    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-onlyidbs-idbs');
  });

  it('does not throw if localStorage is missing', async () => {
    await expect(sweepOrphanVaultCaches(['active1'])).resolves.toBeUndefined();
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

    await sweepOrphanVaultCaches(['active01']);

    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active01-prewarmed');
    expect(store.has('vault-session-active01-prewarmed')).toBe(true);
  });

  it('removes the prewarmed marker for an ORPHAN session during a sweep', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-orphan9-prewarmed', '1');

    await sweepOrphanVaultCaches([]);

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan9-prewarmed');
    expect(store.has('vault-session-orphan9-prewarmed')).toBe(false);
  });

  it('removes the prewarmed marker on session DELETE', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-deadbeef-prewarmed', '1');

    await cleanupSessionVaultCache('deadbeef');

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-deadbeef-prewarmed');
    expect(store.has('vault-session-deadbeef-prewarmed')).toBe(false);
  });
});

// REQ-VAULT-018 AC11: the persisted "opened" latch settles the Vault button out
// of green-breathing after the first open and survives the mobile PWA reload. It
// shares the `vault-session-*` namespace, so the sweep MUST treat `<sid>-opened`
// as belonging to `<sid>` (preserve for active, drop for orphan/delete) — without
// the suffix arm the active session's latch is read as a bogus orphan sid and
// erased on the next authoritative sweep, re-breaking the mobile settle.
describe('REQ-VAULT-018 AC11: opened settle latch (vault-session-<sid>-opened) lifecycle', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { clearGlobals(); });

  it('preserves the opened marker for an ACTIVE session during an orphan sweep', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-active01-opened', '1');
    store.set('vault-session-active01-idbs', JSON.stringify(['sb_data_a', 'sb_files_b']));

    await sweepOrphanVaultCaches(['active01']);

    expect(fake.removeItem).not.toHaveBeenCalledWith('vault-session-active01-opened');
    expect(store.has('vault-session-active01-opened')).toBe(true);
  });

  it('removes the opened marker for an ORPHAN session during a sweep', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-orphan9-opened', '1');

    await sweepOrphanVaultCaches([]);

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-orphan9-opened');
    expect(store.has('vault-session-orphan9-opened')).toBe(false);
  });

  it('removes the opened marker on session DELETE', async () => {
    const { fake, store } = installFakeLocalStorage();
    store.set('vault-session-deadbeef-opened', '1');

    await cleanupSessionVaultCache('deadbeef');

    expect(fake.removeItem).toHaveBeenCalledWith('vault-session-deadbeef-opened');
    expect(store.has('vault-session-deadbeef-opened')).toBe(false);
  });
});
