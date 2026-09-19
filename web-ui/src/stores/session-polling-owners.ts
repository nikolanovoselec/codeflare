interface PollingApi {
  getBatchStatus(): Promise<unknown>;
  getUsage(): Promise<unknown>;
  getStorage(): Promise<unknown>;
  getEntitlement(): Promise<unknown>;
  getManagedRelease(): Promise<unknown>;
  getPreseed(): Promise<unknown>;
  advanceMigration(): Promise<unknown>;
}

export function createSessionPollingOwners(api: PollingApi) {
  let ancillary: Record<string, unknown> = {};
  let inFlight: Promise<void> | null = null;

  const refreshAncillary = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const operations = await Promise.allSettled([
        api.getUsage(), api.getStorage(), api.getEntitlement(), api.getManagedRelease(), api.getPreseed(), api.advanceMigration(),
      ]);
      const keys = ['usage', 'storage', 'entitlement', 'managedRelease', 'preseed', 'migration'];
      let error: unknown;
      operations.forEach((result, index) => {
        if (result.status === 'fulfilled') ancillary[keys[index]] = result.value;
        else error ??= result.reason;
      });
      ancillary = { ...ancillary, error };
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    refreshProjection: () => api.getBatchStatus(),
    refreshAncillary,
    getAncillarySnapshot: () => ({ ...ancillary }),
  };
}
