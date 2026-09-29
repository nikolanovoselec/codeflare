/**
 * Compatibility milestone only: real pinned SDK root + package-built Flue facet.
 * This is NOT a production Activity replacement. No host adapter is implemented
 * here in RED: dynamic resolution, scheduler delegation and restricted operation
 * admission remain the missing behavior. The upstream transport intentionally
 * accepts effects so blanket denial and absent authority checks cannot pass.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Agent, getAgentByName, type RetryOptions, type Schedule, type ScheduleCriteria } from 'agents';
import type { FixtureActivity } from './loader-worker';
import { parseDispatcherOperation } from '../../../operators/operator-runtime-capability';
import { OperatorDispatcherTail } from '../../../operators/activity';
import { setLogLevel } from '../../../lib/logger';

export type NativeArtifact = {
  schemaVersion: 1; sourceCommit: string;
  versions: { runtime: string; vitePlugin: string; agents: string };
  className: 'FlueDispatcherAgent'; compatibilityDate: string; compatibilityFlags: string[];
  mainModule: string; modules: Record<string, { js: string }>;
};
export type NativeDelivery = {
  activityId: string; generation: number; operationId: string; requestDigest: string;
  marker: string; mode: 'read' | 'hold' | 'receipt-window' | 'unknown' | 'probe';
};
type ProductionEvidence = Partial<Record<'pull-request' | 'files' | 'checks' | 'release-notes' | 'changed-compose', unknown>>;
type ProductionCall = { path: string; resource?: string; status?: number; modelTurn?: 'initial' | 'after-tool' };
export type FlueFixtureCommand =
  | { action: 'configure'; artifact: NativeArtifact; digest: string }
  | { action: 'send'; delivery: NativeDelivery | { repository: string; pullRequest: number };
      productionEvidence?: ProductionEvidence; productionDecision?: unknown;
      productionBehavior?: 'finish-early' | 'persistent-malformed' | 'model-error' | 'model-error-empty' | 'fetch-reject' | 'abort-reject' | 'stream-fail'; holdResearch?: boolean; holdInference?: boolean }
  | { action: 'snapshot' }
  | { action: 'release' }
  | { action: 'evict' }
  | { action: 'abort' }
  | { action: 'tail-probe' }
  | { action: 'tail-probe-empty' }
  | { action: 'tail-probe-awaited' }
  | { action: 'tail-probe-background' }
  | { action: 'tail-probe-silent' }
  | { action: 'facet-tail-probe'; mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber' }
  | { action: 'facet-tail-receipt'; mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber' }
  | { action: 'facet-tail-release-fiber' };

type FacetPath = readonly Readonly<{ className: string; name: string }>[];
type Facet = Fetcher & {
  _cf_initAsFacet(name: string, parentPath: Array<{ className: string; name: string }>, identityName: string): Promise<void>;
  _cf_checkRunFibersForFacet(ownerPath: FacetPath): Promise<number>;
  _cf_dispatchScheduledCallback(ownerPath: FacetPath, row: unknown): Promise<boolean>;
  fixtureSnapshot(): Promise<unknown>;
  fixtureDiagnosticProbeStart?(mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber'): Promise<void>;
  fixtureDiagnosticProbeReceipt?(mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber'): Promise<boolean>;
  fixtureDiagnosticProbeReleaseFiber?(): Promise<{ released: boolean }>;
};
type NativeEnv = Cloudflare.Env & {
  FLUE_ROOT: DurableObjectNamespace<FixtureFlueRoot>;
  TAIL_INBOX: DurableObjectNamespace<FixtureTailInbox>;
  ACTIVITY: DurableObjectNamespace<FixtureActivity>;
  LOADER: { get(id: string, code: () => Promise<unknown>): { getDurableObjectClass(name: string): unknown } };
};
type AgentsFacetRootBridge = Pick<Agent<NativeEnv>,
  '_cf_scheduleForFacet' | '_cf_scheduleEveryForFacet' | '_cf_getScheduleForFacet'
  | '_cf_listSchedulesForFacet' | '_cf_cancelScheduleForFacet' | '_cf_acquireFacetKeepAlive'
  | '_cf_releaseFacetKeepAlive' | '_cf_registerFacetRun' | '_cf_unregisterFacetRun'>;
type FacetBridgeBinding = { generation: number; status: 'current' | 'stale' | 'denied' };
type FixtureFlueRootStub = DurableObjectStub<FixtureFlueRoot>;
export type ExternalReceipt = NativeDelivery & { sequence: number; path: string };
export type ExternalAttempt = NativeDelivery & { attempt: number; path: string };

/** Real SDK owns all physical alarms/fiber machinery. No copied scheduler. */
export class FixtureFlueRoot extends Agent<NativeEnv> {
  private readonly instance = crypto.randomUUID();
  private facet?: Promise<Facet>;
  private releaseBarrier?: () => void;
  private releaseInference?: () => void;
  private readonly researchBarriers = new Map<string, () => void>();

  constructor(ctx: DurableObjectState, env: NativeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const active = await ctx.storage.get<{ submissionId: string; generation: number; expiresAt: number }>('fixture:active-submission');
      if (active) ctx.waitUntil(this.reconcileSubmission(active));
    });
  }

  override async alarm() {
    await this.ctx.storage.put('fixture:alarm-deliveries', (await this.ctx.storage.get<number>('fixture:alarm-deliveries') ?? 0) + 1);
    return super.alarm();
  }

  async configure(artifact: NativeArtifact, digest: string) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== digest || bytes.length > 8 * 1024 * 1024 || Object.keys(artifact.modules).length > 128 ||
      artifact.className !== 'FlueDispatcherAgent' || artifact.versions.runtime !== '2.1.0' || artifact.versions.agents !== '0.20.1') {
      return { ok: false, reason: 'fixture-artifact-rejected' };
    }
    // Keep large generated bytes out of a single DO KV value. Eviction must
    // reload these exact bytes, never a moving file path or package reference.
    const chunkSize = 48 * 1024;
    for (let i = 0; i < bytes.length; i += chunkSize) await this.ctx.storage.put(`fixture:artifact:${i / chunkSize}`, bytes.slice(i, i + chunkSize));
    await this.ctx.storage.put({ 'fixture:artifact-chunks': Math.ceil(bytes.length / chunkSize), 'fixture:digest': digest });
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_parent_secret (secret TEXT)');
    this.ctx.storage.sql.exec("INSERT INTO fixture_parent_secret VALUES ('parent-only-sentinel')");
    return { ok: true, digest, sourceCommit: artifact.sourceCommit };
  }

  private async artifact(): Promise<NativeArtifact> {
    const count = await this.ctx.storage.get<number>('fixture:artifact-chunks');
    if (!count) throw new Error('Pinned native artifact not configured');
    const decoder = new TextDecoder();
    let json = '';
    for (let i = 0; i < count; i++) json += decoder.decode(await this.ctx.storage.get<Uint8Array>(`fixture:artifact:${i}`), { stream: true });
    return JSON.parse(json + decoder.decode());
  }

  private child(): Promise<Facet> {
    return this.facet ??= (async () => {
      const artifact = await this.artifact();
      const digest = await this.ctx.storage.get<string>('fixture:digest');
      // Rehydrate the exact persisted facet generation for read-only state
      // observation even after that generation reached `waiting`. The bound
      // transport still checks live `running` authority before every effect.
      const binding = await this.activityBinding();
      if (!binding || binding.deadline <= Date.now()) throw new Error('Native facet bridge identity is unavailable');
      if (binding.generation > 1) {
        const settled = await this.ctx.storage.get<{ generation: number; submissionId: string }>('fixture:settled-submission');
        if (!settled || settled.generation !== binding.generation - 1) {
          throw new Error('Native facet prior generation is not quiescent');
        }
      }
      const { exports } = this.ctx as unknown as { exports: {
        FixtureFlueTransport(options: { props: { activityId: string; generation: number } }): Fetcher;
        FixtureTailProbe(options: { props: { activityId: string; generation: number } }): unknown;
      } };
      // A continuation generation receives a newly bound dynamic class while
      // retaining the same activity-private facet identity/SQLite. Reusing the
      // old Loader key would retain generation one's RPC props and make a valid
      // generation-two continuation indistinguishable from a stale warm caller.
      // Only controlled adapter-failure cases need a test Tail sink. Other
      // lifecycle fixtures must not create a second RPC back into this owner.
      const probe = await this.ctx.storage.get<boolean>('fixture:facet-tail-probe') ?? false;
      const tailEnabled = probe || await this.ctx.storage.get<boolean>('fixture:tail-enabled');
      // A synthetic wrapper adds test callbacks without changing any pinned module
      // or serving as approved-artifact acceptance. The original cases never load it.
      const probeModule = 'fixture-tail-schedule.js';
      const probeSource = `import { FlueDispatcherAgent as Pinned } from './index.js';
export class FlueDispatcherAgent extends Pinned {
  async fixtureDiagnosticProbeStart(mode) {
    if (mode === 'direct') {
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
      await this.ctx.storage.put('fixture:probe:direct', true);
      return;
    }
    await this.schedule(0, 'fixtureDiagnosticProbeWake', mode, { idempotent: false });
  }
  async fixtureDiagnosticProbeWake(mode) {
    if (mode === 'scheduled') {
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
      await this.ctx.storage.put('fixture:probe:scheduled', true);
      return;
    }
    this._fixtureFiberReady = new Promise(resolve => { this._fixtureFiberReadyResolve = resolve; });
    const running = this.runFiber('fixture-tail-fiber', async () => {
      await new Promise(resolve => {
        this._fixtureFiberRelease = resolve;
        this._fixtureFiberReadyResolve();
      });
      if (mode === 'rpc-fiber') {
        const response = await this.env.OPERATOR.fetch(new Request('https://operator.internal/fixture/inference', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: { messages: [] } }),
        }));
        if (!response.ok) throw new Error('Synthetic inference bridge unavailable');
      }
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
      await this.ctx.storage.put('fixture:probe:' + mode, true);
    });
    this.ctx.waitUntil(running);
  }
  async fixtureDiagnosticProbeReleaseFiber() {
    await this._fixtureFiberReady;
    this._fixtureFiberRelease();
    return { released: true };
  }
  async fixtureDiagnosticProbeReceipt(mode) {
    return await this.ctx.storage.get('fixture:probe:' + mode) === true;
  }
}`;
      if (probe && artifact.mainModule !== 'index.js') throw new Error('Pinned probe main module unavailable');
      const worker = this.env.LOADER.get(`fixture:${this.name}:${digest}:${binding.generation}${probe ? ':tail-probe' : ''}`, async () => ({
        compatibilityDate: artifact.compatibilityDate, compatibilityFlags: artifact.compatibilityFlags,
        mainModule: probe ? probeModule : artifact.mainModule,
        modules: probe ? { ...artifact.modules, [probeModule]: { js: probeSource } } : artifact.modules,
        // The facet receives only this direct, activity-private RPC target.
        // Its generation is captured here from the owner, never from delivery.
        env: { OPERATOR: exports.FixtureFlueTransport({ props: { activityId: this.name, generation: binding.generation } }) },
        globalOutbound: null,
        ...(tailEnabled ? { tails: [exports.FixtureTailProbe({ props: {
          activityId: this.name, generation: binding.generation,
        } })] } : {}),
      }));
      const { facets } = this.ctx as unknown as { facets: { get(name: string, init: () => unknown): Facet } };
      const child = facets.get('dispatcher', () => ({
        class: worker.getDurableObjectClass(artifact.className), id: this.env.FLUE_ROOT.idFromName('dispatcher'),
      }));
      // Pinned SDK bootstrap; the generated profile child supplies the exact
      // private root override before this handshake.
      await child._cf_initAsFacet('dispatcher', [{ className: 'FixtureFlueRoot', name: this.name }], 'dispatcher');
      return child;
    })();
  }

  private activityBinding() {
    return this.env.ACTIVITY.getByName(this.name).facetBridgeBinding();
  }

  /** The owner is the sole source for the generation captured by a new facet. */
  async facetBridgeBinding(generation?: number): Promise<FacetBridgeBinding> {
    const current = await this.activityBinding();
    if (!current || current.deadline <= Date.now() || current.status !== 'running') {
      return { generation: current?.generation ?? 0, status: 'denied' };
    }
    return { generation: current.generation,
      status: generation === undefined || generation === current.generation ? 'current' : 'stale' };
  }

  async send(delivery: NativeDelivery | { repository: string; pullRequest: number }, productionEvidence?: ProductionEvidence,
    productionDecision?: unknown, productionBehavior?: 'finish-early' | 'persistent-malformed' | 'model-error' | 'model-error-empty' | 'fetch-reject' | 'abort-reject' | 'stream-fail', holdResearch?: boolean,
    holdInference?: boolean) {
    try {
      if (!('mode' in delivery) && productionEvidence) {
        await this.ctx.storage.put('fixture:production-evidence', productionEvidence);
        await this.ctx.storage.put('fixture:production-decision', productionDecision ?? null);
        await this.ctx.storage.put('fixture:production-behavior', productionBehavior ?? null);
        await this.ctx.storage.put('fixture:tail-enabled',
          productionBehavior === 'model-error' || productionBehavior === 'model-error-empty' || productionBehavior === 'fetch-reject'
            || productionBehavior === 'abort-reject');
        await this.ctx.storage.put('fixture:hold-research', holdResearch ?? false);
        await this.ctx.storage.put('fixture:hold-inference', holdInference ?? false);
      }
      const path = 'mode' in delivery ? '/dispatcher' : '/agents/Dispatcher/dispatcher';
      const response = await (await this.child()).fetch(new Request(`https://flue.internal${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'user', body: JSON.stringify(delivery) }),
      }));
      const body = await response.json() as { submissionId?: string };
      if (response.status === 202 && typeof body.submissionId === 'string') {
        const binding = await this.facetBridgeBinding();
        if (binding.status === 'current') {
          const authority = await this.activityBinding();
          if (!authority || authority.deadline <= Date.now()) throw new Error('Fixture authority expired');
          const active = { submissionId: body.submissionId, generation: binding.generation,
            expiresAt: holdInference ? Math.min(authority.deadline, Date.now() + 45_000) : Date.now() + 5_000 };
          await this.ctx.storage.put('fixture:active-submission', active);
          this.ctx.waitUntil(this.reconcileSubmission(active));
        }
      }
      return { status: response.status, body };
    } catch (error) {
      return { status: 501, body: { stage: 'native-facet-admission', error: String(error) } };
    }
  }

  private async reconcileSubmission(active: { submissionId: string; generation: number; expiresAt: number }): Promise<void> {
    while (Date.now() < active.expiresAt) {
      const current = await this.ctx.storage.get<typeof active>('fixture:active-submission');
      if (!current || current.submissionId !== active.submissionId || current.generation !== active.generation) return;
      const path = await this.ctx.storage.get('fixture:production-evidence')
        ? '/agents/Dispatcher/dispatcher' : '/dispatcher';
      const response = await (await this.child()).fetch(new Request(`https://flue.internal${path}`));
      const conversation = await response.json() as { settlements?: Array<{ submissionId?: string; outcome?: string }>;
        messages?: Array<{ submissionId?: string; parts?: Array<{ type?: string }> }> };
      const settlement = conversation.settlements?.find(item => item.submissionId === active.submissionId);
      if (settlement) {
        const activity = this.env.ACTIVITY.getByName(this.name);
        const assessments = conversation.messages?.flatMap(message => message.submissionId === active.submissionId
          ? (message.parts ?? []).filter(part => part.type === 'data-assessment') : []) ?? [];
        if (settlement.outcome === 'completed' && assessments.length === 1) {
          const committed = await activity.commitDrive(active.generation, { schemaVersion: 1, status: 'waiting',
            checkpoint: { submissionId: active.submissionId } });
          if (committed.ok) await this.ctx.storage.put('fixture:settled-submission', {
            generation: active.generation, submissionId: active.submissionId,
          });
        } else {
          await activity.interruptDrive(active.generation);
        }
        await this.ctx.storage.delete('fixture:active-submission');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await this.env.ACTIVITY.getByName(this.name).interruptDrive(active.generation);
    await this.ctx.storage.delete('fixture:active-submission');
  }

  async tailProbe(mode: 'valid' | 'empty' | 'awaited' | 'background' | 'silent' = 'valid') {
    const { exports } = this.ctx as unknown as { exports: { FixtureTailProbe(options: {
      props: { activityId: string; generation: number },
    }): unknown } };
    const source = mode === 'silent' ? `export default { fetch() { return new Response('ok'); } }`
      : mode === 'empty' ? `export default { fetch() {
      console.warn('PRIVATE_PROVIDER_BODY_SENTINEL', { ignored: true });
      return new Response('ok');
    } }` : mode === 'awaited' ? `export default { fetch() {
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
      throw new Error('controlled rejection');
    } }` : mode === 'background' ? `export default { fetch(_request, _env, ctx) {
      ctx.waitUntil(Promise.resolve().then(() => {
        console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
        throw new Error('controlled rejection');
      }));
      return new Response('ok');
    } }` : `export default { fetch() {
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected' });
      console.warn('Dispatcher inference boundary', { stage: 'http-rejected', status: 422 });
      console.warn('Dispatcher inference boundary', { stage: 'fetch-rejected', reason: 'PRIVATE_PROVIDER_BODY_SENTINEL' });
      console.warn('PRIVATE_PROVIDER_BODY_SENTINEL');
      console.error('PRIVATE_PROVIDER_BODY_SENTINEL');
      return new Response('ok');
    } }`;
    const worker = this.env.LOADER.get(`tail-probe:${this.name}:${mode}`, async () => ({
      compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
      mainModule: 'probe.js', modules: { 'probe.js': { js: source } },
      env: {}, globalOutbound: null,
      tails: [exports.FixtureTailProbe({ props: { activityId: this.name, generation: 1 } })],
    })) as unknown as { getEntrypoint(): Fetcher };
    try {
      const response = await worker.getEntrypoint().fetch(new Request('https://probe.internal/'));
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (mode === 'awaited' && error instanceof Error
        && (error.message === 'controlled rejection' || error.message === 'Error: controlled rejection')) {
        return { status: 599, body: 'rejected' };
      }
      throw error;
    }
  }

  async snapshot() {
    let conversation: unknown = null;
    let facet: unknown = null;
    let failure: string | undefined;
    try {
      const child = await this.child();
      const path = await this.ctx.storage.get('fixture:production-evidence')
        ? '/agents/Dispatcher/dispatcher' : '/dispatcher';
      const response = await child.fetch(new Request(`https://flue.internal${path}`));
      conversation = await response.json();
      facet = await child.fixtureSnapshot();
    } catch (error) { failure = String(error); }
    return {
      instance: this.instance, conversation, facet, failure,
      alarmDeliveries: await this.ctx.storage.get<number>('fixture:alarm-deliveries') ?? 0,
      barrierReached: await this.ctx.storage.get<boolean>('fixture:barrier-reached') ?? false,
      external: await this.ctx.storage.get<ExternalReceipt[]>('fixture:external') ?? [],
      externalAttempts: await this.ctx.storage.get<ExternalAttempt[]>('fixture:external-attempts') ?? [],
      productionCalls: await this.ctx.storage.get<ProductionCall[]>('fixture:production-calls') ?? [],
      tailProbe: await this.env.TAIL_INBOX.getByName(this.name).snapshot(),
      activity: await this.env.ACTIVITY.getByName(this.name).getBrowserDetail(),
      digest: await this.ctx.storage.get('fixture:digest'),
    };
  }

  async facetTailProbe(mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber') {
    if (this.facet) throw new Error('Synthetic probe must precede facet creation');
    await this.ctx.storage.put('fixture:facet-tail-probe', true);
    const child = await this.child();
    if (!child.fixtureDiagnosticProbeStart) throw new Error('Synthetic facet probe unavailable');
    await child.fixtureDiagnosticProbeStart(mode);
    return { started: true };
  }

  async facetTailReceipt(mode: 'direct' | 'scheduled' | 'fiber' | 'rpc-fiber') {
    const child = await this.child();
    if (!child.fixtureDiagnosticProbeReceipt) throw new Error('Synthetic facet receipt unavailable');
    return { completed: await child.fixtureDiagnosticProbeReceipt(mode),
      ...((mode === 'fiber' || mode === 'rpc-fiber')
        ? { callbackReturned: await this.ctx.storage.get<boolean>('fixture:probe:callback-returned') === true } : {}) };
  }

  async facetTailReleaseFiber() {
    const child = await this.child();
    if (!child.fixtureDiagnosticProbeReleaseFiber) throw new Error('Synthetic fiber release unavailable');
    return child.fixtureDiagnosticProbeReleaseFiber();
  }

  async release() {
    await this.ctx.storage.put('fixture:released', true);
    this.releaseBarrier?.();
    this.releaseInference?.();
    for (const resource of ['release-notes', 'upstream-guide', 'changed-compose']) {
      this.researchBarriers.get(resource)?.();
    }
    return { released: true };
  }
  evict() { this.ctx.abort('Native Flue fixture root and facet eviction'); }
  async abort() {
    const response = await (await this.child()).fetch(new Request('https://flue.internal/dispatcher/abort', { method: 'POST' }));
    return { status: response.status, body: await response.json() };
  }

  /** Synthetic upstream, deliberately NOT the missing parent authority bridge. */
  async transport(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/inference' || path === '/v1/dispatcher/inference') {
      const body = await request.clone().json() as { input: { messages?: Array<{ role: string }> } };
      const done = body.input.messages?.at(-1)?.role === 'tool';
      let priorInferences = 0;
      if (path === '/v1/dispatcher/inference') {
        // The exact pinned model adapter must speak the real parent's restricted wire contract.
        let operation: Awaited<ReturnType<typeof parseDispatcherOperation>>;
        try { operation = await parseDispatcherOperation(request.clone()); }
        catch { return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 }); }
        // The parent ledger permits an identical retry but rejects a different
        // model turn under the same durable operation ID before any upstream I/O.
        const digests = await this.ctx.storage.get<Record<string, string>>('fixture:inference-operations') ?? {};
        const requestDigest = JSON.stringify({ path: operation.path, body: operation.body });
        if (Object.hasOwn(digests, operation.operationId) && digests[operation.operationId] !== requestDigest) {
          return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
        }
        if (!Object.hasOwn(digests, operation.operationId)) {
          await this.ctx.storage.put('fixture:inference-operations', { ...digests, [operation.operationId]: requestDigest });
        }
        const calls = await this.ctx.storage.get<ProductionCall[]>('fixture:production-calls') ?? [];
        priorInferences = calls.filter(call => call.path === '/v1/dispatcher/inference').length;
        const behavior = await this.ctx.storage.get<string>('fixture:production-behavior');
        calls.push({ path, status: done && (behavior === 'model-error' || behavior === 'model-error-empty') ? 422
          : done && ['fetch-reject', 'abort-reject', 'stream-fail'].includes(behavior ?? '') ? undefined : 200,
          modelTurn: done ? 'after-tool' : 'initial' });
        await this.ctx.storage.put('fixture:production-calls', calls);
        if (done && await this.ctx.storage.get('fixture:hold-inference')) {
          await this.ctx.storage.put('fixture:barrier-reached', true);
          if (!await this.ctx.storage.get('fixture:released')) await new Promise<void>(resolve => {
            this.releaseInference = resolve;
          });
        }
      }
      // Deterministic two-turn model: research, then a model-proposed judgment.
      // The child must validate this untrusted judgment against the parent receipts.
      const evidence = path === '/v1/dispatcher/inference'
        ? await this.ctx.storage.get<ProductionEvidence>('fixture:production-evidence') : null;
      const denied = !evidence || !Object.hasOwn(evidence, 'pull-request');
      const behavior = path === '/v1/dispatcher/inference'
        ? await this.ctx.storage.get<string>('fixture:production-behavior') : null;
      if (done && behavior === 'model-error') return Response.json({ error: 'fixture model rejected' }, { status: 422 });
      if (done && behavior === 'model-error-empty') return new Response(null, {
        status: 422, headers: { 'content-type': 'application/json' },
      });
      if (done && behavior === 'fetch-reject') throw new Error('Controlled inference fetch rejected');
      if (done && behavior === 'abort-reject') throw new DOMException('Controlled inference fetch aborted', 'AbortError');
      if (done && behavior === 'stream-fail') {
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
            } else controller.error(new Error('Controlled inference stream failed'));
          },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const candidate = path === '/v1/dispatcher/inference' && done
        && (priorInferences < 2 || behavior === 'persistent-malformed')
        ? await this.ctx.storage.get<unknown>('fixture:production-decision') : null;
      const tool = done ? 'submit_assessment' : 'assess_renovate';
      const args = done ? JSON.stringify(candidate ?? { classification: 'unknown',
        reasons: ['No confirmed server-agent compatibility evidence'],
        compatibility: 'No verified server-agent compatibility statement is available.',
        citations: [], gaps: ['compatibility-unverified'] }) : '{}';
      const chunks = done && (denied || behavior === 'finish-early')
        ? [{ choices: [{ index: 0, delta: { content: 'Assessment incomplete' }, finish_reason: 'stop' }] }] : [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `fixture-tool-${crypto.randomUUID()}`, type: 'function',
          function: { name: tool, arguments: args } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (path !== '/fixture/barrier' && path !== '/v1/dispatcher/github/read') {
      return Response.json({ error: 'Dispatcher capability denied' }, { status: 403 });
    }
    const payload = await request.json() as NativeDelivery & { resource?: string };
    if (path === '/fixture/barrier') {
      await this.ctx.storage.put('fixture:barrier-reached', true);
      if (!await this.ctx.storage.get('fixture:released')) await new Promise<void>(resolve => { this.releaseBarrier = resolve; });
      return Response.json({ released: true });
    }
    if (typeof payload.resource === 'string') {
      const evidence = await this.ctx.storage.get<ProductionEvidence>('fixture:production-evidence');
      const allowed = !!evidence && Object.hasOwn(evidence, payload.resource);
      const calls = await this.ctx.storage.get<ProductionCall[]>('fixture:production-calls') ?? [];
      calls.push({ path, resource: payload.resource, status: allowed ? 200 : 403 });
      await this.ctx.storage.put('fixture:production-calls', calls);
      if (!allowed) return Response.json({ error: 'Unapproved production read' }, { status: 403 });
      if (await this.ctx.storage.get('fixture:hold-research')
        && ['release-notes', 'upstream-guide', 'changed-compose'].includes(payload.resource)) {
        const resource = payload.resource;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        this.researchBarriers.set(resource, release);
        try {
          await this.ctx.storage.transaction(async storage => {
            const entered = await storage.get<string[]>('fixture:research-entered') ?? [];
            const distinct = [...new Set([...entered, resource])];
            await storage.put('fixture:research-entered', distinct);
            if (distinct.length === 3) await storage.put('fixture:barrier-reached', true);
          });
          if (await this.ctx.storage.get('fixture:released')) release();
          await waiting;
        } finally {
          this.researchBarriers.delete(resource);
        }
      }
      return Response.json(evidence[payload.resource as keyof ProductionEvidence]);
    }
    const delivery = payload as NativeDelivery;
    const external = await this.ctx.storage.get<ExternalReceipt[]>('fixture:external') ?? [];
    const attempts = await this.ctx.storage.get<ExternalAttempt[]>('fixture:external-attempts') ?? [];
    attempts.push({ ...delivery, path, attempt: attempts.length + 1 });
    await this.ctx.storage.put('fixture:external-attempts', attempts);
    const prior = external.find(receipt => receipt.operationId === delivery.operationId);
    if (prior) {
      if (prior.requestDigest !== delivery.requestDigest) {
        return Response.json({ accepted: false, conflict: 'operation-input-mismatch' }, { status: 409 });
      }
      if (await this.ctx.storage.get(`fixture:uncertain:${delivery.operationId}`)) {
        return Response.json({ accepted: false, unknown: true }, { status: 409 });
      }
      return Response.json({ accepted: true, receipt: prior,
        evidence: { repositoryId: 123, botId: 29139614, head: 'a'.repeat(40), checks: ['success'] } });
    }
    const receipt = { ...delivery, path, sequence: external.length + 1 };
    external.push(receipt);
    await this.ctx.storage.put('fixture:external', external);
    if (delivery.mode === 'unknown') {
      await this.ctx.storage.put(`fixture:uncertain:${delivery.operationId}`, true);
      await this.ctx.storage.put('fixture:barrier-reached', true);
      // Accepted externally, response deliberately lost. Recovery must not
      // replay this ledger entry just because ToolStep did not record it.
      await new Promise<void>(resolve => { this.releaseBarrier = resolve; });
      throw new Error('Fixture lost external response');
    }
    return Response.json({ accepted: true, receipt, evidence: { repositoryId: 123, botId: 29139614, head: 'a'.repeat(40), checks: ['success'] } });
  }

  #path(path: FacetPath): void {
    if (!Array.isArray(path) || path.length < 2) throw new Error('Invalid facet bridge path');
    for (const segment of path) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)
        || Object.keys(segment).length !== 2 || typeof segment.className !== 'string'
        || !segment.className || typeof segment.name !== 'string' || !segment.name || segment.name.includes('\0')) {
        throw new Error('Invalid facet bridge path');
      }
    }
    const [root, child] = path;
    if (root.className !== 'FixtureFlueRoot' || root.name !== this.name
      || child.className !== 'FlueDispatcherAgent' || child.name !== 'dispatcher') {
      throw new Error('Unauthorized facet bridge path');
    }
  }

  #agentsRoot(): AgentsFacetRootBridge {
    return Agent.prototype as unknown as AgentsFacetRootBridge;
  }

  override _cf_scheduleForFacet<T = string>(
    ownerPath: FacetPath, when: Date | string | number, callback: string, payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean },
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    this.#path(ownerPath);
    return (this.#agentsRoot()._cf_scheduleForFacet<T>).call(this, ownerPath, when, callback, payload, options);
  }
  override _cf_scheduleEveryForFacet<T = string>(
    ownerPath: FacetPath, intervalSeconds: number, callback: string, payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean },
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    this.#path(ownerPath);
    return (this.#agentsRoot()._cf_scheduleEveryForFacet<T>).call(this, ownerPath, intervalSeconds, callback, payload, options);
  }
  override _cf_getScheduleForFacet(ownerPath: FacetPath, id: string): Promise<Schedule<unknown> | undefined> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_getScheduleForFacet.call(this, ownerPath, id);
  }
  override _cf_listSchedulesForFacet(ownerPath: FacetPath, criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_listSchedulesForFacet.call(this, ownerPath, criteria);
  }
  override _cf_cancelScheduleForFacet(ownerPath: FacetPath, id: string): Promise<{ ok: boolean; callback?: string }> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_cancelScheduleForFacet.call(this, ownerPath, id);
  }
  override _cf_acquireFacetKeepAlive(ownerPath: FacetPath): Promise<string> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_acquireFacetKeepAlive.call(this, ownerPath);
  }
  override _cf_releaseFacetKeepAlive(token: string): Promise<void> {
    return this.#agentsRoot()._cf_releaseFacetKeepAlive.call(this, token);
  }
  override _cf_registerFacetRun(ownerPath: FacetPath, runId: string): Promise<void> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_registerFacetRun.call(this, ownerPath, runId);
  }
  override _cf_unregisterFacetRun(ownerPath: FacetPath, runId: string): Promise<void> {
    this.#path(ownerPath);
    return this.#agentsRoot()._cf_unregisterFacetRun.call(this, ownerPath, runId);
  }

  // The generated class is loaded dynamically, so it cannot appear in this
  // Worker's static ctx.exports registry. Route only the two root-alarm RPCs
  // that Agents uses to wake and recover this exact activity-private facet.
  override async _cf_dispatchScheduledCallback(ownerPath: FacetPath, row: unknown): Promise<boolean> {
    this.#path(ownerPath);
    const executed = await (await this.child())._cf_dispatchScheduledCallback(ownerPath, row);
    if (executed && await this.ctx.storage.get<boolean>('fixture:facet-tail-probe')
      && (row as { callback?: unknown })?.callback === 'fixtureDiagnosticProbeWake') {
      await this.ctx.storage.put('fixture:probe:callback-returned', true);
    }
    return executed;
  }
  override async _cf_checkRunFibersForFacet(ownerPath: FacetPath): Promise<number> {
    this.#path(ownerPath);
    return (await this.child())._cf_checkRunFibersForFacet(ownerPath);
  }
}

// Counts Tail invocations observed by this passive test sink, including empty deliveries.
type TailProbeSummary = { deliveries: number; accepted: number; markerObject: number; markerString: number;
  unmarkedStringObject: number; unmarkedTwoStrings: number; otherLogs: number };

// Passive test-only store: Tail observation cannot reconstruct the Flue execution owner.
export class FixtureTailInbox extends DurableObject<NativeEnv> {
  async record(activityId: string, generation: number, diagnostics: unknown[], summary: TailProbeSummary) {
    await this.ctx.storage.transaction(async storage => {
      const prior = await storage.get<{ generation: number; diagnostics: unknown[]; summary: TailProbeSummary }>('fixture:tail-probe');
      const current = prior?.generation === generation ? prior : null;
      const fields: Array<keyof TailProbeSummary> = ['deliveries', 'accepted', 'markerObject', 'markerString',
        'unmarkedStringObject', 'unmarkedTwoStrings', 'otherLogs'];
      const accumulated = {} as TailProbeSummary;
      for (const field of fields) accumulated[field] = Math.min(255, (current?.summary?.[field] ?? 0) + summary[field]);
      await storage.put('fixture:tail-probe', { activityId, generation,
        diagnostics: [...(current?.diagnostics ?? []), ...diagnostics].slice(0, 8), summary: accumulated });
    });
  }

  async snapshot() { return await this.ctx.storage.get('fixture:tail-probe') ?? null; }
}

export class FixtureTailProbe extends WorkerEntrypoint<NativeEnv> {
  async tail(events: unknown) {
    const { activityId, generation } = this.ctx.props as { activityId: string; generation: number };
    const summary: TailProbeSummary = { deliveries: 1, accepted: 0, markerObject: 0, markerString: 0,
      unmarkedStringObject: 0, unmarkedTwoStrings: 0, otherLogs: 0 };
    if (Array.isArray(events)) {
      let inspected = 0;
      for (const event of events.slice(0, 64)) {
        if (!Array.isArray(event?.logs)) continue;
        for (const log of event.logs) {
          if (++inspected > 128) break;
          const parts: unknown[] = Array.isArray(log?.message) ? log.message : [];
          if (log?.level !== 'warn' || parts.length !== 2) { summary.otherLogs++; continue; }
          if (parts[0] === 'Dispatcher inference boundary') {
            if (parts[1] && typeof parts[1] === 'object' && !Array.isArray(parts[1])) summary.markerObject++;
            else if (typeof parts[1] === 'string') summary.markerString++;
            else summary.otherLogs++;
          } else if (typeof parts[0] === 'string' && parts[1] && typeof parts[1] === 'object') {
            summary.unmarkedStringObject++;
          } else if (typeof parts[0] === 'string' && typeof parts[1] === 'string') {
            summary.unmarkedTwoStrings++;
          } else summary.otherLogs++;
        }
      }
    }
    const captured: unknown[] = [];
    const original = console.warn;
    setLogLevel('warn');
    console.warn = (value: unknown) => { if (captured.length < 8) captured.push(value); };
    let completion!: Promise<void>;
    try {
      const tail = new OperatorDispatcherTail(this.ctx, this.env as unknown as ConstructorParameters<typeof OperatorDispatcherTail>[1]);
      completion = tail.tail(events);
    } finally { console.warn = original; setLogLevel('info'); }
    await completion;
    const diagnostics = captured.flatMap(value => {
      try {
        const entry = typeof value === 'string' ? JSON.parse(value) as {
          module?: unknown; message?: unknown; data?: unknown,
        } : null;
        return entry?.module === 'dispatcher-inference-tail' && entry.message === 'Dispatcher child inference diagnostic'
          && entry.data && typeof entry.data === 'object' ? [entry.data] : [];
      } catch { return []; }
    });
    summary.accepted = diagnostics.length;
    await this.env.TAIL_INBOX.getByName(activityId).record(activityId, generation, diagnostics, summary);
  }
}

export class FixtureFlueTransport extends WorkerEntrypoint<NativeEnv> {
  #root(): Promise<FixtureFlueRootStub> {
    const { activityId } = this.ctx.props as { activityId: string; generation: number };
    return getAgentByName(this.env.FLUE_ROOT, activityId);
  }

  async #current(): Promise<FacetBridgeBinding> {
    const { generation } = this.ctx.props as { activityId: string; generation: number };
    return (await this.#root()).facetBridgeBinding(generation);
  }

  async #bridge<T>(call: (root: FixtureFlueRootStub) => Promise<T>): Promise<T> {
    const binding = await this.#current();
    if (binding.status !== 'current') throw new Error(`Facet bridge generation ${binding.status}`);
    return call(await this.#root());
  }

  async fetch(request: Request) {
    const binding = await this.#current();
    if (binding.status !== 'current') {
      return Response.json({ error: 'Facet bridge generation rejected' }, { status: binding.status === 'stale' ? 409 : 403 });
    }
    return (await this.#root()).transport(request);
  }

  async _cf_scheduleForFacet<T = string>(
    ownerPath: FacetPath, when: Date | string | number, callback: string, payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean },
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#bridge(root => root._cf_scheduleForFacet(ownerPath, when, callback, payload, options));
  }
  async _cf_scheduleEveryForFacet<T = string>(
    ownerPath: FacetPath, intervalSeconds: number, callback: string, payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean },
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#bridge(root => root._cf_scheduleEveryForFacet(ownerPath, intervalSeconds, callback, payload, options));
  }
  async _cf_getScheduleForFacet(ownerPath: FacetPath, id: string): Promise<Schedule<unknown> | undefined> {
    return this.#bridge(root => root._cf_getScheduleForFacet(ownerPath, id));
  }
  async _cf_listSchedulesForFacet(ownerPath: FacetPath, criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]> {
    return this.#bridge(root => root._cf_listSchedulesForFacet(ownerPath, criteria));
  }
  async _cf_cancelScheduleForFacet(ownerPath: FacetPath, id: string): Promise<{ ok: boolean; callback?: string }> {
    return this.#bridge(root => root._cf_cancelScheduleForFacet(ownerPath, id));
  }
  async _cf_acquireFacetKeepAlive(ownerPath: FacetPath): Promise<string> {
    return this.#bridge(root => root._cf_acquireFacetKeepAlive(ownerPath));
  }
  async _cf_releaseFacetKeepAlive(token: string): Promise<void> {
    return this.#bridge(root => root._cf_releaseFacetKeepAlive(token));
  }
  async _cf_registerFacetRun(ownerPath: FacetPath, runId: string): Promise<void> {
    return this.#bridge(root => root._cf_registerFacetRun(ownerPath, runId));
  }
  async _cf_unregisterFacetRun(ownerPath: FacetPath, runId: string): Promise<void> {
    return this.#bridge(root => root._cf_unregisterFacetRun(ownerPath, runId));
  }
}

export async function flueFixture(request: Request, env: NativeEnv) {
  const id = new URL(request.url).searchParams.get('activity')!;
  const root = await getAgentByName(env.FLUE_ROOT, id);
  const command = await request.json<FlueFixtureCommand>();
  switch (command.action) {
    case 'configure': return Response.json(await root.configure(command.artifact, command.digest));
    case 'send': return Response.json(await root.send(command.delivery, command.productionEvidence,
      command.productionDecision, command.productionBehavior, command.holdResearch, command.holdInference));
    case 'snapshot': return Response.json(await root.snapshot());
    case 'release': return Response.json(await root.release());
    case 'abort': return Response.json(await root.abort());
    case 'tail-probe': return Response.json(await root.tailProbe());
    case 'tail-probe-empty': return Response.json(await root.tailProbe('empty'));
    case 'tail-probe-awaited': return Response.json(await root.tailProbe('awaited'));
    case 'tail-probe-background': return Response.json(await root.tailProbe('background'));
    case 'tail-probe-silent': return Response.json(await root.tailProbe('silent'));
    case 'facet-tail-probe': return Response.json(await root.facetTailProbe(command.mode));
    case 'facet-tail-receipt': return Response.json(await root.facetTailReceipt(command.mode));
    case 'facet-tail-release-fiber': return Response.json(await root.facetTailReleaseFiber());
    case 'evict':
      await root.evict().catch(() => {});
      return Response.json({ evicted: true });
  }
}
