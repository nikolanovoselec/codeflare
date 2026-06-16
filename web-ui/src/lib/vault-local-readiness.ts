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
