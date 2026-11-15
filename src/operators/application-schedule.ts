/** Registry-owned timer delivery. Application policy and execution stay in the normal SDK path. */
import type { Env } from '../types';
import { canInvokeOperator } from '../lib/access';
import { applicationSchedule } from './application-configuration';
import type { OperatorApplicationDefinition } from './distribution';
import { operatorOwnerKey } from './browser-activity';
import { createOperatorExecutionContext, openOperatorExecutionAccess,
  type OperatorExecutionAuthority, type OperatorExecutionContext } from './execution-context';
import { bindOperatorRuntimeCapability, prepareOperatorActivity, runOperatorActivity } from './orchestrator';
import type { ManagementExecutionSelection, OperatorRegistryResult } from './registry';
import { createRawCapture, createOwnerRawCaptureStorage, captureRawInteraction } from './raw-capture-storage';

export interface ApplicationScheduleContext {
  storage: DurableObjectStorage;
  env: Env;
  /** Local Registry selection only: this callback must not perform external I/O. */
  resolve: (installationId: string) => Promise<OperatorRegistryResult<ManagementExecutionSelection>>;
  waitUntil: (work: Promise<unknown>) => void;
  runtimeContext: unknown;
}
type Pins = NonNullable<NonNullable<Parameters<typeof prepareOperatorActivity>[3]>['expectedManagement']>;
interface ScheduleRecord extends Pins {
  scheduleId: string;
  installationId: string;
  ownerKey: string;
  source: { repositoryId: number; sourceRevision: number; sourceCommit: string };
  selectionDigest: string;
  intervalSeconds: number;
  activatedAt: string;
  nextDue?: number;
  revision: number;
  context: OperatorExecutionContext;
  loggingEnabled?: boolean;
}
type Observation = { status: 'current'; authority: OperatorExecutionAuthority }
  | { status: 'denied' | 'unavailable' };
const prefix = 'operator-schedule:';
const limit = 32;
// One active slot per owner/installation; old consent stays outside the alarm index.
const keyOf = (record: ScheduleRecord) => `${prefix}${record.ownerKey}:${record.installationId}`;
const historyKey = (scheduleId: string) => `operator-schedule-history:${scheduleId}`;

async function digest(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function pins(selection: ManagementExecutionSelection): Pins {
  return { controlsRevision: selection.controlsRevision, installationRevision: selection.installation.revision,
    operatorRevision: selection.operator.revision, releaseId: selection.release.id, bundleDigest: selection.release.bundleDigest };
}
function settings(selection: ManagementExecutionSelection) {
  if (!selection.installation.enabled || !selection.release.approved
    || selection.installation.releaseId !== selection.release.id) return null;
  try {
    // These are the Registry's already-approved manifest bytes, not a browser descriptor.
    const manifest = JSON.parse(selection.manifestJson) as { application?: OperatorApplicationDefinition };
    if (manifest.application?.controlVersion !== 1) return null;
    const schedule = applicationSchedule(manifest.application, JSON.parse(selection.installation.configurationJson));
    return schedule?.automaticRuns ? schedule : null;
  } catch { return null; }
}
async function selectionDigest(selection: ManagementExecutionSelection): Promise<string> {
  return digest([pins(selection), selection.installation.id, selection.operator.operatorId,
    selection.operator.source, selection.installation.approvedSourceRevision, selection.release.repositoryId,
    selection.release.sourceRevision, selection.release.sourceCommit, selection.release.manifestDigest,
    selection.installation.configurationJson, selection.installation.policy, selection.manifestJson]);
}
async function selectionCurrent(context: ApplicationScheduleContext, record: ScheduleRecord): Promise<boolean> {
  const selected = await context.resolve(record.installationId);
  return selected.ok && settings(selected.value)?.repetitionIntervalSeconds === record.intervalSeconds
    && record.context.operatorId === selected.value.operator.operatorId
    && record.selectionDigest === await selectionDigest(selected.value)
    && record.context.expiresAt * 1000 > Date.now();
}
async function administrator(context: ApplicationScheduleContext, authority: OperatorExecutionAuthority): Promise<boolean> {
  if (!context.env.KV) return false;
  const raw = await context.env.KV.get(`user:${authority.human.email.toLowerCase()}`);
  if (!raw) return false;
  try { return (JSON.parse(raw) as { role?: unknown } | null)?.role === 'admin'; }
  catch { return false; }
}
async function observe(context: ApplicationScheduleContext, record: ScheduleRecord): Promise<Observation> {
  if (record.context.expiresAt * 1000 <= Date.now()) return { status: 'denied' };
  let authority: OperatorExecutionAuthority;
  try { authority = await openOperatorExecutionAccess(record.context, context.env); }
  catch { return { status: 'denied' }; }
  if (!authority.delegation || !Array.isArray(authority.human.groups)
    || record.ownerKey !== await operatorOwnerKey(authority.human)) return { status: 'denied' };
  try {
    if (!await administrator(context, authority)) return { status: 'denied' };
    const selected = await context.resolve(record.installationId);
    if (!selected.ok || !canInvokeOperator(authority.human, selected.value.operator)
      || !await selectionCurrent(context, record)
      || !await administrator(context, authority)
      || record.context.expiresAt * 1000 <= Date.now()) return { status: 'denied' };
    return { status: 'current', authority };
  } catch { return { status: 'unavailable' }; }
}
async function resetAlarm(storage: Pick<DurableObjectStorage, 'list' | 'setAlarm' | 'deleteAlarm'>): Promise<void> {
  const records = await storage.list<ScheduleRecord>({ prefix, limit });
  let earliest: number | undefined;
  for (const record of records.values()) if (record.nextDue !== undefined) {
    earliest = Math.min(earliest ?? record.nextDue, record.nextDue);
  }
  if (earliest === undefined) await storage.deleteAlarm();
  else await storage.setAlarm(earliest);
}
async function retire(context: ApplicationScheduleContext, record: ScheduleRecord, key = keyOf(record)): Promise<void> {
  await context.storage.transaction(async tx => {
    const latest = await tx.get<ScheduleRecord>(key);
    if (latest?.scheduleId === record.scheduleId && latest.revision === record.revision) {
      await tx.put(key, { ...latest, nextDue: undefined, revision: latest.revision + 1 });
    }
    await resetAlarm(tx);
  });
}
function captureHandoff(context: ApplicationScheduleContext, record: ScheduleRecord, observationId: string) {
  if (record.loggingEnabled !== true) return undefined;
  try {
    const binding = { ownerKey: record.ownerKey, installationId: record.installationId, releaseId: record.releaseId,
      captureId: crypto.randomUUID(), scope: { kind: 'observation' as const, observationId } };
    return createRawCapture({ enabled: true, binding, schedule: work => context.waitUntil(work),
      storage: () => createOwnerRawCaptureStorage(context.env, context.storage, async () => {
        const current = await context.storage.get<ScheduleRecord>(keyOf(record));
        const original = current?.scheduleId === record.scheduleId ? current
          : await context.storage.get<ScheduleRecord>(historyKey(record.scheduleId));
        if (!original || original.loggingEnabled !== true || original.ownerKey !== binding.ownerKey
          || original.installationId !== binding.installationId || original.releaseId !== binding.releaseId
          || original.context.protectedAccessCiphertext !== record.context.protectedAccessCiphertext) {
          throw new Error('Original scheduling capture unavailable');
        }
      }) });
  } catch { return undefined; }
}

async function handoffAuthority(context: ApplicationScheduleContext, record: ScheduleRecord): Promise<Observation> {
  const current = await context.storage.get<ScheduleRecord>(keyOf(record));
  if (current?.scheduleId !== record.scheduleId || current.revision !== record.revision || current.nextDue === undefined) return { status: 'denied' };
  const observed = await observe(context, record);
  const after = await context.storage.get<ScheduleRecord>(keyOf(record));
  if (after?.scheduleId !== record.scheduleId || after.revision !== record.revision || after.nextDue === undefined) return { status: 'denied' };
  if (observed.status === 'denied' || record.context.expiresAt * 1000 <= Date.now()) {
    await retire(context, record);
    return { status: 'denied' };
  }
  return observed;
}

/** Trusted Root authority only. Save/enable and ordinary manual preparation never call this. */
export async function activateApplicationSchedule(context: ApplicationScheduleContext, input: {
  installationId: string; revision: number; authority: OperatorExecutionAuthority;
}): Promise<{ ok: true; activatedAt: string } | { ok: false; reason: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.installationId) || !Number.isSafeInteger(input.revision)
    || !input.authority.delegation || !Array.isArray(input.authority.human.groups)
    || input.authority.human.expiresAt * 1000 <= Date.now()) return { ok: false, reason: 'not-authorized' };
  try {
    const selected = await context.resolve(input.installationId);
    if (!selected.ok || selected.value.installation.revision !== input.revision) return { ok: false, reason: 'stale-selection' };
    const configured = settings(selected.value);
    if (!configured) return { ok: false, reason: 'configuration-unavailable' };
    const ownerKey = await operatorOwnerKey(input.authority.human);
    const selectedDigest = await selectionDigest(selected.value);
    const scheduleId = `schedule-${await digest([input.installationId, ownerKey, selectedDigest,
      configured.repetitionIntervalSeconds, input.authority])}`;
    const record: ScheduleRecord = { scheduleId, installationId: input.installationId, ownerKey,
      source: { repositoryId: selected.value.release.repositoryId, sourceRevision: selected.value.release.sourceRevision,
        sourceCommit: selected.value.release.sourceCommit },
      ...pins(selected.value), selectionDigest: selectedDigest, intervalSeconds: configured.repetitionIntervalSeconds,
      activatedAt: new Date().toISOString(), revision: 1,
      loggingEnabled: selected.value.operator.policy.loggingEnabled !== false,
      nextDue: Math.min(Date.now() + 1000, input.authority.human.expiresAt * 1000),
      context: await createOperatorExecutionContext({ activityId: scheduleId,
        operatorId: selected.value.operator.operatorId, artifactDigest: selected.value.release.bundleDigest,
        policyDigest: await digest(selected.value.installation.policy), ...input.authority }, context.env) };
    const observed = await observe(context, record);
    if (observed.status !== 'current') return { ok: false, reason: observed.status === 'unavailable' ? 'unavailable' : 'not-authorized' };
    return await context.storage.transaction(async tx => {
      // No KV, identity service, discovery or other external I/O in this transaction.
      if (!await selectionCurrent(context, record)) return { ok: false, reason: 'stale-selection' } as const;
      const records = await tx.list<ScheduleRecord>({ prefix, limit });
      for (const [key, expired] of records) if (expired.context.expiresAt * 1000 <= Date.now()) {
        await tx.put(historyKey(expired.scheduleId), { ...expired, nextDue: undefined });
        await tx.delete(key);
        records.delete(key);
      }
      const existing = records.get(keyOf(record));
      const prior = existing?.scheduleId === record.scheduleId ? existing
        : await tx.get<ScheduleRecord>(historyKey(record.scheduleId));
      if (prior) {
        // An acknowledgement retry never resets a due time, revives retirement or renews consent.
        await resetAlarm(tx);
        return { ok: true, activatedAt: prior.activatedAt } as const;
      }
      if (records.size >= limit && !existing) return { ok: false, reason: 'registration-limit' } as const;
      if (existing) await tx.put(historyKey(existing.scheduleId), { ...existing, nextDue: undefined });
      await tx.put(keyOf(record), record);
      await resetAlarm(tx);
      return { ok: true, activatedAt: record.activatedAt } as const;
    });
  } catch { return { ok: false, reason: 'unavailable' }; }
}

/** Owner-safe projection; saved configuration alone is never evidence of activation. */
export async function applicationScheduleStatus(context: ApplicationScheduleContext, installationId: string,
  ownerKey: string): Promise<'active' | 'expired' | 'inactive' | 'unconfirmed'> {
  let expired = false, unconfirmed = false;
  try {
    const records = await context.storage.list<ScheduleRecord>({ prefix, limit });
    for (const record of records.values()) {
      if (record.installationId !== installationId || record.ownerKey !== ownerKey) continue;
      if (record.context.expiresAt * 1000 <= Date.now()) { expired = true; continue; }
      if (record.nextDue === undefined) continue;
      const observed = await observe(context, record);
      if (record.context.expiresAt * 1000 <= Date.now()) { expired = true; continue; }
      const latest = await context.storage.get<ScheduleRecord>(keyOf(record));
      if (latest?.scheduleId !== record.scheduleId || latest.revision !== record.revision || latest.nextDue === undefined) continue;
      const alarm = await context.storage.getAlarm();
      if (observed.status === 'current' && record.context.expiresAt * 1000 > Date.now()
        && alarm !== null && alarm <= latest.nextDue) return 'active';
      if (observed.status !== 'denied') unconfirmed = true;
    }
  } catch { unconfirmed = true; }
  return unconfirmed ? 'unconfirmed' : expired ? 'expired' : 'inactive';
}

/** Claim each due tick before I/O. Lost acknowledgements never replay that tick or replace its Activity. */
export async function runApplicationSchedules(context: ApplicationScheduleContext): Promise<void> {
  const records = await context.storage.list<ScheduleRecord>({ prefix, limit });
  for (const [key, initial] of records) {
    // A corrupt owner/installation projection cannot select another record or
    // keep a repeating alarm alive under a different key.
    if (key !== keyOf(initial)) { await retire(context, initial, key); continue; }
    // Check even not-yet-due records so disabled/revoked schedules cannot keep an alarm alive.
    if (initial.nextDue === undefined) continue;
    const claimed = await context.storage.transaction(async tx => {
      const latest = await tx.get<ScheduleRecord>(keyOf(initial));
      const now = Date.now();
      if (!latest || latest.scheduleId !== initial.scheduleId || latest.revision !== initial.revision
        || latest.nextDue === undefined || latest.nextDue > now) return null;
      const due = latest.nextDue;
      const next: ScheduleRecord = { ...latest, revision: latest.revision + 1,
        nextDue: latest.context.expiresAt * 1000 <= now ? undefined
          : Math.min(now + latest.intervalSeconds * 1000, latest.context.expiresAt * 1000) };
      await tx.put(keyOf(next), next);
      await resetAlarm(tx);
      return { record: next, due };
    });
    const record = claimed?.record ?? initial;
    const observed = await handoffAuthority(context, record);
    if (observed.status !== 'current' || !claimed) continue;
    const activityId = `timer-${await digest([record.scheduleId, claimed.due])}`;
    const activity = context.env.OPERATOR_ACTIVITY?.getByName(activityId);
    if (!activity) continue;
    const capture = captureHandoff(context, record, activityId);
    const fence = async () => {
      try { await captureRawInteraction(capture, 'application-schedule-fence',
        () => ({ activityId, boundary: 'admission', code: 'startup-failed', onlyBeforeDrive: true }),
        () => activity.fenceRuntimeFailure(undefined,
          { boundary: 'admission', code: 'startup-failed' }, { onlyBeforeDrive: true })); }
      catch { /* Unknown acknowledgement belongs to this Activity; never replay it here. */ }
    };
    try {
      const bind = bindOperatorRuntimeCapability(context.runtimeContext);
      const current = await handoffAuthority(context, record);
      if (current.status !== 'current') continue;
      const prepared = await captureRawInteraction(capture, 'application-schedule-prepare',
        () => ({ installationId: record.installationId, invocation: {}, authority: current.authority, activityId }),
        () => prepareOperatorActivity({ installationId: record.installationId, invocation: {} },
          current.authority, context.env, { activityId, expectedManagement: pinsFromRecord(record) }));
      if ((await handoffAuthority(context, record)).status !== 'current') { await fence(); continue; }
      const started = await captureRawInteraction(capture, 'application-schedule-start',
        () => ({ activityId, capability: prepared.startCapability }), () => activity.start(prepared.startCapability));
      if (!started.ok || (await handoffAuthority(context, record)).status !== 'current') { await fence(); continue; }
      context.waitUntil(runOperatorActivity(activityId, context.env, bind).catch(fence));
    } catch (error) {
      try { capture?.record('application-schedule-error', () => error); } catch { /* Preserve the original handoff failure. */ }
      await fence();
    } finally {
      try { await capture?.finish('complete'); } catch { /* Capture cannot change a handoff or authorize a retry. */ }
    }
  }
  await context.storage.transaction(tx => resetAlarm(tx));
}
function pinsFromRecord(record: ScheduleRecord): Pins {
  return { controlsRevision: record.controlsRevision, installationRevision: record.installationRevision,
    operatorRevision: record.operatorRevision, releaseId: record.releaseId, bundleDigest: record.bundleDigest };
}
