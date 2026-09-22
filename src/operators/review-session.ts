import { z } from 'zod';
import type { OwnedOperatorSessionService } from './owned-session';
import { parseReviewJson, reviewDigest, reviewIdSchema, reviewJson, type PreparedReview } from './review-packet';

export interface ReviewSessionServices {
  authorize(): Promise<void>;
  /** Root binds the existing service to one admitted owner/profile/session, not a package-selected ID. */
  session: {
    ensure(): Promise<Pick<Awaited<ReturnType<OwnedOperatorSessionService['ensure']>>, 'status'>>;
    stop(): Promise<Pick<Awaited<ReturnType<OwnedOperatorSessionService['stop']>>, 'status'>>;
  };
  /** Restore prepared bytes only, idempotently by packetDigest; reject conflicting existing bytes.
   * Includes review/input.json, review/packets/<lane>.json and approved parent/child resources.
   * The approved parent must have an existing trusted child-reviewer runner. Do not discover hooks,
   * execute candidate configuration, select unapproved extensions, or restore a repository checkout. */
  restoreApprovedData(prepared: PreparedReview): Promise<void>;
  /** Existing authenticated host API for this owned container only, with parent-enforced timeout. */
  host: { fetch(path: string, init?: RequestInit): Promise<Response> };
}
const taskSchema = z.strictObject({ taskId: reviewIdSchema,
  status: z.enum(['running', 'queued', 'accepted', 'completed', 'failed', 'cancelled', 'unknown']) });
const taskId = (prepared: PreparedReview) => `review-generation-${prepared.admission.generation}`;
async function hostJson(services: ReviewSessionServices, path: string, body: unknown): Promise<unknown> {
  await services.authorize();
  const response = await services.host.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) throw Error('Review host operation failed');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw Error('Review host response too large');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  await services.authorize();
  return parseReviewJson(bytes);
}
async function cleanup(services: ReviewSessionServices): Promise<'stopped' | 'unknown'> {
  try { return (await services.session.stop()).status === 'stopped' ? 'stopped' : 'unknown'; }
  catch { return 'unknown'; }
}

/** One bounded submission/reconciliation step, not a scheduler. Activity owns further drives.
 * Existing Pi task IDs reconcile accepted work; this helper never creates replacement tasks. */
export async function submitPreparedReview(prepared: PreparedReview, services: ReviewSessionServices): Promise<{
  status: 'running' | 'session-starting' | 'task-completed' | 'unknown'; taskId: string;
}> {
  const id = taskId(prepared);
  try {
    await services.authorize();
    const session = await services.session.ensure();
    if (['reserved', 'configuring', 'configured', 'starting'].includes(session.status)) return { status: 'session-starting', taskId: id };
    if (session.status !== 'ready') throw Error('Review session unavailable');
    await services.authorize();
    await services.restoreApprovedData(structuredClone(prepared));
    await hostJson(services, '/internal/operator/pi/ensure', {}).then(value =>
      z.strictObject({ conversationId: reviewIdSchema, ready: z.literal(true) }).parse(value));
    // Packet bytes are restored separately: the Pi task stays below its existing 32 KiB prompt bound.
    const text = `Run the approved remote Review parent on review/input.json. Packet digest: ${prepared.packetDigest}. `
      + `Use only approved child resources for code-reviewer, spec-reviewer and doc-updater. `
      + `Write each bounded lane report to reports/<lane>.json. Do not publish, load candidate resources or claim sync/cleanup.`;
    const digest = await reviewDigest(reviewJson({ mode: 'prompt', text }));
    const task = taskSchema.parse(await hostJson(services, '/internal/operator/pi/tasks', { taskId: id, digest, mode: 'prompt', text }));
    if (task.taskId !== id || ['unknown', 'failed', 'cancelled'].includes(task.status)) throw Error('Review task unavailable');
    return { status: task.status === 'completed' ? 'task-completed' : 'running', taskId: id };
  } catch {
    await cleanup(services);
    return { status: 'unknown', taskId: id };
  }
}

/** Root fences the generation first; abort/stop use the existing cleanup-only owned authority. */
export async function cancelPreparedReview(prepared: PreparedReview, services: ReviewSessionServices): Promise<{
  status: 'cancelled' | 'unknown'; cleanup: 'stopped' | 'unknown';
}> {
  let status: 'cancelled' | 'unknown' = 'unknown';
  try {
    const task = taskSchema.parse(await hostJson(services, `/internal/operator/pi/tasks/${taskId(prepared)}/abort`, {}));
    if (task.taskId === taskId(prepared) && task.status === 'cancelled') status = 'cancelled';
  } catch { /* Lost abort remains uncertain even if stopping succeeds. */ }
  return { status, cleanup: await cleanup(services) };
}
