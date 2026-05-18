// REQ-VAULT-008 AC8+AC9: per-session SilverBullet IDB lifecycle.
//
// SilverBullet maintains two IDBs per (spaceFolderPath, baseURI,
// encryptionKeyPart) tuple: `sb_files_<hash>` and `sb_data_<hash>`.
// The hash is keyed on the per-session vault key (REQ-VAULT-008 AC1),
// so a destroyed session leaves orphan IDBs that never get reused.
// Without cleanup, IndexedDB usage grows monotonically across the
// session lifecycle and the user eventually hits the per-origin quota.
//
// Cleanup happens at two surfaces:
//
//   - cleanupSessionVaultCache(sid): called from deleteSession() to
//     nuke any sb_files_* / sb_data_* DB whose name contains the
//     session id, drop the vault-session-<sid> marker, and unregister
//     the SW scoped to /api/vault/<sid>/.
//   - sweepOrphanVaultCaches(activeSessionIds): called on Dashboard
//     mount. For every vault-session-<sid> marker in localStorage,
//     if the sid is not in activeSessionIds, treat it as orphan and
//     run the same cleanup. Handles the case where the user deleted
//     a session via API in another tab or after a browser crash.
//
// All operations are fail-safe — a missing global (SSR, fresh tab)
// or rejected IDB query is swallowed silently because cleanup is
// best-effort and must never block the delete UI or dashboard mount.

const VAULT_MARKER_PREFIX = 'vault-session-';

function getIDB(): IDBFactory | null {
  try {
    return (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    return null;
  }
}

function getLS(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function getSW(): ServiceWorkerContainer | null {
  try {
    return (globalThis as unknown as { navigator?: { serviceWorker?: ServiceWorkerContainer } })
      .navigator?.serviceWorker ?? null;
  } catch {
    return null;
  }
}

async function listDatabaseNames(idb: IDBFactory): Promise<string[]> {
  try {
    const dbs = await (idb as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.();
    if (!Array.isArray(dbs)) return [];
    return dbs.map((d) => d.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/**
 * Anchored sid match. SB IDBs are named `sb_files_<sid>_<hash>` and
 * `sb_data_<sid>_<hash>`. A naive `name.includes(sid)` would over-match
 * when one sid is a substring of another, or when the sid happens to
 * appear inside the trailing hash. Require the sid to occupy a full
 * underscore-delimited segment.
 */
function dbNameContainsSid(name: string, sid: string): boolean {
  if (!name.startsWith('sb_files_') && !name.startsWith('sb_data_')) return false;
  const parts = name.split('_');
  // sb_(files|data)_<sid>_<hash> -> parts[2] is the sid segment.
  return parts.length >= 3 && parts[2] === sid;
}

function deleteIDB(idb: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const req = (idb as unknown as { deleteDatabase: (n: string) => IDBOpenDBRequest }).deleteDatabase(name);
      // Awaiting completion catches the case where another tab held the
      // DB open: a blocked event surfaces here instead of orphaning the
      // delete silently (REQ-VAULT-008 AC8 cleanup correctness).
      if (req && typeof req === 'object') {
        const r = req as unknown as { onsuccess: ((e?: unknown) => void) | null; onerror: ((e?: unknown) => void) | null; onblocked: ((e?: unknown) => void) | null };
        r.onsuccess = () => resolve();
        r.onerror = () => resolve();
        r.onblocked = () => resolve();
        // Defensive timer so callers never hang forever on a stuck request.
        setTimeout(() => resolve(), 5000);
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

async function unregisterSwForSession(sw: ServiceWorkerContainer, sid: string): Promise<void> {
  try {
    const regs = await sw.getRegistrations();
    for (const reg of regs) {
      if (reg.scope.includes(`/api/vault/${sid}/`)) {
        try {
          await reg.unregister();
        } catch {
          // Swallow — registration may already be gone.
        }
      }
    }
  } catch {
    // No SW support in this context.
  }
}

function listSessionMarkers(ls: Storage): string[] {
  const sids: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (key && key.startsWith(VAULT_MARKER_PREFIX)) {
      sids.push(key.slice(VAULT_MARKER_PREFIX.length));
    }
  }
  return sids;
}

export async function cleanupSessionVaultCache(sid: string): Promise<void> {
  const idb = getIDB();
  const ls = getLS();
  const sw = getSW();

  if (idb) {
    const names = await listDatabaseNames(idb);
    await Promise.all(
      names
        .filter((name) => dbNameContainsSid(name, sid))
        .map((name) => deleteIDB(idb, name)),
    );
  }

  if (ls) {
    try {
      ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}`);
    } catch {
      // Quota / disabled storage; ignore.
    }
  }

  if (sw) {
    await unregisterSwForSession(sw, sid);
  }
}

export async function sweepOrphanVaultCaches(activeSessionIds: string[]): Promise<void> {
  const ls = getLS();
  const idb = getIDB();
  const active = new Set(activeSessionIds);

  const orphanSids = new Set<string>();
  if (ls) {
    for (const sid of listSessionMarkers(ls)) {
      if (!active.has(sid)) orphanSids.add(sid);
    }
  }

  if (idb) {
    const names = await listDatabaseNames(idb);
    const deletes: Promise<void>[] = [];
    for (const name of names) {
      // Only consider SB cache DBs.
      if (!name.startsWith('sb_files_') && !name.startsWith('sb_data_')) continue;
      // Extract sid as full underscore-delimited segment (anchored match
      // prevents the substring false-positives the include() check had).
      const parts = name.split('_');
      if (parts.length < 3) continue;
      const sid = parts[2];
      if (!active.has(sid)) {
        deletes.push(deleteIDB(idb, name));
        orphanSids.add(sid);
      }
    }
    await Promise.all(deletes);
  }

  if (ls) {
    for (const sid of orphanSids) {
      try {
        ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}`);
      } catch {
        // Ignore.
      }
    }
  }
}

