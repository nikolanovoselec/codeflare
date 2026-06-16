export interface BrowserStoragePersistenceResult {
  supported: boolean;
  persisted?: boolean;
  granted?: boolean;
  quota?: number;
  usage?: number;
}

interface StorageManagerWithPersistence {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<StorageEstimate>;
}

export async function requestBrowserStoragePersistence(
  storage: StorageManagerWithPersistence | undefined = globalThis.navigator?.storage as StorageManagerWithPersistence | undefined,
): Promise<BrowserStoragePersistenceResult> {
  if (!storage) return { supported: false };

  let quota: number | undefined;
  let usage: number | undefined;
  try {
    const estimate = await storage.estimate?.();
    quota = estimate?.quota;
    usage = estimate?.usage;
  } catch {
    // Diagnostics only; persistence support should not fail because quota
    // estimation is unavailable or blocked.
  }

  const withEstimate = (result: Omit<BrowserStoragePersistenceResult, 'quota' | 'usage'>): BrowserStoragePersistenceResult => ({
    ...result,
    ...(quota === undefined ? {} : { quota }),
    ...(usage === undefined ? {} : { usage }),
  });

  if (typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') {
    return withEstimate({ supported: false });
  }

  try {
    const alreadyPersisted = await storage.persisted();
    if (alreadyPersisted) {
      return withEstimate({ supported: true, persisted: true, granted: true });
    }
  } catch {
    return withEstimate({ supported: true, persisted: false, granted: false });
  }

  try {
    const granted = await storage.persist();
    return withEstimate({ supported: true, persisted: granted, granted });
  } catch {
    return withEstimate({ supported: true, persisted: false, granted: false });
  }
}
