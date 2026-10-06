import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { createFlueCaseShard } from './flue-case-shard';
import type { DispatcherResultProjection } from '../../../operators/dispatcher-result';
// The Node harness exercises the pure publication parser; the Worker read transport is not loaded here.
vi.mock('../../../operators/operator-runtime-capability', () => ({ readDispatcherBody: () => {
  throw new Error('Unexpected Dispatcher body read in parser contract test');
} }));
import type { OperatorActivityPreparation } from '../../../operators/activity';
import { parsePublishableAssessment } from '../../../operators/renovate-publication';
import type { ActivityFixtureCommand } from './loader-worker';
import type { ExternalAttempt, ExternalReceipt, FlueFixtureCommand, NativeArtifact, NativeDelivery, NativeJourneyDiagnostic,
  NativeJourneyObservation, NativeJourneyScenario } from './flue-native-fixture';

type Assessment = NativeDelivery & {
  result: { status: number; body: { accepted?: boolean; evidence?: unknown } };
  markers: Array<{ marker: string }>;
  probes: Record<string, { status?: number; denied?: boolean } | unknown>;
};
type Snapshot = {
  instance: string; digest: string; alarmDeliveries: number; barrierReached: boolean; failure?: string;
  journeyOperations?: Record<string, { path: string; body: { url?: string; method?: string; body?: string } }>;
  journeyReceiptCount?: number;
  journeyResearchReads?: number;
  journeyInferenceBytes?: number[];
  external: ExternalReceipt[]; externalAttempts: ExternalAttempt[];
  productionCalls: Array<{ path: string; resource?: string; status?: number; modelTurn?: 'initial' | 'after-tool' }>;
  streamPhase: 'not-pulled' | 'prefix-enqueued' | 'error-injected';
  reconcileOutcome: 'active' | 'settled' | 'expiring' | 'interrupted';
  streamErrorVsExpiry: 'before' | 'after' | 'unobserved';
  interruptionVsError: 'before' | 'after' | 'unobserved';
  diagnosticReports: Array<{ activityId: string; generation: number; stage: string; status?: number }>;
  facet: { instance: string; fibers: Array<{ status: string }> } | null;
  tailProbe: { activityId: string; generation: number;
    diagnostics: Array<{ activityId: string; generation: number; stage: string; status?: number }>;
    summary: { deliveries: number; accepted: number; markerObject: number; markerString: number;
      unmarkedStringObject: number; unmarkedTwoStrings: number; otherLogs: number } } | null;
  activity: { executionStatus: string; checkpoint: unknown; result: unknown; sessionId: string | null };
  conversation: { messages: Array<{ submissionId?: string; parts: Array<{ type: string; data?: Assessment }> }>;
    settlements: Array<{ submissionId: string; outcome: string;
      error?: { type?: string; meta?: { operation?: string; reason?: string } } }> } | null;
};
type Harness = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  reset(): Promise<void>;
  queuedActivity(patch?: Partial<OperatorActivityPreparation>): Promise<OperatorActivityPreparation>;
  activity(id: string, command: ActivityFixtureCommand): Promise<unknown>;
};

/** Each native group runs against its own real Wrangler/workerd fixture. */
export function registerNativeDispatcherCases(
  harness: Harness,
  group: 'flue' | 'authority',
  shard = { index: 0, total: 1 },
) {
  const ownsNext = createFlueCaseShard(shard.index, shard.total);
  // Filter both ordinary declarations and table rows before registration;
  // unowned cases are not duplicated as skipped tests in the other reports.
  const it = Object.assign(
    ((...args: Parameters<typeof vitestIt>) => {
      if (ownsNext()) return Reflect.apply(vitestIt, undefined, args);
    }) as typeof vitestIt,
    { each: ((rows: readonly unknown[]) => {
      const owned = rows.filter(() => ownsNext());
      return owned.length ? vitestIt.each(owned) : () => undefined;
    }) as typeof vitestIt.each },
  );
  async function command<T>(id: string, value: FlueFixtureCommand, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`native fixture ${value.action} timed out`)), timeoutMs);
    console.info(`[native-flue] command begin: ${value.action} ${id}`);
    try {
      const response = await harness.fetch(`/flue?activity=${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
        signal: controller.signal,
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      console.info(`[native-flue] command end: ${value.action} ${id} status=${response.status}`);
      return result as T;
    } finally {
      clearTimeout(timer);
    }
  }
  const snapshot = (id: string) => command<Snapshot>(id, { action: 'snapshot' });
  async function observeTail(id: string, predicate: (receipt: NonNullable<Snapshot['tailProbe']>) => boolean) {
    const end = Date.now() + 10_000;
    let receipt: Snapshot['tailProbe'] = null;
    do {
      const response = await harness.fetch(`/flue-tail?activity=${encodeURIComponent(id)}`);
      expect(response.status).toBe(200);
      receipt = await response.json<Snapshot['tailProbe']>();
      if (receipt && predicate(receipt)) return receipt;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < end);
    expect(receipt && predicate(receipt), JSON.stringify(receipt)).toBe(true);
    return receipt!;
  }
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
  async function pinnedArtifact(journey = false) {
    const path = journey ? process.env.DISPATCHER_JOURNEY_NATIVE_ARTIFACT : process.env.DISPATCHER_NATIVE_ARTIFACT;
    const expectedDigest = journey ? process.env.DISPATCHER_JOURNEY_NATIVE_SHA256 : process.env.DISPATCHER_NATIVE_SHA256;
    const expectedSource = journey ? process.env.DISPATCHER_JOURNEY_NATIVE_SOURCE_SHA : process.env.DISPATCHER_NATIVE_SOURCE_SHA;
    expect(path, 'CI must supply the real profile-built artifact').toBeTruthy();
    expect(expectedDigest, 'CI must bind the approved artifact bytes, not calculate and trust a new pin').toMatch(/^[a-f0-9]{64}$/);
    expect(expectedSource, 'CI must pin the profile source revision').toMatch(/^[a-f0-9]{40}$/);
    const bytes = await readFile(path!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedDigest);
    const artifact = JSON.parse(bytes.toString()) as NativeArtifact;
    expect(artifact).toMatchObject({ schemaVersion: 1, sourceCommit: expectedSource,
      className: 'FlueDispatcherAgent', versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' } });
    // The compiler-produced file is pinned by its byte digest above; the facet
    // hashes its JSON-serialized object after parsing (which drops file formatting).
    return { artifact, digest: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') };
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
    return observe(id, value => {
      const settlement = value.conversation?.settlements.find(item => item.submissionId === submissionId);
      if (!settlement) return false;
      if (settlement.outcome !== 'completed') return true;
      return value.conversation?.messages.some(message => message.submissionId === submissionId
        && message.parts.some(part => part.type === 'data-assessment')) === true;
    });
  }
  async function positiveControl() {
    const { id } = await prepare();
    const submitted = await send(id);
    const value = await settle(id, submitted);
    expect(value.conversation?.settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ submissionId: submitted, outcome: 'completed' }),
    ]));
    expect(results(value).at(-1)).toMatchObject({ activityId: id, result: { status: 200, body: { accepted: true } } });
    expect(value.external).toMatchObject([{ activityId: id, generation: 1, path: '/v1/dispatcher/github/read', sequence: 1 }]);
    return { id, value };
  }

  if (group === 'authority') describe('REQ-OPERATOR-048: separate pinned native journey compatibility', () => {
    beforeEach(() => harness.reset(), 60_000);
    it.each([false, true])('REQ-OPERATOR-048: projects one exact empty discovery result through real SDK updates with oversized source metadata=%s', async oversizedSourceMetadata => {
      const pinned = await pinnedArtifact(true);
      const intent = await harness.queuedActivity();
      const id = intent.activityId;
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true });
      expect(await command(id, { action: 'configure', ...pinned, journey: true, oversizedSourceMetadata })).toMatchObject({ ok: true });
      const admission = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'authorized/project' },
      });
      expect(admission).toMatchObject({ status: 202, body: { submissionId: expect.any(String) } });
      let projection: DispatcherResultProjection = { offset: '-1', messageIds: [], writes: 0 };
      const end = Date.now() + 15_000;
      do {
        projection = await command(id, { action: 'journey-updates', submissionId: admission.body.submissionId, previous: projection });
        if (projection.outcome) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < end);
      expect(projection).toMatchObject({ outcome: 'completed', writes: 1, result: { repository: 'authorized/project', results: [] } });
      expect(projection.result).toEqual({ repository: 'authorized/project', results: [] });
      expect(new TextEncoder().encode(JSON.stringify(projection.result)).byteLength).toBeLessThanOrEqual(48 * 1024);
      const evidence = await snapshot(id);
      const operations = Object.values(evidence.journeyOperations ?? {});
      expect(operations.filter(item => item.path === '/v1/dispatcher/source').map(item => item.body.url)).toEqual([
        'https://api.github.com/repos/authorized/project',
        'https://api.github.com/users/renovate%5Bbot%5D',
        'https://api.github.com/repos/authorized/project/pulls?state=open&sort=created&direction=desc&per_page=1&page=1',
      ]);
      expect(operations.filter(item => item.path === '/v1/dispatcher/inference')).toHaveLength(3);
      // Seal's receipt observes two actual inference reservations plus three GETs, not source-only accounting.
      expect(evidence.journeyReceiptCount).toBe(5);
      expect(operations).toHaveLength(6);
      expect(evidence.external).toEqual([]);
      expect(evidence.activity.sessionId).toBeNull();
    }, 30_000);
  });

  if (group === 'authority') describe('REQ-OPERATOR-048: authentic pinned SDK inference producer compatibility', () => {
    beforeEach(() => harness.reset(), 60_000);

    // SDK-real + production-parser-real + synthetic upstream only. In particular,
    // this fixture does NOT exercise Activity's cached HTTP200 interruption replay,
    // full reservation/recovery, or collection. Root owns that separate boundary.
    async function runProducerJourney(scenario: NativeJourneyScenario, observationMs: number) {
      const pinned = await pinnedArtifact(true);
      const intent = await harness.queuedActivity();
      const id = intent.activityId;
      const now = Date.now();
      const createdAt = new Date(now - 86400000).toISOString();
      const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
      const admittedTarget = JSON.stringify({ repository: 'authorized/project', repositoryId: 123, ...target,
        createdAt, createdAfter: new Date(now - 2 * 86400000).toISOString(), baseBranch: 'main' });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true });
      expect(await command(id, { action: 'configure', ...pinned, journey: true, researchBodyBytes: 131072,
        admittedTarget, journeyFacts: { createdAt, unrelatedCreatedAt: new Date(now - 3600000).toISOString() },
        journeyScenario: scenario, admittedInferenceBytes: 1048576,
      })).toMatchObject({ ok: true });
      const admission = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'authorized/project' },
      });
      expect(admission).toMatchObject({ status: 202, body: { submissionId: expect.any(String) } });
      let projection: DispatcherResultProjection = { offset: '-1', messageIds: [], writes: 0 };
      let observation: NativeJourneyObservation;
      const end = Date.now() + observationMs;
      do {
        projection = await command(id, { action: 'journey-updates', submissionId: admission.body.submissionId, previous: projection });
        observation = await command(id, { action: 'journey-observation' });
        // RED stops on actual no-tools summary rejection, not generic SDK failure.
        if (projection.outcome || observation.wire.some(item => item.stage === 'summary' && item.admission === 'rejected')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < end);
      console.info(`[native-flue] producer=${scenario} wire=${JSON.stringify(observation!.wire)}`);
      return { id, target, submissionId: admission.body.submissionId, projection, observation: observation! };
    }

    function assertCitedCompletion(run: Awaited<ReturnType<typeof runProducerJourney>>) {
      const comment = 'Migration compatibility remains unverified. Source: https://docs.example.test/large-migration';
      expect(run.projection).toMatchObject({ outcome: 'completed', writes: 1 });
      // Intentional diagnostic wire, observed from the authentic pinned SDK's public stream.
      expect(Reflect.get(run.projection, 'completion')).toMatchObject({
        calls: [expect.objectContaining({ outcome: 'succeeded' })], truncated: false,
      });
      expect(Reflect.get(run.projection, 'readiness')).toEqual({ observations: 1, truncated: false, latest: {
        discovered: true, sealed: true, targetCount: 1, decisionCount: 1, resultCount: 1,
        unknownOperationCount: 0, category: 'ready',
      } });
      expect(Reflect.get(run.projection, 'sealPreflight')).toEqual({ observations: expect.any(Number), truncated: false, latest: {
        category: 'ready', targetCount: 1, decisionCount: 1, operationCount: expect.any(Number),
        operationLimit: 128, requiredOperationCount: 5, sealed: true,
      } });
      const seal = Reflect.get(run.projection, 'sealPreflight') as { observations: number; latest: { operationCount: number } };
      // Observations count accepted stream records, not unique producer tool calls.
      expect(Number.isSafeInteger(seal.observations)).toBe(true);
      expect(seal.observations).toBeGreaterThanOrEqual(1);
      expect(seal.observations).toBeLessThanOrEqual(32);
      expect(Number.isSafeInteger(seal.latest.operationCount)).toBe(true);
      expect(seal.latest.operationCount).toBeGreaterThanOrEqual(1);
      expect(seal.latest.operationCount).toBeLessThanOrEqual(123);
      expect(run.projection.result).toEqual({ repository: 'authorized/project', results: [{
        ...run.target, decision: 'DO_NOT_MERGE', comment, outcome: 'NOT_MERGED',
      }] });
      expect(new TextEncoder().encode(JSON.stringify(run.projection.result)).byteLength).toBeLessThanOrEqual(48 * 1024);
      expect(run.observation.effects).toEqual({ commentRequests: 1, otherMutationRequests: 0,
        commentMatches: true, researchSourceRequests: 1 });
      expect(run.observation.sessionId).toBeNull();
      for (const wire of run.observation.wire) {
        expect(wire.admission).toBe('accepted');
        expect(wire.messages).toBeGreaterThanOrEqual(1);
        expect(wire.messages).toBeLessThanOrEqual(128);
        expect(wire.tools).toBeLessThanOrEqual(32);
        if (wire.outputBudget !== null) {
          expect(Number.isInteger(wire.outputBudget)).toBe(true);
          expect(wire.outputBudget).toBeGreaterThan(0);
          expect(wire.outputBudget).toBeLessThanOrEqual(8192);
        }
      }
    }

    it('REQ-OPERATOR-076: authentic SDK emits seal observations across refused, ordinary, overflow and retry journeys', async () => {
      const runs = [];
      // Retain the global native bail fence. Run the full diagnostic scenario batch before asserting metadata.
      for (const scenario of ['seal-undiscovered', 'ordinary', 'overflow-once', 'transient-interruption-once'] as const) {
        runs.push({ scenario, run: await runProducerJourney(scenario, scenario === 'overflow-once' ? 45_000 : 25_000) });
      }
      for (const { scenario, run } of runs) {
        expect(run.projection.outcome).toBe('completed');
        if (scenario === 'seal-undiscovered') {
          expect(run.projection.writes).toBe(0); expect(run.projection.result).toBeUndefined();
          expect(run.observation.effects).toEqual({ commentRequests: 0, otherMutationRequests: 0,
            commentMatches: false, researchSourceRequests: 0 });
          expect.soft(Reflect.get(run.projection, 'sealPreflight'), scenario).toEqual({ observations: 1, truncated: false, latest: {
            category: 'undiscovered', targetCount: 0, decisionCount: 0, operationCount: null,
            operationLimit: null, requiredOperationCount: null, sealed: false,
          } });
        } else {
          expect(run.projection.writes).toBe(1);
          expect(run.projection.result).toMatchObject({ repository: 'authorized/project', results: [{
            ...run.target, decision: 'DO_NOT_MERGE', outcome: 'NOT_MERGED',
          }] });
          expect(run.observation.effects).toEqual({ commentRequests: 1, otherMutationRequests: 0,
            commentMatches: true, researchSourceRequests: 1 });
          expect.soft(Reflect.get(run.projection, 'sealPreflight'), scenario).toEqual({ observations: expect.any(Number), truncated: false, latest: {
            category: 'ready', targetCount: 1, decisionCount: 1, operationCount: expect.any(Number),
            operationLimit: 128, requiredOperationCount: 5, sealed: true,
          } });
          const seal = Reflect.get(run.projection, 'sealPreflight') as { observations: number } | undefined;
          expect.soft(Number.isSafeInteger(seal?.observations), scenario).toBe(true);
          expect.soft(seal?.observations, scenario).toBeGreaterThanOrEqual(1);
          expect.soft(seal?.observations, scenario).toBeLessThanOrEqual(32);
        }
        for (const wire of run.observation.wire) expect(wire.admission).toBe('accepted');
      }
    }, 150_000);

    it('REQ-OPERATOR-076: authentic failed seal emits closed undiscovered preflight without effects or assessment', async () => {
      const run = await runProducerJourney('seal-undiscovered', 25_000);
      expect(run.projection).toMatchObject({ outcome: 'completed', writes: 0 });
      expect(run.projection.result).toBeUndefined();
      expect(Reflect.get(run.projection, 'sealPreflight')).toEqual({ observations: 1, truncated: false, latest: {
        category: 'undiscovered', targetCount: 0, decisionCount: 0, operationCount: null,
        operationLimit: null, requiredOperationCount: null, sealed: false,
      } });
      expect(Reflect.get(run.projection, 'completion')).toMatchObject({
        calls: [expect.objectContaining({ outcome: 'failed' })], truncated: false,
      });
      expect(Reflect.get(run.projection, 'readiness')).toMatchObject({ observations: 1, truncated: false,
        latest: { category: 'undiscovered', discovered: false, sealed: false } });
      expect(run.observation.effects).toEqual({ commentRequests: 0, otherMutationRequests: 0,
        commentMatches: false, researchSourceRequests: 0 });
      for (const wire of run.observation.wire) expect(wire.admission).toBe('accepted');
    }, 45_000);

    it('REQ-OPERATOR-063: authentic failed finish emits undiscovered readiness but no assessment or effects', async () => {
      const run = await runProducerJourney('finish-undiscovered', 25_000);
      expect(run.projection).toMatchObject({ outcome: 'completed', writes: 0 });
      expect(run.projection.result).toBeUndefined();
      expect(Reflect.get(run.projection, 'completion')).toMatchObject({
        calls: [expect.objectContaining({ outcome: 'failed' })], truncated: false,
      });
      expect(Reflect.get(run.projection, 'readiness')).toEqual({ observations: 1, truncated: false, latest: {
        discovered: false, sealed: false, targetCount: 0, decisionCount: 0, resultCount: 0,
        unknownOperationCount: 0, category: 'undiscovered',
      } });
      expect(run.observation.effects).toEqual({ commentRequests: 0, otherMutationRequests: 0,
        commentMatches: false, researchSourceRequests: 0 });
      for (const wire of run.observation.wire) expect(wire.admission).toBe('accepted');
    }, 45_000);

    it('REQ-OPERATOR-048: repeated identical successful comment requests violate the exactly-one-comment observation contract', async () => {
      const intent = await harness.queuedActivity();
      const id = intent.activityId;
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true });
      expect(await command(id, { action: 'configure', ...await pinnedArtifact(true), journey: true,
        researchBodyBytes: 131072 })).toMatchObject({ ok: true });
      // The command helper verifies transport HTTP200; the envelope verifies
      // synthetic source201. Both deliveries carry the same operation/input.
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await command(id, { action: 'journey-comment-request' })).toMatchObject({ status: 201 });
      }
      const observation = await command<NativeJourneyObservation>(id, { action: 'journey-observation' });
      expect(observation.effects).toEqual({ commentRequests: 2, otherMutationRequests: 0,
        commentMatches: false, researchSourceRequests: 0 });
      expect(observation.effects).not.toMatchObject({ commentRequests: 1, commentMatches: true });
    }, 30_000);

    it('REQ-OPERATOR-048: ordinary repository-only SDK requests pass the real parser and complete one cited result without extra effects', async () => {
      const run = await runProducerJourney('ordinary', 25_000);
      expect(run.observation.wire.length).toBeGreaterThan(0);
      expect(run.observation.wire.every(item => item.stage === 'normal' && item.tools > 0
        && item.tokenField === 'absent' && item.outputBudget === null)).toBe(true);
      assertCitedCompletion(run);
    }, 45_000);

    it('REQ-OPERATOR-048: admitted overflow produces a real no-tools SDK summary, then continues the same submission to one cited complete result', async () => {
      const run = await runProducerJourney('overflow-once', 45_000);
      const wire = run.observation.wire;
      const firstSummary = wire.findIndex(item => item.stage === 'summary');
      expect(firstSummary, 'Overflow must reach an authentic SDK summary, not fail generically').toBeGreaterThan(0);
      // Discover + 24 successive genuine 2000-character research tool results
      // leave >8000 retained tokens and a valid cut point without 128 messages.
      expect(wire[firstSummary - 1]).toMatchObject({ admission: 'accepted', stage: 'normal' });
      expect(wire[firstSummary - 1].messages).toBeGreaterThanOrEqual(50);
      const summaries = wire.filter(item => item.stage === 'summary');
      expect(summaries.every(item => item.tools === 0 && item.messages === 2)).toBe(true);
      // Installed v0.1.8 RED must print completion-alias + actual budget (the
      // prefix can be 10000, not necessarily 16000), with parser=rejected.
      // Root's official rebuilt package must instead emit canonical <=8192.
      expect(summaries.map(item => item.admission), `Authentic summary parser admission: ${JSON.stringify(summaries)}`)
        .toEqual(summaries.map(() => 'accepted'));
      for (const summary of summaries) {
        expect(summary.tokenField).toBe('canonical');
        expect(summary.outputBudget).not.toBeNull();
        expect(Number.isInteger(summary.outputBudget)).toBe(true);
        expect(summary.outputBudget).toBeGreaterThan(0);
        expect(summary.outputBudget).toBeLessThanOrEqual(8192);
      }
      expect(wire.slice(firstSummary + 1).some(item => item.stage === 'normal' && item.admission === 'accepted' && item.tools > 0),
        'A happy journey with no SDK normal continuation is not recovery coverage').toBe(true);
      // The host answers continuation only if the real SDK wire carries the
      // summary response. Projection is scoped to the original submitted ID.
      assertCitedCompletion(run);
      const collectedAgain = await command<DispatcherResultProjection>(run.id, { action: 'journey-updates',
        submissionId: run.submissionId, previous: run.projection });
      expect(collectedAgain).toEqual(run.projection);
    }, 65_000);

    it('REQ-OPERATOR-048: a genuine SDK transient interruption retry has compatible normal wire and completes only in the parser-real synthetic upstream', async () => {
      const run = await runProducerJourney('transient-interruption-once', 40_000);
      const wire = run.observation.wire;
      expect(wire.every(item => item.stage === 'normal' && item.tokenField === 'absent' && item.tools > 0)).toBe(true);
      // Only closed booleans cross the observation boundary. Internal content
      // digests bind the actual post-interruption request to its original wire.
      expect(run.observation).toMatchObject({ interruptionObserved: true, retryIdentityMatched: true });
      assertCitedCompletion(run);
    }, 60_000);
  });

  if (group === 'authority') describe('REQ-OPERATOR-048/062: admitted-target compiled entry compatibility', () => {
    beforeEach(() => harness.reset(), 60_000);
    // Actual pinned generated class + SDK tools/updates, with synthetic parent
    // metadata and remote facts. Not Registry/scanner, production Loader or live cleanup proof.
    it('completes a cited negative singleton journey without selecting the unrelated Renovate PR', async () => {
      // Root must replace the existing journey artifact/pins with corrected
      // official-CI bytes; unchanged old bytes are not a compatible candidate.
      const pinned = await pinnedArtifact(true);
      const intent = await harness.queuedActivity();
      const id = intent.activityId;
      const now = Date.now();
      const createdAt = new Date(now - 86400000).toISOString();
      const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
      const admittedTarget = JSON.stringify({ repository: 'authorized/project', repositoryId: 123, ...target,
        createdAt, createdAfter: new Date(now - 2 * 86400000).toISOString(), baseBranch: 'main' });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true });
      expect(await command(id, { action: 'configure', ...pinned, journey: true, researchBodyBytes: 131072,
        admittedTarget, journeyFacts: { createdAt, unrelatedCreatedAt: new Date(now - 3600000).toISOString() },
      })).toMatchObject({ ok: true });
      // Public submission remains repository-only; target metadata is env-only.
      const admission = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'authorized/project' },
      });
      expect(admission).toMatchObject({ status: 202, body: { submissionId: expect.any(String) } });
      let projection: DispatcherResultProjection = { offset: '-1', messageIds: [], writes: 0 };
      const end = Date.now() + 25_000;
      do {
        projection = await command(id, { action: 'journey-updates', submissionId: admission.body.submissionId, previous: projection });
        if (projection.outcome) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < end);
      const url = 'https://docs.example.test/large-migration';
      const comment = `Migration compatibility remains unverified. Source: ${url}`;
      expect(projection).toMatchObject({ outcome: 'completed', writes: 1 });
      expect(projection.result).toEqual({ repository: 'authorized/project', results: [{
        ...target, decision: 'DO_NOT_MERGE', comment, outcome: 'NOT_MERGED',
      }] });
      const evidence = await snapshot(id);
      const sources = Object.values(evidence.journeyOperations ?? {}).filter(item => item.path === '/v1/dispatcher/source');
      expect(sources.some(item => item.body.url === url)).toBe(true);
      expect(sources.some(item => item.body.url === 'https://api.github.com/repos/authorized/project/pulls/17')).toBe(true);
      // Accepted source wires observe the actual compiled tool effects, not private calls.
      expect(sources.filter(item => /\/(?:pulls|issues)\/\d+(?:\/|$)/.test(item.body.url ?? ''))
        .every(item => /\/(?:pulls|issues)\/17(?:\/|$)/.test(item.body.url!))).toBe(true);
      expect(sources.filter(item => (item.body.method ?? 'GET') !== 'GET').map(item => item.body)).toEqual([{
        operationId: 'submission-pr-17-comment',
        url: 'https://api.github.com/repos/authorized/project/issues/17/comments', method: 'POST',
        body: JSON.stringify({ body: comment }),
      }]);
    }, 45_000);
  });

  if (group === 'authority') describe('REQ-OPERATOR-047/048: native large research artifact windows', () => {
    beforeEach(() => harness.reset(), 60_000);
    it.each([131072, 262144, 1044480] as const)('REQ-OPERATOR-047/048: settles cited fresh and cached research from %s source bytes without widening inference', async researchBodyBytes => {
      const pinned = await pinnedArtifact(true);
      const intent = await harness.queuedActivity();
      const id = intent.activityId;
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true });
      expect(await command(id, { action: 'configure', ...pinned, journey: true, researchBodyBytes })).toMatchObject({ ok: true });
      const admission = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'authorized/project' },
      });
      expect(admission).toMatchObject({ status: 202, body: { submissionId: expect.any(String) } });
      let projection: DispatcherResultProjection = { offset: '-1', messageIds: [], writes: 0 };
      const end = Date.now() + 25_000;
      do {
        projection = await command(id, { action: 'journey-updates', submissionId: admission.body.submissionId, previous: projection });
        if (projection.outcome) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < end);
      const url = 'https://docs.example.test/large-migration';
      const quote = 'Migration compatibility remains unverified.';
      const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
      const comment = `${quote} Source: ${url}`;
      // Diagnose the exact submission before the success assertion can bail.
      // Only fixed public-SDK tool/error classes leave the Worker, never bodies.
      if (projection.outcome !== 'completed') {
        const diagnostic = await command<NativeJourneyDiagnostic>(id, {
          action: 'journey-diagnostic', submissionId: admission.body.submissionId,
        });
        console.info(`[native-flue] research bytes=${researchBodyBytes} diagnostic=${JSON.stringify(diagnostic)}`);
      }
      expect(projection).toMatchObject({ outcome: 'completed', writes: 1 });
      expect(projection.result).toEqual({ repository: 'authorized/project', results: [{
        ...target, decision: 'DO_NOT_MERGE', comment, outcome: 'NOT_MERGED',
      }] });
      const evidence = await snapshot(id);
      const operations = Object.values(evidence.journeyOperations ?? {});
      const inference = operations.filter(item => item.path === '/v1/dispatcher/inference');
      expect(inference).toHaveLength(7);
      // These are actual SDK-to-parent request bytes; the unchanged parser also
      // rejects oversized requests before our synthetic model can answer them.
      expect(evidence.journeyInferenceBytes).toHaveLength(7);
      for (const bytes of evidence.journeyInferenceBytes ?? []) expect(bytes).toBeLessThanOrEqual(65536);
      expect(evidence.journeyResearchReads).toBe(1);
      expect(operations.filter(item => item.path === '/v1/dispatcher/source' && item.body.url === url)).toHaveLength(1);
      const comments = operations.filter(item => item.path === '/v1/dispatcher/source' && item.body.method === 'POST');
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toMatchObject({
        url: 'https://api.github.com/repos/authorized/project/issues/17/comments', body: JSON.stringify({ body: comment }),
      });
      expect(operations.filter(item => item.body.method === 'PUT')).toEqual([]);

      // Inspect model-facing artifact wire values in actual next-inference
      // messages, not package state or a mock return value. SDK tool messages
      // may carry structured objects or JSON-serialized content.
      type Window = { id: string; digest: string; body: string; bodyOffset: number; bodyLength: number;
        bodyTruncated: boolean; receipt: unknown };
      const windows: Window[] = [];
      const visit = (value: unknown): void => {
        if (typeof value === 'string') {
          if (/^\s*[[{]/.test(value)) {
            try { visit(JSON.parse(value)); } catch { /* Ordinary untrusted text. */ }
          }
        } else if (Array.isArray(value)) {
          for (const item of value) visit(item);
        } else if (value && typeof value === 'object') {
          const item = value as Record<string, unknown>;
          if (item.bodyLength === researchBodyBytes && typeof item.bodyOffset === 'number') windows.push(item as unknown as Window);
          for (const field of Object.values(item)) visit(field);
        }
      };
      visit(inference.at(-1)?.body);
      const fresh = windows.find(item => item.bodyOffset === 0);
      const cached = windows.find(item => item.bodyOffset === researchBodyBytes - 2000);
      const fullBody = 'x'.repeat(researchBodyBytes - 2000) + quote + 'y'.repeat(2000 - quote.length);
      const artifactId = `artifact-${createHash('sha256').update(JSON.stringify({ target, url, kind: 'upstream' })).digest('hex').slice(0, 24)}`;
      const digest = createHash('sha256').update(fullBody).digest('hex');
      expect(fresh).toMatchObject({ id: artifactId, digest, body: 'x'.repeat(2000),
        bodyOffset: 0, bodyLength: researchBodyBytes, bodyTruncated: true });
      expect(cached).toMatchObject({ id: artifactId, digest, body: quote + 'y'.repeat(2000 - quote.length),
        bodyOffset: researchBodyBytes - 2000, bodyLength: researchBodyBytes, bodyTruncated: true });
      expect(cached?.receipt).toEqual(fresh?.receipt);
      expect(cached?.receipt).toMatchObject({ generation: 1, requestDigest: expect.any(String), responseDigest: expect.any(String) });
      expect(evidence.external).toEqual([]);
      expect(evidence.activity.sessionId).toBeNull();
    }, 45_000);
  });

  if (group === 'flue') describe('REQ-OPERATOR-048/051: pinned generated Flue in native workerd', () => {
    beforeEach(() => harness.reset(), 60_000);

    it('executes a real model/tool submission through root alarms and records read-only Renovate evidence without a session', async () => {
      const { id } = await prepare();
      const submission = await send(id, delivery(id, { mode: 'hold' }));
      const running = await observe(id, value => value.barrierReached);
      // The observable contract is a durable Flue tool turn held inside the
      // parent-authorized operation. Agent.listFibers() is an SDK diagnostic and
      // Flue 2.1 does not expose its active tool promise there.
      expect(running.conversation?.messages.at(-1)?.parts).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'dynamic-tool' }),
      ]));
      await command(id, { action: 'release' });
      const value = await settle(id, submission);
      expect(value.conversation?.settlements).toEqual(expect.arrayContaining([
        expect.objectContaining({ submissionId: submission, outcome: 'completed' }),
      ]));
      expect(value.alarmDeliveries).toBeGreaterThan(0);
      expect(results(value)[0].result).toMatchObject({ status: 200, body: { accepted: true } });
      expect(results(value)[0].result.body.evidence).toEqual({ repositoryId: 123, botId: 29139614, head: 'a'.repeat(40), checks: ['success'] });
      expect(value.activity.sessionId).toBeNull();
    });

    it.each([
      { name: 'complete', filesHead: 'b'.repeat(40), truncated: false, conclusion: 'success',
        expected: { complete: true, stale: false, truncated: false } },
      { name: 'incomplete', filesHead: 'c'.repeat(40), truncated: true, conclusion: 'failure',
        expected: { complete: false, stale: true, truncated: true } },
    ])('executes compiled production Renovate assessment through parent reads ($name)', async variant => {
      const { id } = await prepare();
      const evidence = {
        'pull-request': { number: 17, head: { sha: 'b'.repeat(40) }, base: { sha: 'a'.repeat(40) },
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' } },
        files: { observedHead: variant.filesHead, truncated: variant.truncated, data: [{ filename: 'README.md' }] },
        checks: { observedHead: 'b'.repeat(40), truncated: false,
          data: { check_runs: [{ name: 'test', conclusion: variant.conclusion }] } },
      };
      const admission = await command<{ status: number; body: { submissionId: string } }>(id,
        { action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 }, productionEvidence: evidence });
      expect(admission).toMatchObject({ status: 202, body: { submissionId: expect.any(String) } });
      const value = await settle(id, admission.body.submissionId);
      expect(value.conversation?.settlements, JSON.stringify({ productionCalls: value.productionCalls,
        messages: value.conversation?.messages, failure: value.failure, activityStatus: value.activity.executionStatus }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ submissionId: admission.body.submissionId, outcome: 'completed' }),
        ]));
      expect(results(value).at(-1)).toMatchObject({ repository: 'owner/repository', pullRequest: 17,
        readOnly: true, evidence: variant.expected });
      expect(value.productionCalls.filter(call => call.path === '/v1/dispatcher/github/read').map(call => call.resource))
        .toEqual(['pull-request', 'files', 'checks']);
      expect(value.productionCalls.some(call => call.path === '/v1/dispatcher/inference')).toBe(true);
      expect(value.external).toEqual([]);
      expect(value.activity.sessionId).toBeNull();
    });

    // Counterfactual natural-language release receipts test reasoning; neither is an actual release claim.
    const compatible = 'Dozzle v11.1.2 keeps the server-to-agent protocol compatible with v11.1.1. No migration is needed for the agent subcommand when upgrading both images to v11.1.2.';
    const adverse = 'Dozzle v11.1.2 removes the agent subcommand. Containers still launched with command: agent fail to start; migrate them to command: relay before upgrading.';
    const actual = '  - Point duplicate host warning at the docs site  -  by @amir20 and Claude Opus 5.5 (1M context) in https://github.com/amir20/dozzle/issues/5239';
    const releaseSource = 'https://github.com/amir20/dozzle/releases/tag/v11.1.2';
    const guideSource = `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`;
    const guideQuote = 'To create a Dozzle agent, you need to run Dozzle with the `agent` subcommand.';
    const changedPaths = ['middleware/dozzle/compose.yaml', 'ai_llm/dozzle_agent/compose.yaml',
      'dns_ntp/dozzle_agent/compose.yaml', 'komodo_core/dozzle_agent/compose.yaml',
      'media_servers/dozzle_agent/compose.yaml', 'minecraft/dozzle_agent/compose.yaml',
      'nextcloud/dozzle_agent/compose.yaml', 'openziti-i/dozzle_agent/compose.yaml',
      'openziti-ii/dozzle_agent/compose.yaml', 'openziti-iii/dozzle_agent/compose.yaml',
      'servarr/dozzle_agent/compose.yaml', 'storage/dozzle_agent/compose.yaml',
      'tools/dozzle_agent/compose.yaml'];
    function assessmentEvidence(note = compatible) {
      const head = 'b'.repeat(40), base = 'a'.repeat(40);
      return {
        'pull-request': { number: 17, head: { sha: head }, base: { sha: base },
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' } },
        files: { observedHead: head, truncated: false, data: changedPaths.map(path => ({ filename: path,
          status: 'modified', sha: 'd'.repeat(40), additions: 1, deletions: 1,
          patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2' })) },
        checks: { observedHead: head, truncated: false, data: { check_runs: [] } },
        'release-notes': { observedHead: head, repository: 'amir20/dozzle', tag: 'v11.1.2',
          source: releaseSource, body: note },
        'upstream-guide': { observedHead: head, repository: 'amir20/dozzle', tag: 'v11.1.2',
          source: guideSource, commitSha: '1'.repeat(40), blobSha: '2'.repeat(40),
          body: `${guideQuote}\nDOZZLE_REMOTE_AGENT=agent:7007` },
        'changed-compose': { repository: 'owner/repository', pullRequest: 17, baseSha: base, observedHead: head,
          files: changedPaths.map((path, index) => ({ path,
            before: { sha: 'e'.repeat(40), services: [{ name: index === 0 ? 'dozzle' : 'dozzle-agent',
              mode: index === 0 ? 'server' : 'agent', image: 'amir20/dozzle:v11.1.1',
              environmentKeys: [], redacted: false, ref: `before-${index}` }] },
            after: { sha: 'd'.repeat(40), services: [{ name: index === 0 ? 'dozzle' : 'dozzle-agent',
              mode: index === 0 ? 'server' : 'agent', image: 'amir20/dozzle:v11.1.2',
              environmentKeys: [], redacted: false, ref: `after-${index}` }] },
            unchangedConfiguration: true })) },
      };
    }
    function decision(classification: 'safe' | 'unsafe' | 'unknown', quote: string) {
      const reason = classification === 'unsafe'
        ? 'The cited v11.1.2 migration removes the agent command still used by the observed agent; the image-only bump lacks the required command change.'
        : classification === 'unknown'
          ? 'The cited upstream note changes a warning, not the agent/server protocol; compatibility is not established.'
          : 'The cited v11.1.2 passage explicitly preserves server-agent protocol and remote-agent setup; the observed server and agents change only image tags.';
      return { classification, reasons: [reason], compatibility: reason,
        citations: [{ kind: 'release', source: releaseSource, quote },
          { kind: 'guide', source: guideSource, quote: guideQuote },
          ...changedPaths.flatMap((_, index) => [{ kind: 'config', ref: `before-${index}` },
            { kind: 'config', ref: `after-${index}` }])],
        gaps: classification === 'unknown' ? ['Agent/server protocol support remains unverified.'] : [] };
    }
    it.each([
      { name: 'safe with zero checks', verdict: 'safe', note: compatible, quote: compatible },
      { name: 'unsafe with migration evidence', verdict: 'unsafe', note: adverse, quote: adverse },
      { name: 'authentic but inconclusive v11.1.2 notes', verdict: 'unknown', note: actual, quote: actual },
      { name: 'invented citation', verdict: 'unknown', note: compatible, quote: 'Invented protocol guarantee.' },
    ] as const)('binds a two-turn research→submit $name decision to pinned parent receipts', async variant => {
      const { id } = await prepare();
      const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: assessmentEvidence(variant.note),
        productionDecision: decision(variant.name === 'invented citation' ? 'safe' : variant.verdict, variant.quote),
      });
      expect(admitted.status).toBe(202);
      const value = await settle(id, admitted.body.submissionId);
      const compiled = results(value).at(-1);
      expect(compiled).toMatchObject({ repository: 'owner/repository', pullRequest: 17,
        observedHead: 'b'.repeat(40), readOnly: true, assessment: { classification: variant.verdict,
          compatibility: expect.any(String), reasons: expect.any(Array), citations: expect.any(Array),
          gaps: expect.any(Array) } });
      expect(parsePublishableAssessment(compiled))
        .toMatchObject({ classification: variant.verdict, observedHead: 'b'.repeat(40) });
      expect(value.productionCalls.filter(call => call.path === '/v1/dispatcher/github/read').map(call => call.resource).sort())
        .toEqual(['pull-request', 'files', 'checks', 'release-notes', 'upstream-guide', 'changed-compose'].sort());
      expect(value.productionCalls.filter(call => call.path === '/v1/dispatcher/inference').map(call => call.modelTurn))
        .toEqual(['initial', 'after-tool']);
      expect(value.external).toEqual([]);
      expect(value.activity.sessionId).toBeNull();
    });

    it('completes a publishable second-turn assessment only after all parallel research receipts are released', async () => {
      const { id } = await prepare();
      const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: assessmentEvidence(), productionDecision: decision('safe', compatible), holdResearch: true,
      });
      expect(admitted.status).toBe(202);
      const held = await observe(id, value => value.barrierReached);
      expect(held.conversation?.settlements.some(item => item.submissionId === admitted.body.submissionId)).toBe(false);
      await command(id, { action: 'release' });
      const value = await settle(id, admitted.body.submissionId);
      expect(value.conversation?.settlements).toEqual(expect.arrayContaining([
        expect.objectContaining({ submissionId: admitted.body.submissionId, outcome: 'completed' }),
      ]));
      const compiled = results(value).at(-1);
      expect(compiled).toMatchObject({ repository: 'owner/repository', pullRequest: 17,
        observedHead: 'b'.repeat(40), readOnly: true, assessment: { classification: 'safe' } });
      expect(parsePublishableAssessment(compiled)).toMatchObject({ classification: 'safe', observedHead: 'b'.repeat(40) });
      expect(value.external).toEqual([]);
      expect(value.activity.sessionId).toBeNull();
    });

    it('settles a cited second-turn assessment after the former child timeout without extending human authority', async () => {
      const { id } = await prepare();
      const startedAt = Date.now();
      try {
        const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
          action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
          productionEvidence: assessmentEvidence(), productionDecision: decision('safe', compatible), holdInference: true,
        });
        expect(admitted.status).toBe(202);
        await observe(id, value => value.barrierReached
          && value.productionCalls.some(call => call.path === '/v1/dispatcher/inference' && call.modelTurn === 'after-tool'));
        await new Promise(resolve => setTimeout(resolve, 29_000));
        const held = await snapshot(id);
        expect(held.conversation?.settlements.some(item => item.submissionId === admitted.body.submissionId)).toBe(false);
        await command(id, { action: 'release' });
        const value = await observe(id, state => state.activity.executionStatus === 'waiting'
          && state.conversation?.settlements.some(item => item.submissionId === admitted.body.submissionId
            && item.outcome === 'completed') === true, 12_000);
        expect(Date.now() - startedAt).toBeGreaterThan(27_000);
        const result = results(value).at(-1);
        expect(parsePublishableAssessment(result)).toMatchObject({ classification: 'safe', observedHead: 'b'.repeat(40) });
        expect(value.activity.checkpoint).not.toBeNull();
      } finally {
        await command(id, { action: 'release' });
        await command(id, { action: 'abort' });
      }
    }, 55_000);

    it.each(['missing-notes', 'missing-guide', 'missing-config', 'stale-head', 'unsupported-notes', 'malformed-decision'] as const)(
      'records unknown for $name rather than inventing compatibility or mutating', async scenario => {
        const { id } = await prepare();
        const evidence: Record<string, unknown> = assessmentEvidence(scenario === 'unsupported-notes'
          ? actual : compatible);
        if (scenario === 'missing-notes') delete evidence['release-notes'];
        if (scenario === 'missing-guide') delete evidence['upstream-guide'];
        if (scenario === 'missing-config') delete evidence['changed-compose'];
        if (scenario === 'stale-head') evidence.files = { ...(evidence.files as object), observedHead: 'c'.repeat(40) };
        const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
          action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 }, productionEvidence: evidence,
          productionDecision: scenario === 'malformed-decision' ? { classification: 'safe', citations: 'invented' }
            : decision(scenario === 'unsupported-notes' ? 'unknown' : 'safe',
              scenario === 'unsupported-notes' ? actual : compatible),
        });
        expect(admitted.status).toBe(202);
        const value = await settle(id, admitted.body.submissionId);
        expect(results(value).at(-1)).toMatchObject({ readOnly: true, assessment: { classification: 'unknown' },
          ...(['missing-notes', 'missing-guide', 'missing-config'].includes(scenario) ? { evidence: { complete: false } } : {}) });
        expect(value.external).toEqual([]);
        expect(value.activity.sessionId).toBeNull();
      });

    it.each(['finish-early', 'persistent-malformed'] as const)(
      'does not publish a safe result when the model %s', async productionBehavior => {
        const { id } = await prepare();
        const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
          action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
          productionEvidence: assessmentEvidence(), productionBehavior,
          productionDecision: { classification: 'safe', citations: 'malformed' },
        });
        expect(admitted.status).toBe(202);
        const value = await observe(id, snapshot => snapshot.activity.executionStatus === 'unknown', 12_000);
        expect(results(value)).toEqual([]);
        expect(value.external).toEqual([]);
      });

    async function assertCompiledHttpRejection(productionBehavior: 'model-error' | 'model-error-empty') {
      const { id } = await prepare();
      const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: assessmentEvidence(), productionBehavior,
      });
      expect(admitted.status).toBe(202);
      const value = await observe(id, snapshot => snapshot.activity.executionStatus === 'unknown'
        && (snapshot.conversation?.settlements.some(item =>
          item.submissionId === admitted.body.submissionId && item.outcome === 'failed') ?? false), 15_000);
      const settlement = value.conversation!.settlements.find(item => item.submissionId === admitted.body.submissionId);
      expect(settlement).toMatchObject({ outcome: 'failed', error: { type: 'operation_failed',
        meta: { operation: `direct(${admitted.body.submissionId})`, reason: 'Parent inference denied: 422' } } });
      expect(value.productionCalls.filter(call => call.path === '/v1/dispatcher/inference').at(-1)?.status).toBe(422);
      const diagnosed = await observe(id, receipt => receipt.diagnosticReports.some(item =>
        item.stage === 'http-rejected' && item.status === 422), 3_000);
      expect(diagnosed.diagnosticReports).toEqual([{ activityId: id, generation: 1, stage: 'http-rejected', status: 422 }]);
      expect(JSON.stringify(diagnosed.diagnosticReports)).not.toContain('fixture model rejected');
      expect(results(value)).toEqual([]);
      expect(value.activity.executionStatus).toBe('unknown');
      expect(value.external).toEqual([]);
    }

    it('REQ-OPERATOR-048: failed compiled durable direct submission carries its bounded Flue operation label',
      async () => assertCompiledHttpRejection('model-error'));

    it('REQ-OPERATOR-048: compiled diagnostic report retains bodyless after-tool HTTP rejection',
      async () => assertCompiledHttpRejection('model-error-empty'));

    it('captures only sanitized child warnings through an actual Loader Tail Worker', async () => {
      const { id } = await prepare();
      expect(await command(id, { action: 'tail-probe' })).toEqual({ status: 200, body: 'ok' });
      const receipt = await observeTail(id, value => value.diagnostics.length === 2);
      expect(receipt).toMatchObject({ activityId: id, generation: 1, diagnostics: [
        { activityId: id, generation: 1, stage: 'fetch-rejected' },
        { activityId: id, generation: 1, stage: 'http-rejected', status: 422 },
      ] });
      expect(JSON.stringify(receipt)).not.toContain('PRIVATE_PROVIDER_BODY_SENTINEL');
      expect(await command(id, { action: 'tail-probe-empty' })).toEqual({ status: 200, body: 'ok' });
      const retained = await observeTail(id, value => value.summary.unmarkedStringObject > 0);
      expect(retained.diagnostics).toMatchObject([
        { activityId: id, generation: 1, stage: 'fetch-rejected' },
        { activityId: id, generation: 1, stage: 'http-rejected', status: 422 },
      ]);
      expect(retained.summary).toMatchObject({ accepted: 2, markerObject: 3, unmarkedStringObject: 1 });
      expect(JSON.stringify(retained)).not.toContain('PRIVATE_PROVIDER_BODY_SENTINEL');
      expect(await command(id, { action: 'tail-probe-silent' })).toEqual({ status: 200, body: 'ok' });
      const silent = await observeTail(id, value => value.summary.deliveries > retained.summary.deliveries);
      expect(silent.diagnostics).toEqual(retained.diagnostics);
      expect((await snapshot(id)).activity.executionStatus).toBe('running');
    });

    it('compares awaited and waitUntil rejection Tail receipts without waking the Flue owner', async () => {
      const { id } = await prepare();
      expect(await command(id, { action: 'tail-probe-awaited' })).toEqual({ status: 599, body: 'rejected' });
      const awaited = await observeTail(id, receipt => receipt.summary.accepted >= 1);
      expect(awaited).toMatchObject({ activityId: id, generation: 1,
        summary: { markerObject: 1, accepted: 1 },
        diagnostics: [{ activityId: id, generation: 1, stage: 'fetch-rejected' }] });
      expect(await command(id, { action: 'tail-probe-background' })).toEqual({ status: 200, body: 'ok' });
      const background = await observeTail(id, receipt => receipt.summary.accepted >= 2);
      expect(background).toMatchObject({ activityId: id, generation: 1,
        summary: { markerObject: 2, accepted: 2 },
        diagnostics: [
          { activityId: id, generation: 1, stage: 'fetch-rejected' },
          { activityId: id, generation: 1, stage: 'fetch-rejected' },
        ] });
      expect((await snapshot(id)).activity.executionStatus).toBe('running');
    });

    it.each(['direct', 'scheduled', 'fiber', 'rpc-fiber'] as const)(
      'REQ-OPERATOR-048: synthetic Loader facet %s warning is observable after independent completion', async mode => {
        const { id } = await prepare();
        expect(await command(id, { action: 'facet-tail-probe', mode })).toEqual({ started: true });
        const end = Date.now() + 10_000;
        let receipt: { completed: boolean; callbackReturned?: boolean };
        if (mode === 'fiber' || mode === 'rpc-fiber') {
          do {
            receipt = await command(id, { action: 'facet-tail-receipt', mode });
            if (receipt.callbackReturned) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          } while (Date.now() < end);
          expect(receipt!).toMatchObject({ callbackReturned: true, completed: false });
          expect(await command(id, { action: 'facet-tail-release-fiber' })).toEqual({ released: true });
        }
        do {
          receipt = await command(id, { action: 'facet-tail-receipt', mode });
          if (receipt.completed) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < end);
        expect(receipt!).toMatchObject({ completed: true });
        if (mode === 'rpc-fiber') {
          expect(receipt!).toMatchObject({ warningCompleted: true, callbackReturned: true });
          const diagnosed = await observe(id, value => value.diagnosticReports.some(item => item.stage === 'fetch-rejected'), 3_000);
          expect(diagnosed.diagnosticReports).toEqual([{ activityId: id, generation: 1, stage: 'fetch-rejected' }]);
          const passive = await harness.fetch(`/flue-tail?activity=${encodeURIComponent(id)}`);
          expect(passive.status).toBe(200);
          const tail = await passive.json<Snapshot['tailProbe']>();
          console.info(`[native-flue] rpc-fiber Tail deliveries=${tail?.summary.deliveries ?? 0} accepted=${tail?.summary.accepted ?? 0}`);
        } else {
          const diagnosed = await observeTail(id, value => value.diagnostics.some(item => item.stage === 'fetch-rejected'));
          expect(diagnosed).toMatchObject({ activityId: id, generation: 1,
            diagnostics: [{ activityId: id, generation: 1, stage: 'fetch-rejected' }] });
        }
      });

    it.each([
      { mode: 'fetch-reject' as const, sentinel: 'Controlled inference fetch rejected' },
      { mode: 'abort-reject' as const, sentinel: 'Controlled inference fetch aborted' },
      { mode: 'stream-fail' as const, sentinel: 'Controlled inference stream failed' },
    ])('characterizes a controlled $mode after-tool inference through the compiled child', async ({ mode, sentinel }) => {
      const { id } = await prepare();
      const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: assessmentEvidence(), productionBehavior: mode,
      });
      expect(admitted.status).toBe(202);
      let value = await observe(id, state => state.productionCalls.some(call =>
        call.path === '/v1/dispatcher/inference' && call.modelTurn === 'after-tool'));
      const rootInstance = value.instance;
      // The pinned Flue transient retry policy can back off 2 + 4 + 8 seconds.
      // Only this controlled stream case allows that bounded retry progress plus
      // the original ten-second settlement allowance; authority is unchanged.
      const end = Date.now() + (mode === 'stream-fail' ? 24_000 : 10_000);
      let settlement = value.conversation?.settlements.find(item => item.submissionId === admitted.body.submissionId);
      while (!settlement && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 50));
        value = await snapshot(id);
        settlement = value.conversation?.settlements.find(item => item.submissionId === admitted.body.submissionId);
      }
      expect(value.failure).toBeUndefined();
      // Only fixed labels leave this controlled fixture; no arbitrary provider or model text is logged.
      const outcomeClass = settlement?.outcome === 'completed' || settlement?.outcome === 'failed'
        ? settlement.outcome : settlement ? 'other' : 'pending';
      const operationClass = settlement?.error?.meta?.operation === `direct(${admitted.body.submissionId})` ? 'direct' : 'unknown';
      const reasonClass = settlement?.error?.meta?.reason?.includes(sentinel) ? 'controlled' : 'unavailable';
      const errorClass = settlement?.error?.type === 'operation_failed' ? 'operation_failed'
        : settlement?.error?.type ? 'other' : 'none';
      const afterToolAttempts = Math.min(8, value.productionCalls.filter(call => call.modelTurn === 'after-tool').length);
      console.info(`[native-flue] ${mode}: outcome=${outcomeClass} error=${errorClass} operation=${operationClass} reason=${reasonClass}${mode === 'stream-fail' ? ` producer=${value.streamPhase} reconcile=${value.reconcileOutcome} error-vs-expiry=${value.streamErrorVsExpiry} interruption-vs-error=${value.interruptionVsError} attempts=${afterToolAttempts}` : ''}`);
      if (mode === 'stream-fail') {
        expect(value.instance, 'The producer and observation must use the same root instance').toBe(rootInstance);
        expect(value.streamPhase, 'The producer must inject the controlled stream error').toBe('error-injected');
        value = await observe(id, state => state.reconcileOutcome === 'settled' || state.reconcileOutcome === 'interrupted', 2_000);
        settlement = value.conversation?.settlements.find(item => item.submissionId === admitted.body.submissionId);
        expect(value.reconcileOutcome, 'An artificial fixture expiry must not decide the stream-failure result').toBe('settled');
        expect(value.streamErrorVsExpiry).toBe('unobserved');
        expect(value.interruptionVsError).toBe('unobserved');
      }
      expect(value.productionCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/v1/dispatcher/inference', modelTurn: 'after-tool' }),
      ]));
      expect(value.productionCalls.filter(call => call.modelTurn === 'after-tool').at(-1)?.status).toBeUndefined();
      if (mode !== 'abort-reject') {
        expect(settlement?.outcome).toBe('failed');
        expect(value.activity.executionStatus).toBe('unknown');
      } else expect(value.activity.executionStatus).not.toBe('waiting');
      if (mode === 'fetch-reject' || mode === 'abort-reject') {
        const diagnosed = await observe(id, receipt => receipt.diagnosticReports.some(item =>
          item.stage === 'fetch-rejected'), 3_000);
        expect(diagnosed.diagnosticReports).toEqual([{ activityId: id, generation: 1, stage: 'fetch-rejected' }]);
        expect(JSON.stringify(diagnosed.diagnosticReports)).not.toContain(sentinel);
      }
      expect(results(value)).toEqual([]);
      expect(value.activity.result).toBeNull();
      expect(value.external).toEqual([]);
    }, 40_000);

    it('carries a cited release receipt through the pinned compiled Dispatcher and parent read bridge', async () => {
      const { id } = await prepare();
      const head = 'b'.repeat(40);
      const evidence = {
        'pull-request': { number: 17, head: { sha: head }, base: { sha: 'a'.repeat(40) },
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' } },
        files: { observedHead: head, truncated: false, data: [{ filename: 'middleware/dozzle/compose.yaml',
          status: 'modified', additions: 1, deletions: 1,
          patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2' }] },
        checks: { observedHead: head, truncated: false, data: { check_runs: [] } },
        'release-notes': { observedHead: head, repository: 'amir20/dozzle', tag: 'v11.1.2',
          source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2', body: 'No migration steps for this release.' },
      };
      const admission = await command<{ status: number; body: { submissionId: string } }>(id,
        { action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 }, productionEvidence: evidence });
      expect(admission.status).toBe(202);
      const value = await settle(id, admission.body.submissionId);
      expect(results(value).at(-1)).toMatchObject({ repository: 'owner/repository', pullRequest: 17,
        readOnly: true, evidence: { upstream: evidence['release-notes'], stale: false, truncated: false } });
      expect(value.productionCalls.filter(call => call.path === '/v1/dispatcher/github/read').map(call => call.resource).sort())
        .toEqual(['pull-request', 'files', 'checks', 'release-notes', 'upstream-guide', 'changed-compose'].sort());
      expect(value.external).toEqual([]);
      expect(value.activity.sessionId).toBeNull();
    });

    it('does not call an omitted Compose patch proof of no upstream change', async () => {
      const { id } = await prepare();
      const head = 'b'.repeat(40);
      const admission = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: {
          'pull-request': { number: 17, head: { sha: head }, base: { sha: 'a'.repeat(40) },
            user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' } },
          files: { observedHead: head, truncated: false, data: [{ filename: 'addons/compose.yaml',
            status: 'modified', additions: 8, deletions: 8 }] },
          checks: { observedHead: head, truncated: false, data: { check_runs: [] } },
          // No release-notes receipt is granted for an uninspectable diff.
        },
      });
      expect(admission.status).toBe(202);
      const value = await settle(id, admission.body.submissionId);
      expect(results(value).at(-1)).toMatchObject({ evidence: { complete: false, releaseUnavailable: true,
        upstream: null } });
      expect(value.productionCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/v1/dispatcher/github/read', resource: 'release-notes', status: 403 }),
      ]));
      expect(value.external).toEqual([]);
    });

    it('keeps a denied parent read attributable without a conflicting model retry', async () => {
      const { id } = await prepare();
      const admitted = await command<{ status: number; body: { submissionId: string } }>(id, {
        action: 'send', delivery: { repository: 'owner/repository', pullRequest: 17 },
        productionEvidence: { files: {}, checks: {} }, // No pull-request evidence: the parent returns 403.
      });
      expect(admitted.status).toBe(202);
      const end = Date.now() + 10_000;
      let value = await snapshot(id);
      let settlement = value.conversation?.settlements.find(item => item.submissionId === admitted.body.submissionId);
      while (!settlement && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 50));
        value = await snapshot(id);
        settlement = value.conversation?.settlements.find(item => item.submissionId === admitted.body.submissionId);
      }
      // Flue can finish a model turn after a failed tool, but denied evidence
      // cannot become an assessment or an inference-identity conflict.
      expect(settlement).toBeDefined();
      expect(value.productionCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/v1/dispatcher/github/read', resource: 'pull-request', status: 403 }),
        expect.objectContaining({ path: '/v1/dispatcher/inference', modelTurn: 'after-tool', status: 200 }),
      ]));
      expect(results(value)).toEqual([]);
      expect(value.external).toEqual([]);
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
      const afterA = await observe(a.id, value => results(value).length > 0);
      const afterB = await observe(b.id, value => results(value).length > 0);
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
      expect(finished.conversation?.settlements).toEqual(expect.arrayContaining([
        expect.objectContaining({ submissionId: submitted, outcome: 'completed' }),
      ]));
      const checkpoint = await observe(id, value => value.activity.executionStatus === 'waiting');
      expect(checkpoint.activity.checkpoint).not.toBeNull();
      await command(id, { action: 'evict' });
      await harness.activity(id, { action: 'evict' });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'running' } });
      const b = delivery(id, { generation: 2, marker: 'segment-b' });
      const next = await send(id, b);
      await settle(id, next);
      const final = await observe(id, value =>
        results(value).at(-1)?.generation === 2
        && value.external?.some(receipt => receipt.operationId === b.operationId && receipt.generation === 2) === true);
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
      expect(recovered.conversation?.settlements).toEqual(expect.arrayContaining([
        expect.objectContaining({ submissionId: submission, outcome: 'completed' }),
      ]));
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
        expect(before.externalAttempts).toHaveLength(1);
        await command(id, { action: 'evict' });
        const after = await observe(id, value => value.activity.executionStatus === 'unknown');
        expect(after.external).toEqual(before.external);
        expect(after.externalAttempts).toHaveLength(2);
        expect(after.externalAttempts[1]).toMatchObject({ operationId: input.operationId,
          requestDigest: input.requestDigest, attempt: 2 });
        expect(after.activity.checkpoint).toBeNull();
        expect(await harness.activity(id, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
        // Metadata observation must not turn a failed/unknown segment into replay.
        expect((await snapshot(id)).external).toEqual(before.external);
      } finally {
        // The assertion intentionally leaves an unresolved external response.
        // First resolve the fixture-owned barrier; abort alone cannot settle a
        // promise deliberately held inside the parent transport. The captured
        // unknown generation remains denied, then the real generated facet can
        // release its fiber before Wrangler teardown.
        await command(id, { action: 'release' });
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
        // Resolve its fixture barrier before aborting the generated facet.
        await command(id, { action: 'release' });
        await command(id, { action: 'abort' });
      }
    });

    it('conflicts changed input under a completed operation ID instead of performing another external read', async () => {
      const { id } = await prepare();
      const input = delivery(id);
      const first = await settle(id, await send(id, input));
      expect(results(first).at(-1)?.result.status).toBe(200);
      await command(id, { action: 'evict' });
      expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2 } });
      const changed = delivery(id, { generation: 2, operationId: input.operationId, marker: 'different-request' });
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

  if (group === 'authority') describe('REQ-OPERATOR-047/048: captured generation native Flue authority', () => {
    beforeEach(() => harness.reset(), 60_000);

    it.each(['stale', 'expiry', 'cancel'] as const)('rejects a warmed %s caller before its protected operation and result commitment', async reason => {
      await positiveControl();
      const { id, intent } = await prepare(reason === 'expiry' ? { deadline: Date.now() + 5_000 } : {});
      try {
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
      } finally {
        await command(id, { action: 'release' });
        await command(id, { action: 'abort' });
      }
    });

    it('rejects reconstruction when the prior generation has no settled-submission checkpoint', async () => {
      const { id } = await prepare();
      try {
        const warm = delivery(id, { mode: 'hold', marker: 'warm-generation-one' });
        await send(id, warm);
        await observe(id, value => value.barrierReached);
        expect(await harness.activity(id, { action: 'commit-drive', generation: 1,
          update: { schemaVersion: 1, status: 'waiting', checkpoint: { fault: 'rollover-before-forgery' } } })).toMatchObject({ ok: true });
        await command(id, { action: 'evict' });
        expect(await harness.activity(id, { action: 'begin-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'running' } });

        const forged = delivery(id, { generation: 2, marker: 'forged-generation-two' });
        const rejected = await command<{ status: number; body: { stage?: string; error?: string } }>(id, { action: 'send', delivery: forged });
        expect(rejected).toMatchObject({ status: 501, body: {
          stage: 'native-facet-admission', error: expect.stringContaining('prior generation is not quiescent'),
        } });
        const after = await snapshot(id);
        expect(after.external).toEqual([]);
        expect(after.externalAttempts).toEqual([]);
      } finally {
        await command(id, { action: 'release' });
      }
    });
  });
}
