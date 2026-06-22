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
 */
export function markVaultFullyPrewarmed(sessionId: string, storage: Storage | null = getLocalStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_PREWARMED_SUFFIX}`, '1');
  } catch {
    // Storage unavailable/full — the reload simply re-prewarms, which is safe.
  }
}

export function hasVaultFullyPrewarmed(sessionId: string, storage: Storage | null = getLocalStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(`${VAULT_MARKER_PREFIX}${sessionId}${VAULT_PREWARMED_SUFFIX}`) === '1';
  } catch {
    return false;
  }
}

async function findVaultServiceWorker(
  sessionId: string,
  serviceWorker: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration | null> {
  const scopePath = `/api/vault/${encodeURIComponent(sessionId)}/`;
  try {
    const registration = await serviceWorker.getRegistration(scopePath);
    if (registration) return registration;
  } catch {
    // Fall through to getRegistrations; some browsers are stricter about
    // getRegistration's clientURL argument than others.
  }

  try {
    const registrations = await serviceWorker.getRegistrations();
    return registrations.find((registration) => registration.scope.includes(scopePath)) ?? null;
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
  const registration = await findVaultServiceWorker(sessionId, serviceWorkerRef);
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
