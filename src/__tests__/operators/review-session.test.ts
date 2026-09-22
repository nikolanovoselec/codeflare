import { describe, expect, it } from 'vitest';
import { submitPreparedReview, cancelPreparedReview } from '../../operators/review-session';

// Existing owned-session and host API adapters are represented here, not a Flue runtime.
const prepared: any = { admission: { activityId: 'activity-one', generation: 2, inputDigest: 'a'.repeat(64),
  packageDigest: 'b'.repeat(64), resourceDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64) },
  context: { head: 'e'.repeat(40) }, packetDigest: 'f'.repeat(64),
  packets: [], resources: [] };
function fixture() {
  let status = 'running'; let restored = false; let stopped = false;
  const tasks = new Map<string, string>();
  const options = {
    authorize: async () => {},
    // These closures must be bound to OwnedOperatorSessionService by root composition.
    session: { ensure: async () => ({ status: 'ready' as const }), stop: async () => { stopped = true; return { status: 'stopped' as const }; } },
    restoreApprovedData: async () => { restored = true; },
    host: { fetch: async (path: string, init?: RequestInit) => {
      if (!restored) throw Error('prepared data not restored');
      if (path === '/internal/operator/pi/ensure') return Response.json({ conversationId: 'owned-conversation', ready: true });
      if (path.endsWith('/abort')) { status = 'cancelled'; return Response.json({ taskId: 'review-generation-2', status }); }
      const body = JSON.parse(String(init?.body));
      if (tasks.has(body.taskId) && tasks.get(body.taskId) !== body.digest) return Response.json({}, { status: 409 });
      tasks.set(body.taskId, body.digest);
      return Response.json({ taskId: body.taskId, status });
    } },
  };
  return { options, tasks, complete: () => { status = 'completed'; }, stopped: () => stopped };
}

describe('REQ-OPERATOR-050: existing owned-session and Pi services', () => {
  it('submits a stable task and reconciles it without treating task completion as durable report evidence', async () => {
    const f = fixture();
    expect(await submitPreparedReview(prepared, f.options)).toEqual({ status: 'running', taskId: 'review-generation-2' });
    f.complete();
    expect(await submitPreparedReview(prepared, f.options)).toEqual({ status: 'task-completed', taskId: 'review-generation-2' });
    expect([...f.tasks.keys()]).toEqual(['review-generation-2']);
    expect(f.stopped()).toBe(false); // Explicit sync/verification must still happen before stop.
  });
  it('fails closed on authority loss, invalid host responses or lost tasks and independently stops', async () => {
    for (const change of [
      { authorize: async () => { throw Error('revoked'); } },
      { host: { fetch: async () => Response.json({ status: 'completed', credential: 'candidate' }) } },
      { host: { fetch: async () => { throw Error('lost accepted response'); } } },
    ]) {
      const f = fixture();
      expect((await submitPreparedReview(prepared, { ...f.options, ...change })).status).toBe('unknown');
      expect(f.stopped()).toBe(true);
    }
  });
  it('cancels only the admitted task and reports independent cleanup uncertainty', async () => {
    const f = fixture(); await submitPreparedReview(prepared, f.options);
    expect(await cancelPreparedReview(prepared, f.options)).toEqual({ status: 'cancelled', cleanup: 'stopped' });
    expect(await cancelPreparedReview(prepared, { ...f.options,
      session: { ...f.options.session, stop: async () => { throw Error('lost stop'); } } })).toEqual({ status: 'cancelled', cleanup: 'unknown' });
  });
});
