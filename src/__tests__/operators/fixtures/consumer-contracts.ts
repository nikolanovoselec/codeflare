/** Deterministic platform fixtures; names deliberately avoid any private workflow vocabulary. */
const base = {
  schemaVersion: 1 as const, interfaceVersion: 1 as const, consumerId: 'fixture-consumer',
  activityId: 'activity-1', operatorId: 'operator-1', runId: 'run-1',
  revision: { reference: 'revision-1', digest: 'a'.repeat(64) }, inputDigest: 'b'.repeat(64),
  attachments: [] as Array<{ name: string; mediaType: string; size: number; sha256: string; locator: string }>,
};
export const consumerContractFixtures = [
  { ...base, source: { kind: 'direct' as const, reference: 'browser' }, input: { task: 'summarize' },
    resources: { inference: { routeId: 'development', reasoningLevel: 'off' }, session: null, storage: null } },
  { ...base, runId: 'run-2', source: { kind: 'session' as const, reference: 'session-1' },
    input: { task: 'inspect attachment' }, attachments: [{ name: 'evidence.txt', mediaType: 'text/plain', size: 6,
      sha256: 'c'.repeat(64), locator: 'attachment-1' }], resources: { inference: null,
      session: { profileId: 'pi-default' }, storage: { scopeId: 'output-1' } } },
  { ...base, runId: 'run-3', source: { kind: 'webhook' as const, reference: 'workflow-1' },
    input: { task: 'process event' }, resources: { inference: { routeId: 'production', reasoningLevel: null },
      session: null, storage: { scopeId: 'output-2' } } },
] as const;
