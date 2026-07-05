export type VaultLocalReadinessReason =
  | 'no-local-storage'
  | 'no-indexeddb'
  | 'no-recorder'
  | 'missing-sb-data'
  | 'missing-sb-files'
  | 'missing-idb-database'
  | 'missing-service-worker';

export interface VaultLocalReadinessResult {
  ready: boolean;
  reason?: VaultLocalReadinessReason;
  recordedDbs: string[];
  hasIndexedDbDatabasesApi: boolean;
  serviceWorkerState?: ServiceWorkerState;
}

interface IndexedDbWithDatabases {
  databases?: () => Promise<Array<{ name?: string | null }>>;
}

export interface VaultLocalReadinessOptions {
  localStorageRef?: Storage | null;
  indexedDbRef?: IndexedDbWithDatabases | null;
  serviceWorkerRef?: ServiceWorkerContainer | null;
}

const VAULT_MARKER_PREFIX = 'vault-session-';
const VAULT_IDBS_SUFFIX = '-idbs';
const VAULT_PREWARMED_SUFFIX = '-prewarmed';

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function getIndexedDb(): IndexedDbWithDatabases | null {
  try {
    return (globalThis.indexedDB as IndexedDbWithDatabases | undefined) ?? null;
  } catch {
    return null;
  }
}

function getServiceWorker(): ServiceWorkerContainer | null {
  try {
    return globalThis.navigator?.serviceWorker ?? null;
  } catch {
    return null;
  }
}

export function getVaultRecordedIdbNames(sessionId: string, storage: Storage | null = getLocalStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_IDBS_SUFFIX}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function hasRecordedDb(recordedDbs: string[], prefix: string): boolean {
  return recordedDbs.some((name) => name.startsWith(prefix));
}

/**
 * Durable per-session, per-browser marker that THIS browser once completed a
 * FULL prewarm proof for the session — SilverBullet runtime ready, space sync
 * complete, object index complete, and the authoritative file listing present
 * (REQ-VAULT-018 AC6) — not merely that the IndexedDB stores and service worker
 * exist. A reload may skip remounting the bootstrap iframe only when this marker
 * is set AND live local readiness (`checkVaultLocalReadiness`) still holds: the
 * recorded stores + active SW alone can be present mid-first-init before the
 * index finishes, and opening then would land on a slow indexing screen.
 *
 * The marker VALUE is the container's start timestamp (`lastStartedAt`), recorded
 * at prewarm COMPLETION (REQ-VAULT-022 AC2). The reload-skip is authorized ONLY
 * when the recorded start equals the start running NOW — a STRICT match:
 *
 *   - RETURN (same container, page reload / vault-tab return): the current start
 *     equals the recorded one once it polls in, so the control re-arms green with
 *     no click and no re-init. The caller records at completion (not at click
 *     time), so the marker reliably carries the real start even when the user
 *     clicked before the first batch-status poll.
 *   - RESUME (container restarted, `lastStartedAt` advanced): the recorded start
 *     no longer matches, so the reload-skip is refused and the vault re-initializes
 *     like a fresh session — a forced, normal prewarm.
 *   - UNKNOWN current start (not polled yet): treated as NOT warm. Being unable to
 *     prove the container is the same one must never skip onto a possibly-resumed
 *     (stale) store. The reload-skip effect re-runs when the start polls in and
 *     arms then. A start-less prewarm records no marker (nothing to match against),
 *     so it simply re-prewarms next time — safe, never a stale over-skip.
 */
export function markVaultFullyPrewarmed(
  sessionId: string,
  startedAt: string | null | undefined,
  storage: Storage | null = getLocalStorage(),
): void {
  // Record ONLY with a known container start. A marker without a real start could
  // never be matched against the current start below, and must never authorize a
  // reload-skip onto a possibly-resumed container. The caller marks at prewarm
  // completion, by which point lastStartedAt has almost always polled in.
  if (!storage || !startedAt) return;
  try {
    storage.setItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_PREWARMED_SUFFIX}`, startedAt);
  } catch {
    // Storage unavailable/full — the reload simply re-prewarms, which is safe.
  }
}

export function hasVaultFullyPrewarmed(
  sessionId: string,
  startedAt: string | null | undefined,
  storage: Storage | null = getLocalStorage(),
): boolean {
  // Warm ONLY when this browser's recorded marker was stamped with the SAME
  // container start that is running now. A resumed session (advanced lastStartedAt)
  // never matches -> re-inits. A not-yet-polled current start (null) is not proof
  // of the same container, so it never skips (the effect re-runs and arms once the
  // start polls in).
  if (!storage || !startedAt) return false;
  try {
    return storage.getItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_PREWARMED_SUFFIX}`) === startedAt;
  } catch {
    return false;
  }
}

/**
 * The raw container start recorded in this session's full-prewarm marker (the value
 * `markVaultFullyPrewarmed` stored), or null if this browser never proved a prewarm
 * for the session. The reload-skip uses this to arm green OPTIMISTICALLY the instant a
 * marker exists — without waiting for the current container start to poll in, so a
 * same-container return re-greens immediately — and separately REVOKES that green once
 * the polled-in start is known to differ (a resumed container). Keeps a same-container
 * RETURN instant while a RESUME still re-initializes (REQ-VAULT-022 AC2).
 */
export function readVaultPrewarmMarker(
  sessionId: string,
  storage: Storage | null = getLocalStorage(),
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_PREWARMED_SUFFIX}`);
  } catch {
    return null;
  }
}

async function findVaultServiceWorker(
  serviceWorker: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration | null> {
  // REQ-VAULT-021: SilverBullet registers its SW under the bucket-stable
  // `/api/vault/<token>/` scope (one per user), which the dashboard cannot name
  // by session id. Match any vault-scoped registration — there is exactly one.
  try {
    const registrations = await serviceWorker.getRegistrations();
    return registrations.find((registration) => registration.scope.includes('/api/vault/')) ?? null;
  } catch {
    return null;
  }
}

export async function checkVaultLocalReadiness(
  sessionId: string,
  options: VaultLocalReadinessOptions = {},
): Promise<VaultLocalReadinessResult> {
  const localStorageRef = options.localStorageRef === undefined ? getLocalStorage() : options.localStorageRef;
  const indexedDbRef = options.indexedDbRef === undefined ? getIndexedDb() : options.indexedDbRef;
  const serviceWorkerRef = options.serviceWorkerRef === undefined ? getServiceWorker() : options.serviceWorkerRef;
  const recordedDbs = getVaultRecordedIdbNames(sessionId, localStorageRef);
  const hasIndexedDbDatabasesApi = typeof indexedDbRef?.databases === 'function';

  const base = (): VaultLocalReadinessResult => ({
    ready: false,
    recordedDbs,
    hasIndexedDbDatabasesApi,
  });

  if (!localStorageRef) return { ...base(), reason: 'no-local-storage' };
  if (!indexedDbRef) return { ...base(), reason: 'no-indexeddb' };
  if (recordedDbs.length === 0) return { ...base(), reason: 'no-recorder' };
  if (!hasRecordedDb(recordedDbs, 'sb_data_')) return { ...base(), reason: 'missing-sb-data' };
  if (!hasRecordedDb(recordedDbs, 'sb_files_')) return { ...base(), reason: 'missing-sb-files' };

  if (!serviceWorkerRef) return { ...base(), reason: 'missing-service-worker' };
  const registration = await findVaultServiceWorker(serviceWorkerRef);
  const active = registration?.active ?? null;
  if (!active) return { ...base(), reason: 'missing-service-worker' };

  if (hasIndexedDbDatabasesApi) {
    try {
      const databases = await indexedDbRef.databases!();
      const existingNames = new Set(databases.map((db) => db.name).filter((name): name is string => typeof name === 'string'));
      const hasExistingDataDb = recordedDbs.some((name) => name.startsWith('sb_data_') && existingNames.has(name));
      const hasExistingFilesDb = recordedDbs.some((name) => name.startsWith('sb_files_') && existingNames.has(name));
      if (!hasExistingDataDb || !hasExistingFilesDb) {
        return {
          ...base(),
          reason: 'missing-idb-database',
          serviceWorkerState: active.state,
        };
      }
    } catch {
      return {
        ...base(),
        reason: 'missing-idb-database',
        serviceWorkerState: active.state,
      };
    }
  }

  return {
    ready: true,
    recordedDbs,
    hasIndexedDbDatabasesApi,
    serviceWorkerState: active.state,
  };
}

export interface VaultKeyRecoverableOptions {
  fetchRef?: typeof fetch | null;
}

/**
 * Network proof that the vault encryption key is recoverable for `sessionId`
 * right now. The service worker drops its in-memory key ~5s after the prewarm
 * client disconnects, so local readiness (SW active + IndexedDB present) does
 * NOT guarantee the key is available when the user opens the vault — opening
 * without it redirects to SilverBullet's `.auth` ("Authentication not enabled").
 * This hits the same auth-gated `/.vault-key` endpoint the worker's own
 * `__cfRecover` uses, so a 200 with a non-empty key means the worker's recovery
 * will also succeed at open time. Returns false on any non-200, missing key,
 * or network/parse error (callers re-prewarm rather than open into the error).
 */
export async function checkVaultKeyRecoverable(
  sessionId: string,
  options: VaultKeyRecoverableOptions = {},
): Promise<boolean> {
  const fetchRef = options.fetchRef === undefined ? (globalThis.fetch ?? null) : options.fetchRef;
  if (!fetchRef) return false;
  try {
    const res = await fetchRef(`/api/vault/${encodeURIComponent(sessionId)}/.vault-key`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { key?: unknown };
    return typeof data.key === 'string' && data.key.length > 0;
  } catch {
    return false;
  }
}
