import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OperatorActivityPreparation } from '../../../operators/activity';
import type { ActivityFixtureCommand } from './loader-worker';
import type { ExternalReceipt, FlueFixtureCommand, NativeArtifact, NativeDelivery } from './flue-native-fixture';

type Assessment = NativeDelivery & {
  result: { status: number; body: { accepted?: boolean; evidence?: unknown } };
  markers: Array<{ marker: string }>;
  probes: Record<string, { status?: number; denied?: boolean } | unknown>;
};
type Snapshot = {
  instance: string; digest: string; alarmDeliveries: number; barrierReached: boolean; failure?: string;
  external: ExternalReceipt[];
  facet: { instance: string; fibers: Array<{ status: string }> } | null;
  activity: { executionStatus: string; checkpoint: unknown; result: unknown; sessionId: string | null };
  conversation: { messages: Array<{ parts: Array<{ type: string; data?: Assessment }> }>;
    settlements: Array<{ submissionId: string; outcome: string }> } | null;
};
type Harness = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  queuedActivity(patch?: Partial<OperatorActivityPreparation>): Promise<OperatorActivityPreparation>;
  activity(id: string, command: ActivityFixtureCommand): Promise<unknown>;
};

/** Registered only from loader-runtime.test.ts; not a new runner or fake Loader. */
export function registerNativeDispatcherCases(harness: Harness) {
  async function command<T>(id: string, value: FlueFixtureCommand): Promise<T> {
    const response = await harness.fetch(`/flue?activity=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result as T;
  }
  const snapshot = (id: string) => command<Snapshot>(id, { action: 'snapshot' });
  function results(value: Snapshot): Assessment[] {
    return value.conversation?.messages.flatMap(message => message.parts)
      .filter(part => part.type === 'data-assessment').map(part => part.data!) ?? [];
  }
  async function observe(id: string, predicate: (value: Snapshot) => boolean, timeoutMs = 10_000): Promise<Snapshot> {
    const end = Date.now() + timeoutMs;
    let value = await snapshot(id);
    while (!predicate(value) && !value.failure && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 50));
      value = await snapshot(id);
    }
    // Timeouts return evidence to the assertion, never substitute a success.
    expect(value.failure, JSON.stringify(value)).toBeUndefined();
    expect(predicate(value), JSON.stringify(value)).toBe(true);
    return value;
  }
  async function pinnedArtifact() {
    const path = process.env.DISPATCHER_NATIVE_ARTIFACT;
    const expectedDigest = process.env.DISPATCHER_NATIVE_SHA256;
    const expectedSource = process.env.DISPATCHER_NATIVE_SOURCE_SHA;
    expect(path, 'CI must supply the real profile-built artifact').toBeTruthy();
    expect(expectedDigest, 'CI must bind the approved artifact bytes, not calculate and trust a new pin').toMatch(/^[a-f0-9]{64}$/);
    expect(expectedSource, 'CI must pin the profile source revision').toMatch(/^[a-f0-9]{40}$/);
    const bytes = await readFile(path!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedDigest);
    const artifact = JSON.parse(bytes.toString()) as NativeArtifact;
    expect(artifact).toMatchObject({ schemaVersion: 1, sourceCommit: expectedSource,
      className: 'FlueDispatcherAgent', versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' } });
    return { artifact, digest: expectedDigest! };
  }
  function delivery(id: string, patch: Partial<NativeDelivery> = {}): NativeDelivery {
    const operationId = patch.operationId ?? crypto.randomUUID();
    const marker = patch.marker ?? `marker:${id}`;
    return { activityId: id, generation: 1, operationId, marker, mode: 'read',
      requestDigest: createHash('sha256').update(JSON.stringify({ repositoryId: 123, operationId, marker })).digest('hex'), ...patch };
  }
  async function prepare(patch: Partial<OperatorActivityPreparation> = {}) {
    const pinned = await pinnedArtifact();
    const intent = await harness.queuedActivity(patch);
    const id = intent.activityId;
    expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 1, status: 'running' } });
    expect(await command(id, { action: 'configure', ...pinned })).toEqual({ ok: true, digest: pinned.digest, sourceCommit: pinned.artifact.sourceCommit });
    return { id, intent, digest: pinned.digest };
  }
  async function send(id: string, input = delivery(id)) {
    const started = Date.now();
    const outcome = await command<{ status: number; body: { submissionId: string } }>(id, { action: 'send', delivery: input });
    expect(outcome, 'Actual generated-class admission must succeed; unsupported host is behavioral RED').toMatchObject({ status: 202,
      body: { submissionId: expect.any(String) } });
    expect(Date.now() - started, 'HTTP admission must not wait for an entire drive').toBeLessThan(25_000);
    return outcome.body.submissionId;
  }
  async function settle(id: string, submissionId: string) {
    return observe(id, value => value.conversation?.settlements.some(s => s.submissionId === submissionId) === true);
  }
  async function positiveControl() {
    const { id } = await prepare();
    const submitted = await send(id);
    const value = await settle(id, submitted);
    expect(value.conversation?.settlements).toContainEqual({ submissionId: submitted, outcome: 'completed' });
    expect(results(value).at(-1)).toMatchObject({ activityId: id, result: { status: 200, body: { accepted: true } } });
    expect(value.external).toMatchObject([{ activityId: id, generation: 1, path: '/v1/dispatcher/github/read', sequence: 1 }]);
    return { id, value };
  }

  describe('REQ-OPERATOR-048/051: pinned generated Flue in native workerd', () => {
    it('executes a real model/tool submission through root alarms and records read-only Renovate evidence without a session', async () => {
      const { id } = await prepare();
      const submission = await send(id, delivery(id, { mode: 'hold' }));
      const running = await observe(id, value => value.barrierReached);
      expect(running.facet?.fibers).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'running' })]));
      await command(id, { action: 'release' });
      const value = await settle(id, submission);
      expect(value.conversation?.settlements).toContainEqual({ submissionId: submission, outcome: 'completed' });
      expect(value.alarmDeliveries).toBeGreaterThan(0);
      expect(results(value)[0].result).toMatchObject({ status: 200, body: { accepted: true } });
      expect(results(value)[0].result.body.evidence).toEqual({ repositoryId: 123, botId: 29139614, head: 'a'.repeat(40), checks: ['success'] });
      expect(value.activity.sessionId).toBeNull();
    });

    it('isolates two activities SQLite and recovers their exact pinned state after native root/facet eviction', async () => {
      const a = await prepare();
      const b = await prepare();
      const sa = await send(a.id, delivery(a.id, { marker: 'alice-installation-a' }));
      const sb = await send(b.id, delivery(b.id, { marker: 'bob-installation-b' }));
      const beforeA = await settle(a.id, sa);
      const beforeB = await settle(b.id, sb);
      await command(a.id, { action: 'evict' });
      await command(b.id, { action: 'evict' });
      const afterA = await snapshot(a.id);
      const afterB = await snapshot(b.id);
      expect(afterA.instance).not.toBe(beforeA.instance);
      expect(afterB.instance).not.toBe(beforeB.instance);
      expect(afterA.facet?.instance).not.toBe(beforeA.facet?.instance);
      expect(afterB.facet?.instance).not.toBe(beforeB.facet?.instance);
      expect(afterA.digest).toBe(a.digest);
      expect(afterB.digest).toBe(b.digest);
      expect(results(afterA)[0].markers).toEqual([{ marker: 'alice-installation-a' }]);
      expect(results(afterB)[0].markers).toEqual([{ marker: 'bob-installation-b' }]);
      expect(afterA.external).toEqual(beforeA.external);
      expect(afterB.external).toEqual(beforeB.external);
    });

    it('keeps 202 live, permits waiting only after segment settlement, and explicitly continues tool B in a new generation after eviction', async () => {
      const { id } = await prepare();
      const a = delivery(id, { mode: 'hold', marker: 'segment-a' });
      const submitted = await send(id, a);
      await observe(id, value => value.barrierReached);
      for (let i = 0; i < 3; i++) {
        const read = await snapshot(id);
        expect(read.activity).toMatchObject({ executionStatus: 'running', checkpoint: null });
        expect(read.external).toEqual([]);
        expect(await harness.activity(id, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-active' });
      }
      await command(id, { action: 'release' });
      const finished = await settle(id, submitted);
      expect(finished.conversation?.settlements).toContainEqual({ submissionId: submitted, outcome: 'completed' });
      const checkpoint = await observe(id, value => value.activity.executionStatus === 'waiting');
      expect(checkpoint.activity.checkpoint).not.toBeNull();
      await command(id, { action: 'evict' });
      await harness.activity(id, { action: 'evict' });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'running' } });
      const b = delivery(id, { generation: 2, marker: 'segment-b' });
      const next = await send(id, b);
      const final = await settle(id, next);
      expect(next).not.toBe(submitted);
      expect(results(final).at(-1)).toMatchObject({ generation: 2, markers: [{ marker: 'segment-a' }, { marker: 'segment-b' }] });
      expect(final.external).toMatchObject([{ operationId: a.operationId, generation: 1, sequence: 1 }, { operationId: b.operationId, generation: 2, sequence: 2 }]);
    });

    it('reconciles a completed parent receipt when eviction falls before the durable ToolStep records the response', async () => {
      const { id } = await prepare();
      const input = delivery(id, { mode: 'receipt-window' });
      const submission = await send(id, input);
      const before = await observe(id, value => value.barrierReached && value.external.length === 1);
      expect(before.external[0]).toMatchObject({ operationId: input.operationId, requestDigest: input.requestDigest, sequence: 1 });
      await command(id, { action: 'evict' });
      await command(id, { action: 'release' });
      const recovered = await settle(id, submission);
      expect(recovered.instance).not.toBe(before.instance);
      expect(recovered.conversation?.settlements).toContainEqual({ submissionId: submission, outcome: 'completed' });
      expect(results(recovered).at(-1)).toMatchObject({ result: { status: 200 } });
      expect(recovered.external).toEqual(before.external);
    });

    it('does not retry an accepted external effect with a lost result, and never calls unknown work a safe checkpoint', async () => {
      await positiveControl();
      const { id } = await prepare();
      try {
        const input = delivery(id, { mode: 'unknown' });
        await send(id, input);
        const before = await observe(id, value => value.barrierReached && value.external.length === 1);
        await command(id, { action: 'evict' });
        const after = await observe(id, value => value.activity.executionStatus === 'unknown');
        expect(after.external).toEqual(before.external);
        expect(after.activity.checkpoint).toBeNull();
        expect(await harness.activity(id, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
        // Metadata observation must not turn a failed/unknown segment into replay.
        expect((await snapshot(id)).external).toEqual(before.external);
      } finally {
        // The assertion intentionally leaves an unresolved external response.
        // Abort the real generated facet after observing that state so its live
        // fiber cannot keep the native Wrangler process alive after this case.
        await command(id, { action: 'abort' });
      }
    });

    it('fences a late result after an already-admitted effect without pretending cancellation undid that effect', async () => {
      const { id } = await prepare();
      const submission = await send(id, delivery(id, { mode: 'receipt-window' }));
      const accepted = await observe(id, value => value.barrierReached && value.external.length === 1);
      expect(await harness.activity(id, { action: 'cancel-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
      await command(id, { action: 'release' });
      const late = await settle(id, submission);
      expect(late.external).toEqual(accepted.external);
      expect(late.activity).toMatchObject({ executionStatus: 'cancel-requested', result: null });
      expect(await harness.activity(id, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
    });

    it('bounds unfinished work without labelling a timed-out live submission a safe waiting checkpoint', async () => {
      const { id } = await prepare();
      try {
        const started = Date.now();
        await send(id, delivery(id, { mode: 'hold' }));
        await observe(id, value => value.barrierReached);
        const timedOut = await observe(id, value => value.activity.executionStatus === 'unknown', 26_000);
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(timedOut.activity.checkpoint).toBeNull();
        expect(timedOut.external).toEqual([]);
        expect(await harness.activity(id, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
      } finally {
        // This case also deliberately leaves the model/tool fiber blocked.
        // Tear down only after the timeout-state observation above.
        await command(id, { action: 'abort' });
      }
    });

    it('conflicts changed input under a completed operation ID instead of performing another external read', async () => {
      const { id } = await prepare();
      const input = delivery(id);
      const first = await settle(id, await send(id, input));
      expect(results(first).at(-1)?.result.status).toBe(200);
      const changed = delivery(id, { operationId: input.operationId, marker: 'different-request' });
      const second = await settle(id, await send(id, changed));
      expect(results(second).at(-1)?.result.status).toBe(409);
      expect(second.external).toEqual(first.external);
    });

    it('denies session/container, mutation, parent storage, arbitrary scheduler/facet targets and direct egress, with an allowed control', async () => {
      const { id } = await prepare();
      const value = await settle(id, await send(id, delivery(id, { mode: 'probe' })));
      const output = results(value).at(-1)!;
      expect(output.result).toMatchObject({ status: 200, body: { accepted: true } });
      for (const path of ['/v1/dispatcher/session', '/v1/dispatcher/container', '/v1/dispatcher/github/write',
        '/v1/dispatcher/storage', '/v1/dispatcher/schedule', '/v1/dispatcher/facet']) {
        expect(output.probes[path], path).toMatchObject({ status: 403 });
      }
      expect(output.probes.egress).toEqual({ denied: true });
      expect(output.probes.parentStorage).toBeNull();
      expect(output.probes.bindings).toEqual(['OPERATOR']);
      expect(value.external).toMatchObject([{ path: '/v1/dispatcher/github/read', sequence: 1 }]);
      expect(value.external).toHaveLength(1);
      expect(value.activity.sessionId).toBeNull();
    });
  });

  describe('REQ-OPERATOR-047/048: captured generation native Flue authority', () => {
    it.each(['stale', 'expiry', 'cancel'] as const)('rejects a warmed %s caller before its protected operation and result commitment', async reason => {
      await positiveControl();
      const { id, intent } = await prepare(reason === 'expiry' ? { deadline: Date.now() + 5_000 } : {});
      const input = delivery(id, { mode: 'hold' });
      const submission = await send(id, input);
      const held = await observe(id, value => value.barrierReached);
      expect(held.external).toEqual([]);
      if (reason === 'stale') {
        // Adversarial rollover fault: change parent generation while an OLD
        // captured closure is still warm. This is not a safe-continuation claim.
        expect(await harness.activity(id, { action: 'commit-drive', generation: 1,
          update: { schemaVersion: 1, status: 'waiting', checkpoint: { fault: 'forced-rollover' } } })).toMatchObject({ ok: true });
        expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2 } });
      } else if (reason === 'cancel') {
        expect(await harness.activity(id, { action: 'cancel-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
      } else {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, intent.deadline - Date.now()) + 25));
      }
      await command(id, { action: 'release' });
      const after = await settle(id, submission);
      expect(results(after).at(-1)).toMatchObject({ generation: 1, result: { status: reason === 'stale' ? 409 : 403 } });
      expect(after.external).toEqual([]);
      expect(after.activity.result).toBeNull();
      if (reason === 'cancel') expect(after.activity.executionStatus).toBe('cancel-requested');
    });

    it('rejects a forged newer delivery generation through a warm native facet after rollover', async () => {
      const { id } = await prepare();
      const warm = delivery(id, { mode: 'hold', marker: 'warm-generation-one' });
      await send(id, warm);
      await observe(id, value => value.barrierReached);
      expect(await harness.activity(id, { action: 'commit-drive', generation: 1,
        update: { schemaVersion: 1, status: 'waiting', checkpoint: { fault: 'rollover-before-forgery' } } })).toMatchObject({ ok: true });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'running' } });

      // This submission reaches the existing generated facet, but its bridge was
      // bound to generation one when the owner created it. Delivery JSON cannot
      // replace that authority with generation two.
      const forged = delivery(id, { generation: 2, marker: 'forged-generation-two' });
      const forgedSubmission = await send(id, forged);
      await command(id, { action: 'release' });
      const after = await settle(id, forgedSubmission);
      const output = results(after).find(result => result.operationId === forged.operationId);
      expect(output).toMatchObject({ generation: 2, result: { status: 409 } });
      expect(after.external).toEqual([]);
    });
  });
}
