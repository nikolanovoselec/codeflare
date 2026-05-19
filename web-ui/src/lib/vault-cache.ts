// REQ-VAULT-008 AC8+AC9: dashboard-side bookkeeping cleanup for the
// per-session SilverBullet vault.
//
// IDB deletion is intentionally OUT of scope here - see the long block
// comment above `cleanupSessionVaultCache` below for the why. This file
// only manages two artifacts that the dashboard itself writes:
//
//   - cleanupSessionVaultCache(sid): called from deleteSession() to
//     drop the `vault-session-<sid>` localStorage marker and unregister
//     the service worker scoped to `/api/vault/<sid>/`.
//   - sweepOrphanVaultCaches(activeSessionIds): called on Dashboard
//     mount. For every `vault-session-<sid>` marker in localStorage,
//     if the sid is not in activeSessionIds, drop the marker. Handles
//     sessions deleted from another tab or after a browser crash.
//
// All operations are fail-safe - a missing global (SSR, fresh tab) or
// rejected lookup is swallowed silently because cleanup is best-effort
// and must never block the delete UI or dashboard mount.

const VAULT_MARKER_PREFIX = 'vault-session-';

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
  const sids: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (key && key.startsWith(VAULT_MARKER_PREFIX)) {
      sids.push(key.slice(VAULT_MARKER_PREFIX.length));
    }
  }
  return sids;
}

// IMPORTANT: SilverBullet's actual IDB name is `sb_<type>_<sha256-hex>`
// where the hash is over (spaceFolderPath + ':' + baseURI + ':' + key).
// The session id is one of several hash *inputs*, not a literal segment.
// Earlier versions of this module assumed `sb_<type>_<sid>_<hash>` and
// parsed `parts[2]` as the sid -- with the real format that field is the
// sha256 hex, which never matches a real sid, so the sweep deleted every
// SB IDB on every Dashboard mount and forced SilverBullet to rebuild from
// scratch on every reopen. See `plug-api/lib/crypto.ts:deriveDbName` in
// the upstream silverbullet repo for the canonical formula.
//
// We cannot recover the sid from an IDB name without the encryption key,
// the spaceFolderPath, and the baseURI -- inputs the dashboard does not
// have. So we DO NOT attempt to delete IDBs by name from the sweep path.
// `cleanupSessionVaultCache` is also a no-op for IDB deletion: the
// matching of sid -> hash is blocked on a SilverBullet upstream change
// (see sdd/pending.md REQ-VAULT-008 AC3). Until that lands we accept the
// trade-off: stale IDBs leak until the per-origin storage quota evicts
// them, which is dramatically better UX than nuking the live session's
// IDB and forcing a 30-second resync on every SB reopen.
//
// What IS still cleaned up:
//   - The localStorage `vault-session-<sid>` marker is removed (so the
//     dashboard's own bookkeeping does not grow forever).
//   - The service-worker registration scoped to /api/vault/<sid>/ is
//     unregistered (no longer relevant once the session is gone).

/**
 * REQ-VAULT-008 AC8: remove dashboard-side bookkeeping for a deleted
 * session. Drops the `vault-session-<sid>` localStorage marker and
 * unregisters the per-session service worker. IDB deletion is
 * deliberately omitted - see file header.
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

/**
 * REQ-VAULT-008 AC9: remove `vault-session-<sid>` localStorage markers
 * for sessions that are no longer in `activeSessionIds`. Called on
 * Dashboard mount; catches sessions deleted from another tab or after
 * a browser crash. IDB deletion is deliberately omitted - see file
 * header.
 *
 * `listSessionMarkers` snapshots keys before iteration so the
 * `removeItem` call below cannot race the underlying live `localStorage`
 * key index.
 */
export async function sweepOrphanVaultCaches(activeSessionIds: string[]): Promise<void> {
  const ls = getLS();
  if (!ls) return;
  const active = new Set(activeSessionIds);
  for (const sid of listSessionMarkers(ls)) {
    if (active.has(sid)) continue;
    try {
      ls.removeItem(`${VAULT_MARKER_PREFIX}${sid}`);
    } catch {
      // Ignore.
    }
  }
}

