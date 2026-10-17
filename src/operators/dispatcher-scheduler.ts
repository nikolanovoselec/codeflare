import { z } from 'zod';
import type { RetryOptions, Schedule } from 'agents';

export const DISPATCHER_SCHEDULE_CALLBACK = 'dispatchDispatcherSchedule';
const DISPATCHER_CHILD_CALLBACK = '__flueWakeAgentSubmissions';

const pathSchema = z.tuple([
  z.strictObject({ className: z.literal('OperatorActivity'), name: z.string().min(1).max(128) }),
  z.strictObject({ className: z.literal('FlueDispatcherAgent'), name: z.literal('dispatcher') }),
]);
const retrySchema = z.strictObject({
  maxAttempts: z.number().int().positive().optional(),
  baseDelayMs: z.number().nonnegative().optional(),
  maxDelayMs: z.number().nonnegative().optional(),
});
// Preserve the old storage row, not a public Schedule carrying the host envelope.
const originalSchema = z.object({
  callback: z.literal(DISPATCHER_CHILD_CALLBACK),
  payload: z.union([z.null(), z.literal('null')]),
  retry_options: z.string().nullable(),
  owner_path: z.string(),
  owner_path_key: z.string(),
}).catchall(z.union([z.string(), z.number(), z.null()]));
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  activityId: z.string().min(1).max(128),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  original: originalSchema,
});
type DispatcherScheduleEnvelope = z.infer<typeof envelopeSchema>;
type DispatcherScheduleBinding = Omit<DispatcherScheduleEnvelope, 'version' | 'original'>;

export function dispatcherSchedulePath(activityId: string): z.infer<typeof pathSchema> {
  return [{ className: 'OperatorActivity', name: activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
}

function pathKey(path: z.infer<typeof pathSchema>): string {
  return path.map(step => `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`).join('/');
}

function childScheduleRetry(original: DispatcherScheduleEnvelope['original']): RetryOptions | undefined {
  return original.retry_options === null ? undefined : retrySchema.parse(JSON.parse(original.retry_options));
}

export function parseDispatcherSchedule(value: unknown): DispatcherScheduleEnvelope | undefined {
  const result = envelopeSchema.safeParse(value);
  if (!result.success) return;
  try {
    const envelope = result.data;
    const path = pathSchema.parse(JSON.parse(envelope.original.owner_path));
    if (path[0].name !== envelope.activityId || pathKey(path) !== envelope.original.owner_path_key) return;
    childScheduleRetry(envelope.original);
    return envelope;
  } catch { return; }
}

export function dispatcherScheduleEnvelope(binding: DispatcherScheduleBinding,
  original?: DispatcherScheduleEnvelope['original']): DispatcherScheduleEnvelope {
  const path = dispatcherSchedulePath(binding.activityId);
  const value = { ...binding, version: 1, original: original ?? {
    callback: DISPATCHER_CHILD_CALLBACK, payload: null, retry_options: null,
    owner_path: JSON.stringify(path), owner_path_key: pathKey(path),
  } };
  const envelope = parseDispatcherSchedule(value);
  if (!envelope) throw new Error('Dispatcher schedule binding denied');
  return envelope;
}

export function projectChildSchedule(schedule: Schedule<unknown>, envelope: DispatcherScheduleEnvelope,
  created = false): Schedule<unknown> {
  return { ...schedule, callback: DISPATCHER_CHILD_CALLBACK,
    payload: created ? undefined : null, retry: childScheduleRetry(envelope.original) };
}

export function childScheduleRow(schedule: Schedule<unknown>, envelope: DispatcherScheduleEnvelope) {
  return { ...envelope.original, id: schedule.id, type: schedule.type, time: schedule.time,
    delayInSeconds: schedule.type === 'delayed' ? schedule.delayInSeconds : null,
    intervalSeconds: schedule.type === 'interval' ? schedule.intervalSeconds : null,
    cron: schedule.type === 'cron' ? schedule.cron : null };
}

/** Runs before Agent construction: Scheduler migrates legacy rows before host onStart. */
export function migrateDispatcherSchedules(storage: DurableObjectStorage,
  originalBinding: () => DispatcherScheduleBinding): void {
  if (!storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_schedules'").toArray().length) return;
  storage.transactionSync(() => {
    const rows = storage.sql.exec('SELECT * FROM cf_agents_schedules').toArray();
    const replacements: Array<{ id: string; envelope: DispatcherScheduleEnvelope }> = [];
    let binding: DispatcherScheduleBinding | undefined;
    for (const row of rows) {
      if ((row.running !== 0 && row.running !== null && row.running !== undefined)
        || (row.execution_started_at !== null && row.execution_started_at !== undefined)) {
        throw new Error('Legacy schedule migration contains unsupported in-flight state');
      }
      // Upstream skips malformed JSON then drops the old table. Refuse the whole
      // migration rather than silently losing an unrelated root or child row.
      try {
        if (row.payload !== null) {
          if (typeof row.payload !== 'string') throw new Error('payload');
          JSON.parse(row.payload);
        }
        if (row.retry_options !== null && row.retry_options !== undefined) {
          if (typeof row.retry_options !== 'string') throw new Error('retry');
          retrySchema.parse(JSON.parse(row.retry_options));
        }
      } catch { throw new Error('Legacy schedule migration contains invalid JSON or retry data'); }
      if (row.owner_path === null && row.owner_path_key === null) continue;
      binding ??= originalBinding();
      if (binding.generation !== 1) throw new Error('Legacy schedule generation ownership is unproven');
      const parsed = originalSchema.safeParse(row);
      if (!parsed.success || typeof row.id !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(row.id)
        || typeof row.time !== 'number' || !Number.isFinite(row.time)
        || !['delayed', 'scheduled', 'interval'].includes(String(row.type))
        || (row.type === 'delayed' && (typeof row.delayInSeconds !== 'number' || row.delayInSeconds < 0 || row.delayInSeconds > 30))
        || (row.type === 'interval' && (typeof row.intervalSeconds !== 'number' || row.intervalSeconds < 1 || row.intervalSeconds > 30))) {
        throw new Error('Legacy schedule migration contains unsupported child state');
      }
      const envelope = dispatcherScheduleEnvelope(binding, parsed.data);
      replacements.push({ id: row.id, envelope });
    }
    if (replacements.length > 128) throw new Error('Legacy schedule migration exceeds child capacity');
    // Validate every row before the first write. Preserve IDs, due time,
    // recurrence and original retry/payload bytes inside the host envelope.
    for (const { id, envelope } of replacements) {
      storage.sql.exec(`UPDATE cf_agents_schedules SET callback = ?, payload = ?, retry_options = ?,
        owner_path = NULL, owner_path_key = NULL WHERE id = ?`, DISPATCHER_SCHEDULE_CALLBACK,
      JSON.stringify(envelope), JSON.stringify({ maxAttempts: 1 }), id);
    }
  });
}
