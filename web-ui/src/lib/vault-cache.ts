// REQ-VAULT-015 AC3+AC4 (as reconciled by REQ-VAULT-021): dashboard-side
// bookkeeping cleanup for the SilverBullet vault.
//
// What this file owns:
//
//   - cleanupSessionVaultCache(sid): called from deleteSession() to drop the
//     per-session localStorage markers (`vault-session-<sid>`,
//     `vault-session-<sid>-idbs`, `vault-session-<sid>-prewarmed`).
//   - sweepOrphanVaultCaches(activeSessionIds): called after an authoritative
//     session-list fetch succeeds. For every `vault-session-<sid>*` marker whose
//     sid is not in activeSessionIds, drop the markers. Handles sessions deleted
//     from another tab or after a browser crash.
//
// REQ-VAULT-021 reconciliation (load-bearing): the SilverBullet IndexedDB
// stores (`sb_data_*` / `sb_files_*`) and the vault service worker are NO LONGER
// per-session. They are derived from the bucket-stable URL `/api/vault/<token>/`
// and the bucket-derived key, so ALL of a user's sessions share ONE persistent
// store + SW. Deleting that store on a per-session DELETE or orphan sweep would
// erase the next session's vault and force a full re-index — the exact
// cross-session persistence REQ-VAULT-021 exists to provide. So this cleanup
// deletes NEITHER the recorded IndexedDB databases NOR the service worker; it
// only removes the per-session localStorage markers (pure bookkeeping). The
// per-session IDB leak that the original REQ-VAULT-015 AC3/AC4 deletion fought
// is gone at its source: there is now a single intentional store per user, not
// a new one per session.
//
// All operations are fail-safe — a missing global (SSR, fresh tab) is swallowed
// silently because cleanup is best-effort and must never block the delete UI or
// dashboard mount.

const VAULT_MARKER_PREFIX = 'vault-session-';
const VAULT_IDBS_SUFFIX = '-idbs';
const VAULT_PREWARMED_SUFFIX = '-prewarmed';

function getLS(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
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
    // Strip the prefix, then strip a trailing `-idbs` or `-prewarmed` suffix if
    // present so `vault-session-<sid>`, `vault-session-<sid>-idbs`, and
    // `vault-session-<sid>-prewarmed` all contribute the same sid. Without the
    // `-prewarmed` arm the full-prewarm marker is read as a bogus sid
    // (`<sid>-prewarmed`), which never matches an active session and is swept as
    // an orphan - silently erasing the reload-skip marker (REQ-VAULT-018 AC8).
    let sid = key.slice(VAULT_MARKER_PREFIX.length);
    if (sid.endsWith(VAULT_IDBS_SUFFIX)) {
      sid = sid.slice(0, -VAULT_IDBS_SUFFIX.length);
    } else if (sid.endsWith(VAULT_PREWARMED_SUFFIX)) {
      sid = sid.slice(0, -VAULT_PREWARMED_SUFFIX.length);
    }
    if (sid) sids.add(sid);
  }
  return [...sids];
}

function removeSessionMarkers(ls: Storage, sid: string): void {
  for (const key of [
    `${VAULT_MARKER_PREFIX}${sid}${VAULT_IDBS_SUFFIX}`,
    `${VAULT_MARKER_PREFIX}${sid}`,
    `${VAULT_MARKER_PREFIX}${sid}${VAULT_PREWARMED_SUFFIX}`,
  ]) {
    try {
      ls.removeItem(key);
    } catch {
      // Quota / disabled storage; ignore.
    }
  }
}

/**
 * REQ-VAULT-015 AC3 (reconciled by REQ-VAULT-021): remove the per-session vault
 * localStorage markers on session DELETE. Does NOT delete the bucket-stable
 * IndexedDB stores or the vault service worker — those persist across sessions
 * by design (REQ-VAULT-021).
 */
export async function cleanupSessionVaultCache(sid: string): Promise<void> {
  // Fail-closed input validation: an empty `sid` would compute
  // `removeItem('vault-session-')` (harmless no-op). Bail out anyway.
  if (!sid) return;
  const ls = getLS();
  if (!ls) return;
  removeSessionMarkers(ls, sid);
}

/**
 * REQ-VAULT-015 AC4 (reconciled by REQ-VAULT-021): remove the localStorage
 * markers for sessions no longer in `activeSessionIds`. Called after an
 * authoritative session-list fetch succeeds; catches sessions deleted from
 * another tab or after a browser crash. Does NOT delete the bucket-stable
 * IndexedDB stores or the vault service worker (see REQ-VAULT-021 note above).
 *
 * `listSessionMarkers` snapshots keys before iteration so the `removeItem`
 * call below cannot race the underlying live `localStorage` key index.
 */
export async function sweepOrphanVaultCaches(activeSessionIds: string[]): Promise<void> {
  const ls = getLS();
  if (!ls) return;
  const active = new Set(activeSessionIds);
  for (const sid of listSessionMarkers(ls)) {
    if (active.has(sid)) continue;
    removeSessionMarkers(ls, sid);
  }
}
