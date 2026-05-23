// REQ-VAULT-015 AC3+AC4: dashboard-side cleanup for the per-session
// SilverBullet vault.
//
// What this file owns:
//
//   - cleanupSessionVaultCache(sid): called from deleteSession() to drop
//     ALL per-session vault artefacts: the recorded IDBs that the boot
//     recorder captured into `vault-session-<sid>-idbs`, the
//     `vault-session-<sid>` marker, and the service worker registration
//     scoped to `/api/vault/<sid>/`.
//   - sweepOrphanVaultCaches(activeSessionIds): called on Dashboard
//     mount. For every `vault-session-<sid>` and
//     `vault-session-<sid>-idbs` entry in localStorage, if the sid is
//     not in activeSessionIds, drop the marker AND delete every recorded
//     IDB for that sid. Handles sessions deleted from another tab or
//     after a browser crash.
//
// The boot-injected recorder (src/routes/vault.ts injectVaultIdbRecorder)
// is what makes this work: it captures every `sb_*` IDB name SilverBullet
// opens into `vault-session-<sid>-idbs` as a JSON array, so the dashboard
// can delete them by name without re-deriving SB's hash formula.
//
// Principled-rejection invariant (load-bearing): we NEVER call
// `indexedDB.databases()` and never enumerate IDBs from the database
// list. We work exclusively from the recorded localStorage entry. The
// previous implementation parsed `sb_<type>_<hash>` and assumed `parts[2]`
// was the sid; with the real format that field is the sha256 hex and
// every name appeared "orphan", which nuked the live session's IDB on
// every Dashboard mount and forced a full SB resync on every reopen.
// The test file pins this invariant - see vault-cache.test.ts.
//
// All operations are fail-safe - a missing global (SSR, fresh tab) or
// rejected lookup is swallowed silently because cleanup is best-effort
// and must never block the delete UI or dashboard mount.

const VAULT_MARKER_PREFIX = 'vault-session-';
const VAULT_IDBS_SUFFIX = '-idbs';

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

function getIDB(): IDBFactory | null {
  try {
    return (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    return null;
  }
}

async function unregisterSwForSession(sw: ServiceWorkerContainer, sid: string): Promise<void> {
  try {
    const regs = await sw.getRegistrations();
    for (const reg of regs) {
      if (reg.scope.includes(`/api/vault/${sid}/`)) {
        try {
          await reg.unregister();
        } catch {
          // Swallow - registration may already be gone.
        }
      }
    }
  } catch {
    // No SW support in this context.
  }
}

// LOAD-BEARING: this function MUST return a freshly-allocated array
// (not a live iterator or a view over a mutable structure). The caller
// sweepOrphanVaultCaches() calls removeItem() while iterating the
// result; if a future refactor changes this return type to anything
// backed by the live localStorage key index, the removals will race
// the iteration and silently skip entries.
function listSessionMarkers(ls: Storage): string[] {
  const sids = new Set<string>();
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key) continue;
    if (!key.startsWith(VAULT_MARKER_PREFIX)) continue;
    // Strip the prefix, then strip a trailing `-idbs` if present so
    // `vault-session-<sid>` and `vault-session-<sid>-idbs` both
    // contribute the same sid.
    let sid = key.slice(VAULT_MARKER_PREFIX.length);
    if (sid.endsWith(VAULT_IDBS_SUFFIX)) {
      sid = sid.slice(0, -VAULT_IDBS_SUFFIX.length);
    }
    if (sid) sids.add(sid);
  }
  return [...sids];
}

function readRecordedIdbNames(ls: Storage, sid: string): string[] {
  try {
    const raw = ls.getItem(`${VAULT_MARKER_PREFIX}${sid}${VAULT_IDBS_SUFFIX}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // Malformed JSON; treat as empty. The recorder writes well-formed
    // arrays; any other value is either user-tampered or quota-truncated
    // and not safe to interpret.
    return [];
  }
}

function deleteRecordedIdbs(idb: IDBFactory, names: string[]): void {
  // Fire-and-forget: `IDBFactory.deleteDatabase` returns an
  // IDBOpenDBRequest whose `success` fires asynchronously after the
  // request is queued. We intentionally do NOT await - callers clear
  // the localStorage marker on the next line and want that visible
  // immediately so a concurrent Dashboard mount sees the sid as gone.
  // The trade-off: if the queued deletion fails post-marker-clear, the
  // orphan IDB is unrecoverable on later sweeps (no marker -> no
  // recorded names). That is acceptable because (a) deleteDatabase
  // failures in practice mean the IDB is already gone or the page is
  // unloading, and (b) the alternative (await each request) blocks the
  // Dashboard mount on potentially-many concurrent sessions.
  for (const name of names) {
    try {
      idb.deleteDatabase(name);
    } catch {
      // The sync throw path covers cases like a malformed name. Swallow
      // - cleanup is best-effort.
    }
  }
}

/**
 * REQ-VAULT-015 AC3: remove all per-session vault artefacts on session
 * DELETE. Deletes the recorded IDBs, the `vault-session-<sid>-idbs`
 * mapping, the `vault-session-<sid>` marker, and the per-session SW
 * registration.
 */
export async function cleanupSessionVaultCache(sid: string): Promise<void> {
  // Fail-closed input validation: an empty `sid` would compute
  // `removeItem('vault-session-')` (harmless no-op) AND
  // `reg.scope.includes('/api/vault//')`, which could match any registration
  // whose scope contains that exact double-slash substring. Bail out before
  // either side effect when the caller passes a falsy id.
  if (!sid) return;

  const ls = getLS();
  const sw = getSW();
  const idb = getIDB();

  if (ls) {
    if (idb) {
      const recorded = readRecordedIdbNames(ls, sid);
      deleteRecordedIdbs(idb, recorded);
    }
    try {
      ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}${VAULT_IDBS_SUFFIX}`);
    } catch {
      // Quota / disabled storage; ignore.
    }
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

/**
 * REQ-VAULT-015 AC4: remove vault artefacts for sessions that are no
 * longer in `activeSessionIds`. Called on Dashboard mount; catches
 * sessions deleted from another tab or after a browser crash. Deletes
 * the recorded IDBs for orphan sids and drops both the marker and
 * `-idbs` mapping.
 *
 * `listSessionMarkers` snapshots keys before iteration so the
 * `removeItem` call below cannot race the underlying live `localStorage`
 * key index.
 */
export async function sweepOrphanVaultCaches(activeSessionIds: string[]): Promise<void> {
  const ls = getLS();
  if (!ls) return;
  const idb = getIDB();
  const active = new Set(activeSessionIds);
  for (const sid of listSessionMarkers(ls)) {
    if (active.has(sid)) continue;
    if (idb) {
      const recorded = readRecordedIdbNames(ls, sid);
      deleteRecordedIdbs(idb, recorded);
    }
    try {
      ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}${VAULT_IDBS_SUFFIX}`);
    } catch {
      // Ignore.
    }
    try {
      ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}`);
    } catch {
      // Ignore.
    }
  }
}
