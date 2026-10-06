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
import { parseDispatcherOperation, readDispatcherBody } from '../../../operators/operator-runtime-capability';
import { OperatorDispatcherTail } from '../../../operators/activity';
import { setLogLevel } from '../../../lib/logger';
import { readDispatcherUpdates, type DispatcherResultProjection } from '../../../operators/dispatcher-result';

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
export type NativeJourneyDiagnostic = {
  historyStatus: number;
  outcome: string;
  errorType: string;
  operation: 'none' | 'direct' | 'unknown';
  reason: string;
  firstFailedTool: string | null;
  tools: Array<{ tool: string; state: string; reason: string }>;
};
export type NativeJourneyScenario = 'ordinary' | 'overflow-once' | 'transient-interruption-once' | 'finish-undiscovered' | 'seal-undiscovered';
type NativeInferenceWire = {
  admission: 'accepted' | 'rejected'; stage: 'normal' | 'summary';
  tokenField: 'absent' | 'canonical' | 'completion-alias' | 'dual' | 'other';
  outputBudget: number | null; messages: number; tools: number;
};
export type NativeJourneyObservation = {
  wire: NativeInferenceWire[];
  effects: { commentRequests: number; otherMutationRequests: number; commentMatches: boolean; researchSourceRequests: number };
  sessionId: string | null;
  interruptionObserved: boolean;
  retryIdentityMatched: boolean;
};
export type FlueFixtureCommand =
  | { action: 'configure'; artifact: NativeArtifact; digest: string; journey?: boolean; readonly oversizedSourceMetadata?: boolean; readonly researchBodyBytes?: 131072 | 262144 | 1044480;
      readonly admittedTarget?: string; readonly journeyFacts?: { createdAt: string; unrelatedCreatedAt: string };
      readonly journeyScenario?: NativeJourneyScenario; readonly admittedInferenceBytes?: 1048576 }
  | { action: 'journey-observation' }
  | { action: 'journey-comment-request' }
  | { action: 'journey-updates'; submissionId: string; previous: DispatcherResultProjection }
  | { action: 'journey-diagnostic'; submissionId: string }
  | { action: 'send'; delivery: NativeDelivery | { repository: string; pullRequest?: number };
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
  fixtureDiagnosticProbeWarningReceipt?(): Promise<boolean>;
  fixtureDiagnosticProbeReleaseFiber?(): Promise<{ released: boolean }>;
};
type NativeEnv = Omit<Cloudflare.Env, 'ACTIVITY'> & {
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
  private streamPhase: 'not-pulled' | 'prefix-enqueued' | 'error-injected' = 'not-pulled';
  private reconcileOutcome: 'active' | 'settled' | 'expiring' | 'interrupted' = 'active';
  private streamErrorAt = 0;
  private reconcileExpiredAt = 0;
  private authorityInterruptedAt = 0;
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

  async configure(artifact: NativeArtifact, digest: string, journey = false, oversizedSourceMetadata = false,
    researchBodyBytes?: 131072 | 262144 | 1044480, admittedTarget?: string,
    journeyFacts?: { createdAt: string; unrelatedCreatedAt: string }, journeyScenario?: NativeJourneyScenario,
    admittedInferenceBytes?: 1048576) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== digest || bytes.length > 8 * 1024 * 1024 || Object.keys(artifact.modules).length > 128 ||
      artifact.className !== 'FlueDispatcherAgent' || artifact.versions.runtime !== '2.1.0' || artifact.versions.agents !== '0.20.1') {
      return { ok: false, reason: 'fixture-artifact-rejected' };
    }
    // Closed host-only scenarios cannot change artifact modules or SDK settings.
    if ((journeyScenario !== undefined && (!journey || researchBodyBytes !== 131072
      || !['ordinary', 'overflow-once', 'transient-interruption-once', 'finish-undiscovered', 'seal-undiscovered'].includes(journeyScenario)))
      || (admittedInferenceBytes !== undefined && (!journeyScenario || admittedInferenceBytes !== 1048576))) {
      return { ok: false, reason: 'fixture-scenario-rejected' };
    }
    if (journey) {
      await this.ctx.storage.put('fixture:journey', true);
      if (journeyScenario) await this.ctx.storage.put('fixture:journey-scenario', journeyScenario);
      if (admittedInferenceBytes) await this.ctx.storage.put('fixture:admitted-inference-bytes', admittedInferenceBytes);
      if (oversizedSourceMetadata) await this.ctx.storage.put('fixture:oversized-source-metadata', true);
      if (researchBodyBytes) await this.ctx.storage.put('fixture:research-body-bytes', researchBodyBytes);
      // Test parent metadata and authenticated remote facts are separate inputs.
      if (admittedTarget !== undefined) await this.ctx.storage.put('fixture:admitted-target', admittedTarget);
      if (journeyFacts) await this.ctx.storage.put('fixture:journey-facts', journeyFacts);
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
      if (mode === 'rpc-fiber') await this.ctx.storage.put('fixture:probe:rpc-fiber:warning-completed', true);
      if (mode === 'rpc-fiber') {
        const report = await this.env.OPERATOR.fetch(new Request('https://operator.internal/v1/dispatcher/diagnostic', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'fetch-rejected' }),
        }));
        if (!report.ok) throw new Error('Synthetic diagnostic report denied');
      }
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
  async fixtureDiagnosticProbeWarningReceipt() {
    return await this.ctx.storage.get('fixture:probe:rpc-fiber:warning-completed') === true;
  }
}`;
      if (probe && artifact.mainModule !== 'index.js') throw new Error('Pinned probe main module unavailable');
      const admittedTarget = await this.ctx.storage.get<string>('fixture:admitted-target');
      const worker = this.env.LOADER.get(`fixture:${this.name}:${digest}:${binding.generation}${probe ? ':tail-probe' : ''}`, async () => ({
        compatibilityDate: artifact.compatibilityDate, compatibilityFlags: artifact.compatibilityFlags,
        mainModule: probe ? probeModule : artifact.mainModule,
        modules: probe ? { ...artifact.modules, [probeModule]: { js: probeSource } } : artifact.modules,
        // The facet receives only this direct, activity-private RPC target.
        // Its generation is captured here from the owner, never from delivery.
        env: { OPERATOR: exports.FixtureFlueTransport({ props: { activityId: this.name, generation: binding.generation } }),
          ...(admittedTarget !== undefined ? { OPERATOR_ADMITTED_TARGET: admittedTarget } : {}),
          ...(await this.ctx.storage.get('fixture:journey') ? { GITHUB_API_ORIGIN: 'https://api.github.com',
            OPERATOR_SOURCE_RESPONSE_BYTES: String(await this.ctx.storage.get<number>('fixture:research-body-bytes')
              ? Math.min(1024 * 1024, 2 * (await this.ctx.storage.get<number>('fixture:research-body-bytes'))!)
              : await this.ctx.storage.get('fixture:oversized-source-metadata') ? 131072 : 65536) } : {}) },
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

  async journeyUpdates(submissionId: string, previous: DispatcherResultProjection) {
    const response = await (await this.child()).fetch(new Request(
      `https://flue.internal/agents/Dispatcher/dispatcher?view=updates&offset=${encodeURIComponent(previous.offset)}`));
    return readDispatcherUpdates(response, previous, submissionId);
  }

  /** Recovery cases never export inference bodies, prompts or SDK private state. */
  async journeyObservation(): Promise<NativeJourneyObservation> {
    const effects = await this.ctx.storage.get<NativeJourneyObservation['effects']>('fixture:journey-effects')
      ?? { commentRequests: 0, otherMutationRequests: 0, commentMatches: false, researchSourceRequests: 0 };
    const activity = await this.env.ACTIVITY.getByName(this.name).journeySession();
    if (!activity) throw new Error('Fixture Activity observation unavailable');
    return {
      wire: await this.ctx.storage.get<NativeInferenceWire[]>('fixture:journey-wire') ?? [],
      effects,
      sessionId: activity.sessionId,
      interruptionObserved: Boolean(await this.ctx.storage.get('fixture:journey-interruption')),
      retryIdentityMatched: await this.ctx.storage.get('fixture:journey-retry-matched') === true,
    };
  }

  /** Public SDK history only: no fixtureSnapshot/private tables or raw error prose. */
  async journeyDiagnostic(submissionId: string): Promise<NativeJourneyDiagnostic> {
    const allow = (value: unknown, values: readonly string[], fallback = 'unknown') =>
      typeof value === 'string' && values.includes(value) ? value : fallback;
    const reason = (value: unknown): string => {
      if (value === undefined) return 'none';
      // Exact known package/adapter messages only; arbitrary SDK/provider text
      // may contain input, source bodies or credentials and stays unclassified.
      const known = ['Unadmitted target', 'Citation provenance unavailable', 'Decisions incomplete',
        'Results incomplete or effect unknown', 'Discovery unavailable', 'Discovery ordering or identity unavailable',
        'Discovery target changed', 'Protected transport denied', 'Invalid source envelope',
        'Source request oversized', 'Operation conflict', 'Receipt identity mismatch',
        'Actual ledger receipt unavailable', 'Actual operation capacity unavailable before effects'];
      if (typeof value === 'string' && /^Parent inference denied: [3-5][0-9]{2}$/.test(value)) return value;
      return allow(value, known, 'unclassified');
    };
    const response = await (await this.child()).fetch(new Request(
      'https://flue.internal/agents/Dispatcher/dispatcher?view=history'));
    const diagnostic: NativeJourneyDiagnostic = { historyStatus: response.status, outcome: 'unknown',
      errorType: 'none', operation: 'none', reason: 'none', firstFailedTool: null, tools: [] };
    if (!response.ok) return diagnostic;
    const history = await response.json() as { messages?: Array<{ submissionId?: string;
      parts?: Array<{ type?: string; toolName?: unknown; state?: unknown; errorText?: unknown }> }>;
      settlements?: Array<{ submissionId?: string; outcome?: unknown;
        error?: { type?: unknown; meta?: { operation?: unknown; reason?: unknown } } }> };
    const settlement = history.settlements?.find(item => item.submissionId === submissionId);
    diagnostic.outcome = allow(settlement?.outcome, ['completed', 'failed', 'aborted'], 'pending');
    diagnostic.errorType = allow(settlement?.error?.type, ['operation_failed', 'tool_output_serialization',
      'tool_output_validation', 'tool_execution', 'submission_timeout', 'retry_exhausted'], settlement?.error ? 'unknown' : 'none');
    diagnostic.operation = settlement?.error?.meta?.operation === undefined ? 'none'
      : settlement.error.meta.operation === `direct(${submissionId})` ? 'direct' : 'unknown';
    diagnostic.reason = reason(settlement?.error?.meta?.reason);
    const tools = ['discover_renovate', 'research_renovate', 'decide_renovate', 'seal_dispatcher',
      'comment_renovate', 'finish_dispatcher'];
    diagnostic.tools = (history.messages ?? []).filter(message => message.submissionId === submissionId).slice(0, 32)
      .flatMap(message => (message.parts ?? []).slice(0, 16)).filter(part => part.type === 'dynamic-tool').slice(0, 8)
      .map(part => ({ tool: allow(part.toolName, tools),
        state: allow(part.state, ['input-streaming', 'input-available', 'output-available', 'output-error']),
        reason: reason(part.errorText) }));
    diagnostic.firstFailedTool = diagnostic.tools.find(tool => tool.state === 'output-error')?.tool ?? null;
    return diagnostic;
  }

  async send(delivery: NativeDelivery | { repository: string; pullRequest?: number }, productionEvidence?: ProductionEvidence,
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
      if (response.status === 202 && typeof body.submissionId === 'string' && !await this.ctx.storage.get('fixture:journey')) {
        const binding = await this.facetBridgeBinding();
        if (binding.status === 'current') {
          const authority = await this.activityBinding();
          if (!authority || authority.deadline <= Date.now()) throw new Error('Fixture authority expired');
          const active = { submissionId: body.submissionId, generation: binding.generation,
            expiresAt: productionBehavior === 'stream-fail' ? authority.deadline
              : holdInference ? Math.min(authority.deadline, Date.now() + 45_000) : Date.now() + 5_000 };
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
        this.reconcileOutcome = 'settled';
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.reconcileExpiredAt = Date.now();
    this.reconcileOutcome = 'expiring';
    await this.env.ACTIVITY.getByName(this.name).interruptDrive(active.generation);
    this.authorityInterruptedAt = Date.now();
    this.reconcileOutcome = 'interrupted';
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
      const path = await this.ctx.storage.get('fixture:production-evidence') || await this.ctx.storage.get('fixture:journey')
        ? '/agents/Dispatcher/dispatcher' : '/dispatcher';
      const response = await child.fetch(new Request(`https://flue.internal${path}`));
      conversation = await response.json();
      facet = await child.fixtureSnapshot();
    } catch (error) { failure = String(error); }
    return {
      instance: this.instance, conversation, facet, failure,
      journeyOperations: await this.ctx.storage.get('fixture:journey-operations'),
      journeyReceiptCount: await this.ctx.storage.get('fixture:journey-receipt-count'),
      journeyResearchReads: await this.ctx.storage.get('fixture:journey-research-reads'),
      journeyInferenceBytes: await this.ctx.storage.get('fixture:journey-inference-bytes'),
      alarmDeliveries: await this.ctx.storage.get<number>('fixture:alarm-deliveries') ?? 0,
      barrierReached: await this.ctx.storage.get<boolean>('fixture:barrier-reached') ?? false,
      external: await this.ctx.storage.get<ExternalReceipt[]>('fixture:external') ?? [],
      externalAttempts: await this.ctx.storage.get<ExternalAttempt[]>('fixture:external-attempts') ?? [],
      productionCalls: await this.ctx.storage.get<ProductionCall[]>('fixture:production-calls') ?? [],
      streamPhase: this.streamPhase,
      reconcileOutcome: this.reconcileOutcome,
      streamErrorVsExpiry: this.streamErrorAt && this.reconcileExpiredAt
        ? this.streamErrorAt <= this.reconcileExpiredAt ? 'before' : 'after' : 'unobserved',
      interruptionVsError: this.authorityInterruptedAt && this.streamErrorAt
        ? this.authorityInterruptedAt <= this.streamErrorAt ? 'before' : 'after' : 'unobserved',
      diagnosticReports: await this.ctx.storage.get('fixture:diagnostic-reports') ?? [],
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
      ...(mode === 'rpc-fiber' ? { warningCompleted: await child.fixtureDiagnosticProbeWarningReceipt?.() ?? false } : {}),
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
  async transport(request: Request, boundGeneration: number): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (await this.ctx.storage.get('fixture:journey')) return this.journeyTransport(request);
    if (path === '/v1/dispatcher/diagnostic') {
      if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 403 });
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 256) return new Response(null, { status: 403 });
      let report: Record<string, unknown>;
      try { report = JSON.parse(raw) as Record<string, unknown>; } catch { return new Response(null, { status: 403 }); }
      if (!report || typeof report !== 'object' || Array.isArray(report)
        || !(Object.keys(report).length === 1 && report.stage === 'fetch-rejected')
          && !(Object.keys(report).length === 2 && report.stage === 'http-rejected'
            && typeof report.status === 'number' && Number.isInteger(report.status)
            && report.status >= 300 && report.status <= 599)) {
        return new Response(null, { status: 403 });
      }
      const reports = await this.ctx.storage.get<Array<{ activityId: string; generation: number; stage: string; status?: number }>>('fixture:diagnostic-reports') ?? [];
      if (reports.length >= 8) return new Response(null, { status: 403 });
      const binding = await this.facetBridgeBinding(boundGeneration);
      if (binding.status !== 'current') return new Response(null, { status: 403 });
      reports.push({ activityId: this.name, generation: boundGeneration, stage: report.stage as string,
        ...(report.stage === 'http-rejected' ? { status: report.status as number } : {}) });
      await this.ctx.storage.put('fixture:diagnostic-reports', reports);
      return new Response(null, { status: 204 });
    }
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
          pull: (controller) => {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
              this.streamPhase = 'prefix-enqueued';
            } else {
              controller.error(new Error('Controlled inference stream failed'));
              this.streamPhase = 'error-injected';
              this.streamErrorAt = Date.now();
            }
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

  private async journeyTransport(request: Request): Promise<Response> {
    const wireRequest = request.clone();
    const scenario = await this.ctx.storage.get<NativeJourneyScenario>('fixture:journey-scenario');
    const inferenceByteLimit = await this.ctx.storage.get<number>('fixture:admitted-inference-bytes');
    let operation: Awaited<ReturnType<typeof parseDispatcherOperation>> | undefined;
    // Every authentic request, including summaries/retries, crosses the unchanged
    // production parser. This is admitted fixture policy, not a product limit.
    try { operation = await parseDispatcherOperation(request, inferenceByteLimit); }
    catch { /* Record closed semantic evidence below, never exception text. */ }
    let wireText: string | undefined;
    let wire: NativeInferenceWire | undefined;
    if (scenario && new URL(wireRequest.url).pathname === '/v1/dispatcher/inference') {
      try {
        wireText = await readDispatcherBody(wireRequest, wireRequest.signal, inferenceByteLimit);
        const envelope = JSON.parse(wireText) as { input?: Record<string, unknown> };
        const input = envelope?.input;
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const canonical = Object.hasOwn(input, 'max_tokens');
          const alias = Object.hasOwn(input, 'max_completion_tokens');
          const other = Object.hasOwn(input, 'max_output_tokens');
          const tools = Array.isArray(input.tools) ? input.tools.length : 0;
          const budget = canonical ? input.max_tokens : alias ? input.max_completion_tokens : null;
          wire = { admission: operation ? 'accepted' : 'rejected', stage: tools ? 'normal' : 'summary',
            tokenField: other ? 'other' : canonical && alias ? 'dual' : canonical ? 'canonical' : alias ? 'completion-alias' : 'absent',
            outputBudget: typeof budget === 'number' && Number.isFinite(budget) ? budget : null,
            messages: Array.isArray(input.messages) ? input.messages.length : 0, tools };
          // Parallel main/prefix summaries must not race a global append ordinal.
          await this.ctx.storage.transaction(async storage => {
            const observed = await storage.get<NativeInferenceWire[]>('fixture:journey-wire') ?? [];
            if (observed.length >= 64) throw new Error('Fixture inference observation bound exceeded');
            await storage.put('fixture:journey-wire', [...observed, wire!]);
          });
        }
      } catch { /* Malformed/oversized bodies produce no content-bearing diagnostic. */ }
    }
    if (!operation) return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
    const operations = await this.ctx.storage.get<Record<string, { path: string; body: unknown }>>('fixture:journey-operations') ?? {};
    if (operation.path === '/v1/dispatcher/receipt') {
      const prior = operations[operation.operationId];
      if (!prior || prior.path !== '/v1/dispatcher/source') return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
      const source = prior.body as { url: string; method?: string };
      await this.ctx.storage.put('fixture:journey-receipt-count', Object.keys(operations).length);
      return Response.json({ operationId: operation.operationId, generation: 1, requestDigest: 'a'.repeat(64),
        responseDigest: 'b'.repeat(64), method: source.method ?? 'GET', url: source.url,
        phase: 'completed', operationCount: Object.keys(operations).length, operationLimit: 1024 });
    }
    const researchBodyBytes = await this.ctx.storage.get<number>('fixture:research-body-bytes');
    const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
    const researchUrl = 'https://docs.example.test/large-migration';
    const quote = 'Migration compatibility remains unverified.';
    const comment = `${quote} Source: ${researchUrl}`;
    // Older artifact-window cases intentionally inspect model-facing bodies.
    // New recovery cases retain only an internal conflict digest and closed wire
    // evidence; no prompts/tool bodies are persisted in their inference ledger.
    const entry = { path: operation.path, body: scenario && operation.path === '/v1/dispatcher/inference' ? {} : operation.body };
    if (scenario && operation.path === '/v1/dispatcher/inference') {
      if (!wire || wireText === undefined) return new Response(null, { status: 403 });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wireText))),
        b => b.toString(16).padStart(2, '0')).join('');
      const digests = await this.ctx.storage.get<Record<string, string>>('fixture:journey-wire-digests') ?? {};
      if (digests[operation.operationId] && digests[operation.operationId] !== digest) {
        return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
      }
      if (scenario === 'transient-interruption-once') {
        const interrupted = await this.ctx.storage.get<{ operationId: string; digest: string }>('fixture:journey-interruption');
        if (interrupted?.operationId === operation.operationId && interrupted.digest === digest) {
          await this.ctx.storage.put('fixture:journey-retry-matched', true);
        }
      }
      await this.ctx.storage.put('fixture:journey-wire-digests', { ...digests, [operation.operationId]: digest });
    }
    if (operations[operation.operationId] && JSON.stringify(operations[operation.operationId]) !== JSON.stringify(entry)) {
      return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
    }
    if (operation.path === '/v1/dispatcher/source') {
      const source = operation.body as { url: string; method?: string; body?: string };
      const bot = { id: 29139614, login: 'renovate[bot]', type: 'Bot' };
      const actor = { id: 42, login: 'fixture-publisher', type: 'User' };
      const facts = await this.ctx.storage.get<{ createdAt: string; unrelatedCreatedAt: string }>('fixture:journey-facts');
      const pull = { number: 17, state: 'open', draft: false, created_at: facts?.createdAt ?? new Date(Date.now() - 86400000).toISOString(),
        user: bot, head: { sha: target.headSha }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'authorized/project', ...(facts ? { id: 123 } : {}) } } };
      const unrelated = { ...pull, number: 19, created_at: facts?.unrelatedCreatedAt, head: { sha: 'c'.repeat(40) } };
      const pullsUrl = 'https://api.github.com/repos/authorized/project/pulls?state=open&sort=created&direction=desc&per_page=1&page=';
      const allowed: Record<string, unknown> = {
        'https://api.github.com/repos/authorized/project': { full_name: 'authorized/project', ...(facts ? { id: 123 } : {}),
          ...(await this.ctx.storage.get('fixture:oversized-source-metadata') ? { padding: 'x'.repeat(80 * 1024) } : {}) },
        'https://api.github.com/users/renovate%5Bbot%5D': { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
        [`${pullsUrl}1`]: facts ? [unrelated] : researchBodyBytes ? [pull] : [],
        ...(facts ? {
          [`${pullsUrl}2`]: [pull],
          'https://api.github.com/repos/authorized/project/pulls/19': unrelated,
          'https://api.github.com/repos/authorized/project/issues/19/comments?per_page=100': [],
        } : {}),
        ...(researchBodyBytes ? {
          'https://api.github.com/repos/authorized/project/pulls/17': pull,
          'https://api.github.com/user': actor,
          'https://api.github.com/repos/authorized/project/issues/17/comments?per_page=100': [],
        } : {}),
      };
      const commentUrl = 'https://api.github.com/repos/authorized/project/issues/17/comments';
      const unrelatedCommentUrl = 'https://api.github.com/repos/authorized/project/issues/19/comments';
      let body: string;
      let status = 200;
      if (researchBodyBytes && (source.url === commentUrl || (facts && source.url === unrelatedCommentUrl)) && source.method === 'POST') {
        if (source.body !== JSON.stringify({ body: comment })) return new Response(null, { status: 403 });
        status = 201;
        body = JSON.stringify({ id: 91, body: comment, user: actor,
          issue_url: source.url.replace(/\/comments$/, '') });
      } else {
        if ((source.method ?? 'GET') !== 'GET') return new Response(null, { status: 403 });
        if (researchBodyBytes && source.url === researchUrl) {
          await this.ctx.storage.put('fixture:journey-research-reads',
            (await this.ctx.storage.get<number>('fixture:journey-research-reads') ?? 0) + 1);
          body = scenario === 'overflow-once'
            ? 'x'.repeat(23 * 2000) + quote + 'x'.repeat(researchBodyBytes - 23 * 2000 - quote.length)
            : 'x'.repeat(researchBodyBytes - 2000) + quote + 'y'.repeat(2000 - quote.length);
        } else {
          if (!Object.hasOwn(allowed, source.url)) return new Response(null, { status: 403 });
          body = JSON.stringify(allowed[source.url]);
        }
      }
      // Count each accepted synthetic upstream request, including identical IDs.
      // The separate operation map remains solely the identity/conflict ledger.
      const isComment = source.method === 'POST' && source.url === commentUrl;
      const isMutation = (source.method ?? 'GET') !== 'GET';
      const isResearch = !isMutation && source.url === researchUrl;
      if (isMutation || isResearch) await this.ctx.storage.transaction(async storage => {
        const effects = await storage.get<NativeJourneyObservation['effects']>('fixture:journey-effects')
          ?? { commentRequests: 0, otherMutationRequests: 0, commentMatches: false, researchSourceRequests: 0 };
        if (effects.commentRequests + effects.otherMutationRequests + effects.researchSourceRequests >= 128) {
          throw new Error('Fixture source request observation bound exceeded');
        }
        if (isComment) {
          effects.commentRequests++;
          effects.commentMatches = effects.commentRequests === 1 && source.body === JSON.stringify({ body: comment });
        } else if (isMutation) effects.otherMutationRequests++;
        else effects.researchSourceRequests++;
        await storage.put('fixture:journey-effects', effects);
      });
      await this.ctx.storage.put('fixture:journey-operations', { ...operations, [operation.operationId]: entry });
      return Response.json({ url: source.url, status, headers: { 'content-type': 'application/json',
        ...(facts && source.url === `${pullsUrl}1` ? { link: `<${pullsUrl}2>; rel="next"` } : {}) }, body });
    }
    if (operation.path !== '/v1/dispatcher/inference') return new Response(null, { status: 403 });
    const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const artifactKey = JSON.stringify({ target, url: researchUrl, kind: 'upstream' });
    const artifactHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactKey))),
      b => b.toString(16).padStart(2, '0')).join('');
    const summaryPrefix = `Repository authorized/project; admitted PR 17, head ${target.headSha}. Discovery authenticated Renovate.`;
    if (scenario && wire?.stage === 'summary') {
      // External summary model response only. The real SDK owns preparation,
      // summary requests, compaction state and continuation of this submission.
      // Identical deterministic text is safe for concurrently requested summaries.
      const summary = `${summaryPrefix} Research artifact artifact-${artifactHash.slice(0, 24)} for ${researchUrl} contains exact quotation: ${quote} `
        + `Record DO_NOT_MERGE with comment "${comment}" and the artifact citation; seal, comment once, then finish. No merge.`;
      await this.ctx.storage.transaction(async storage => {
        const current = await storage.get<Record<string, { path: string; body: unknown }>>('fixture:journey-operations') ?? {};
        await storage.put('fixture:journey-operations', { ...current, [operation.operationId]: entry });
      });
      return sse([{ choices: [{ index: 0, delta: { content: summary }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9000, completion_tokens: 150, total_tokens: 9150 } }]);
    }
    if (scenario === 'overflow-once' && await this.ctx.storage.get('fixture:journey-injected')) {
      const observed = await this.ctx.storage.get<NativeInferenceWire[]>('fixture:journey-wire') ?? [];
      // A continuation is answered only when the SDK really carried our public
      // upstream summary into the new normal wire context. Export no text.
      const input = (JSON.parse(wireText!) as { input: { messages: unknown[] } }).input;
      if (!observed.some(item => item.stage === 'summary' && item.admission === 'accepted')
        || !JSON.stringify(input.messages).includes(summaryPrefix)) return new Response(null, { status: 403 });
    }
    const turn = scenario ? await this.ctx.storage.get<number>('fixture:journey-domain-turn') ?? 0
      : Object.values(operations).filter(item => item.path === operation.path).length;
    // Synthetic upstream model stop after a genuine failed producer completion tool.
    if ((scenario === 'finish-undiscovered' && turn > 0) || (scenario === 'seal-undiscovered' && turn > 1)) {
      await this.ctx.storage.put('fixture:journey-operations', { ...operations, [operation.operationId]: entry });
      return sse([{ choices: [{ index: 0, delta: { content: 'Diagnostic fixture stop.' }, finish_reason: 'stop' }] }]);
    }
    // 24 genuine SDK tool turns, each a successive 2000-character artifact
    // window: >12000 estimated text tokens, a kept cut point, <128 messages/ops.
    const researchTurns = scenario === 'overflow-once' ? 24 : 2;
    const tool = scenario === 'seal-undiscovered' ? ['seal_dispatcher', 'finish_dispatcher'][turn]
      : scenario === 'finish-undiscovered' ? 'finish_dispatcher' : (researchBodyBytes
        ? ['discover_renovate', ...Array.from({ length: researchTurns }, () => 'research_renovate'),
          'decide_renovate', 'seal_dispatcher', 'comment_renovate', 'finish_dispatcher']
        : ['discover_renovate', 'seal_dispatcher', 'finish_dispatcher'])[turn];
    if (!tool) return new Response(null, { status: 403 });
    if (!scenario) {
      const bytes = new TextEncoder().encode(await wireRequest.text()).byteLength;
      await this.ctx.storage.put('fixture:journey-inference-bytes',
        [...(await this.ctx.storage.get<number[]>('fixture:journey-inference-bytes') ?? []), bytes]);
    }
    const injectAt = scenario === 'overflow-once' ? researchTurns + 1 : 2;
    if (scenario && scenario !== 'ordinary' && turn === injectAt
      && !await this.ctx.storage.get('fixture:journey-injected')) {
      if (scenario === 'overflow-once') {
        // Validate actual SDK model-facing tool results before injecting overflow.
        // No asserted token usage or scripted turn ordinal substitutes for real
        // retained text. Only the existing artifact window wire contract is read.
        const windows = new Map<number, number>();
        let inspected = 0;
        const visit = (value: unknown, depth = 0): void => {
          if (++inspected > 4096 || depth > 16) return;
          if (typeof value === 'string') {
            if (/^\s*[[{]/.test(value)) {
              try { visit(JSON.parse(value), depth + 1); } catch { /* Plain text. */ }
            }
          } else if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
          } else if (value && typeof value === 'object') {
            const item = value as Record<string, unknown>;
            if (item.bodyLength === 131072 && item.bodyTruncated === true && typeof item.bodyOffset === 'number'
              && typeof item.body === 'string' && item.body.length === 2000) windows.set(item.bodyOffset, item.body.length);
            for (const field of Object.values(item)) visit(field, depth + 1);
          }
        };
        visit((JSON.parse(wireText!) as { input: { messages: unknown[] } }).input.messages);
        if (windows.size !== 24 || !Array.from({ length: 24 }, (_, index) => index * 2000).every(offset => windows.has(offset))
          || [...windows.values()].reduce((sum, length) => sum + length / 4, 0) <= 8000) return new Response(null, { status: 403 });
      }
      await this.ctx.storage.put('fixture:journey-injected', true);
      if (scenario === 'transient-interruption-once') {
        const digests = await this.ctx.storage.get<Record<string, string>>('fixture:journey-wire-digests');
        await this.ctx.storage.put('fixture:journey-interruption', { operationId: operation.operationId,
          digest: digests![operation.operationId] });
      }
      await this.ctx.storage.put('fixture:journey-operations', { ...operations, [operation.operationId]: entry });
      // Successful admitted HTTP200 SSE failure inputs, not handwritten child
      // requests or private SDK calls. Neither injection consumes a domain turn.
      return sse([{ choices: [{ index: 0, delta: {},
        finish_reason: scenario === 'overflow-once' ? 'context_length_exceeded' : null }],
        usage: { prompt_tokens: scenario === 'overflow-once' ? 14000 : 2000, completion_tokens: 0,
          total_tokens: scenario === 'overflow-once' ? 14000 : 2000 } }]);
    }
    const args = tool === 'research_renovate' ? { target, url: researchUrl, kind: 'upstream',
      offset: scenario === 'overflow-once' ? (turn - 1) * 2000 : turn === 2 ? researchBodyBytes! - 2000 : 0 }
      : tool === 'decide_renovate' ? { target, decision: 'DO_NOT_MERGE', comment,
        claims: [{ artifactId: `artifact-${artifactHash.slice(0, 24)}`, quote, relevance: 'migration uncertainty', authority: 'publisher guidance' }],
        analysis: { changedUsage: 'unverified', configuration: 'unverified', interoperability: 'unverified', migration: 'unverified', gaps: ['No verified compatibility declaration'] } }
      : tool === 'comment_renovate' ? { target } : {};
    await this.ctx.storage.put('fixture:journey-operations', { ...operations, [operation.operationId]: entry });
    if (scenario) await this.ctx.storage.put('fixture:journey-domain-turn', turn + 1);
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `journey-${turn}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
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
    const { generation } = this.ctx.props as { activityId: string; generation: number };
    return (await this.#root()).transport(request, generation);
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
    case 'configure': return Response.json(await root.configure(command.artifact, command.digest, command.journey,
      command.oversizedSourceMetadata, command.researchBodyBytes, command.admittedTarget, command.journeyFacts,
      command.journeyScenario, command.admittedInferenceBytes));
    case 'journey-observation': return Response.json(await root.journeyObservation());
    case 'journey-comment-request': {
      const binding = await root.facetBridgeBinding();
      if (binding.status !== 'current') return new Response(null, { status: 403 });
      return root.transport(new Request('https://operator.internal/v1/dispatcher/source', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'repeated-comment-control', method: 'POST',
          url: 'https://api.github.com/repos/authorized/project/issues/17/comments',
          body: JSON.stringify({ body: 'Migration compatibility remains unverified. Source: https://docs.example.test/large-migration' }),
        }),
      }), binding.generation);
    }
    case 'journey-updates': return Response.json(await root.journeyUpdates(command.submissionId, command.previous));
    case 'journey-diagnostic': return Response.json(await root.journeyDiagnostic(command.submissionId));
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
