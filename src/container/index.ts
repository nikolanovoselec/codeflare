/**
 * Container Durable Object - internal route response shapes
 *
 * POST /_internal/setBucketName
 *   Request:  { bucketName: string; sessionId?: string; r2AccessKeyId?: string;
 *               r2SecretAccessKey?: string; r2AccountId?: string; r2Endpoint?: string;
 *               workspaceSyncEnabled?: boolean; fastStartEnabled?: boolean;
 *               tabConfig?: TabConfig[] }
 *   Response (200): { success: true; bucketName: string }
 *   Response (409): { error: "Bucket name already set" }  - idempotent; still stores sessionId/prefs
 *   Response (400): { error: string }                     - validation failure
 *   Response (500): { error: "Internal error" }
 *
 * PUT /_internal/setSessionId
 *   Request:  { sessionId?: string }
 *   Response (200): { success: true }
 *   Response (500): { error: "Internal error" }
 *
 * GET /_internal/getBucketName
 *   Response (200): { bucketName: string | null }
 *
 * The class below is a thin composition shell (CF-012): per-seam logic lives in
 * container-config.ts (state + setBucketName/getBucketName/updateEnvVars/
 * ensureVaultKey), container-router.ts (typed internal-route dispatch, CF-016),
 * container-lifecycle.ts (onStart/collectMetrics/destroy/onStop/onError), and
 * container-interception.ts (the outbound-HTTPS interception registry wired
 * pre-start).
 */
import { parseStoredSyncPolicyMode } from '../lib/sync-policy';
import { McpPortalState, decryptMcpRecord, mcpRecordContext, type McpFence, type McpPendingInput, type McpCallbackBinding } from '../lib/mcp-portal-state';
import { runOwnedUserCleanup, type CleanupResult } from '../lib/user-cleanup';
import { Container } from '@cloudflare/containers';
import { captureRawValue } from '../../host/src/operator-raw-logging';
import { DispatcherSdkStorageError, handleDispatcherSdkCredentials, type DispatcherSdkCredentialResult, type SdkStorageScope, type SdkCredentialAuthority } from '../operators/dispatcher-sdk-storage';
import { PiSurfaceSchema, type Env, type ManagedResourcePolicy, type PiSurface, type SessionWorkspace, type TabConfig, type TerminalMode } from '../types';
import { isPiWebEligible, isPiWebPath, matchesPiWebGeneration, PI_WEB_GENERATION_HEADER, piWebAppPrefix, piWebSessionId } from './pi-web';
import type { PiDefaultSource } from '../lib/personal-pi-policy';
import type { OperatorLoggingContext, PiWebReadAuthority } from '../lib/container-helpers';
import { getR2Config } from '../lib/r2-config';
import { createHash } from 'node:crypto';
import { AGENTS_SEEDED_CONFIGS } from '../lib/agent-seed.generated';
import { getBucketOwnerStub } from '../lib/access';
import { SESSION_ID_PATTERN } from '../lib/constants';
import { HermesRetention, type HermesAdmission, type HermesWriter } from '../lib/hermes-retention';
import { HERMES_ADAPTER_KEY, hermesRetentionR2 } from '../lib/hermes-retention-r2';
import { canonicalJson } from '../lib/reasoning-profiles';
import { runSetupConfiguration, type SetupConfigurationInput } from '../routes/setup/index';
import { getWorkerNameFromHostname } from '../routes/setup/shared';
import { performBucketMultipart, MULTIPART_PENDING_COMPLETION, type BucketMultipartOperation } from '../routes/storage/upload';
import { advanceMigrationChunk, getRegimeState, getR2SsePolicyDisabled, regimeForPolicy } from '../lib/r2-migration';
import { computeKeyMd5 } from '../lib/r2-sse';
import { setRegimeState } from '../lib/r2-regime-state';
import type { RegimeState } from '../lib/r2-regime-state';
import { hasOwningSessionContainer } from '../lib/session-helpers';
import { D1SessionRepository } from '../lib/session-repository';
import { AppError, toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { hasStrictGatewayEgress } from '../lib/controller-egress';
import { getPersonalPiSession, wireContainerInterception, type InterceptionHost } from './container-interception';
import { ownedBrowser, type BrowserOwnerReference, type BrowserOperation } from './container-browser';
import type { OperatorPolicy } from '../operators/policy';
import { parseOperatorPackageResourceProjection, verifyOperatorPackageResourceProjection,
  type OperatorPackageResourceProjection } from '../operators/package-resources';
import { parseOperatorAttachmentProjection, type OperatorAttachmentProjection } from '../operators/attachments';
import type { JwtStampingAuthority, JwtStampingPolicy } from '../operators/jwt-stamping';
import {
  bindOperatorAuthority as contextBindOperatorAuthority,
  configureOperatorContext as contextConfigureOperatorContext,
  restoreOperatorContext as contextRestoreOperatorContext,
  type OperatorContainerProfile,
  type OperatorContextHost,
} from './operator-context';
import {
  validateBucketNameInput,
  type ContainerEnvState,
  type SetBucketNameCreds,
} from './container-env';
import {
  setBucketName as configSetBucketName,
  getBucketName as configGetBucketName,
  updateEnvVars as configUpdateEnvVars,
  refreshMcpPortalConfiguration,
  ensureVaultKey as configEnsureVaultKey,
  type ContainerHost,
} from './container-config';
import { captureMetricsExecution, CONTAINER_POLL_BUDGET_MS, FINAL_SYNC_AUDIT_KEY, SHUTDOWN_REQUESTED_KEY, raceBudget, type MetricsPin } from './container-metrics';
import { dispatchInternalRoute } from './container-router';
import { bindReviewSessionHuman, openReviewSessionHuman } from './review-session-human';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { parseBoundedBoundaryInput, type BoundaryInput } from '../operators/boundary-input';
import {
  onStart as lifecycleOnStart,
  confirmMonitoredExit,
  collectMetrics as lifecycleCollectMetrics,
  destroy as lifecycleDestroy,
  stopSession as lifecycleStopSession,
  killSession as lifecycleKillSession,
  type SessionStopRequest,
  SESSION_LAUNCH_GENERATION_KEY,
  onStop as lifecycleOnStop,
  onError as lifecycleOnError,
  type LifecycleHost,
  type LifecycleLogContext,
} from './container-lifecycle';

export { validateBucketNameInput };

const SESSION_ID_KEY = '_sessionId';
const TERMINAL_KEEPALIVE_MS = 15_000;
const HERMES_DIRECT_LAYOUT_KEY = 'hermes:direct-layout';
const HERMES_SETTLED_GENERATION_KEY = 'hermes:settled-generation';
const HERMES_MASTER_ADAPTER = '022e0ccae29f5235e4931829802e5656432111efe83f4c0c07b2cf22f1ca6a75'; // v196
const HERMES_CHECKPOINT_ADAPTER = 'd6e0420a7a73120a48a457f38bce4a941a4c658fb7799ed89f8785f875735395'; // v197 and v198

/**
 * container - Container Durable Object for user workspaces
 *
 * Each session gets one container that persists their workspace via rclone bisync to R2.
 * The container runs a terminal server that handles multiple PTY sessions.
 */
// Class name must be lowercase 'container' to match wrangler.toml class_name
// and existing DO migrations. Renaming would require a destructive migration
// that risks losing all existing Durable Objects. See wrangler.toml migrations.
// The class structurally satisfies ContainerHost / LifecycleHost (used by the
// extracted config/router/lifecycle helpers), but those interfaces include
// SDK-provided members (ctx, env, stop, schedule, ...) whose declared
// visibility on the @cloudflare/containers base class is an implementation
// detail. We therefore delegate with an explicit `as unknown as XHost` cast at
// each call site - the same pattern the previous metricsState getter used -
// rather than an `implements` clause that would couple to the base class's
// member modifiers.
type ExitEvidence = { owner: string; session: string; generation: number; terminationIntentId?: string };

export class container extends Container<Env> implements ContainerEnvState {
  #sdkCredentialQueues = new Map<string, Promise<void>>();
  logger = createLogger('container');
  private sessionStartInFlight?: SessionStopRequest & {
    cancellation: AbortController; startup: { ready: boolean }; completion: Promise<void>;
  };
  private sessionConfigurationInFlight?: Promise<Response>;
  private sessionStopInFlight?: SessionStopRequest & { completion: Promise<void> };
  private sessionKillInFlight?: SessionStopRequest & { completion: Promise<void> };

  // Port where the container's HTTP server listens
  // Terminal server handles all endpoints: WebSocket, health check, metrics
  defaultPort = 8080;

  // SDK's sleepAfter timer is effectively disabled - we pin it to 24h so the
  // SDK never fires onActivityExpired in practice. The real idle detector is
  // collectMetrics(), which polls the in-container /activity endpoint every 60s
  // and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref.
  //
  // Why: the pinned Containers SDK refreshes its timer on every WebSocket
  // message in both directions (client<->container)
  // (parseTimeExpression('24h') = 86400s). That means the SDK timer tracks
  // "any activity", whereas we want "user-input activity" - a container running
  // `tail -f` or `yes` should still sleep when the user walks away.
  // collectMetrics reads lastInputAt from the in-container host. That timestamp
  // advances for classified PTY input and client-to-server Browser IDE frames,
  // but not terminal output or server-to-client editor traffic, giving us the
  // required semantics independently of the SDK.
  //
  // NOTE: pinning the SDK timer does NOT stop Cloudflare from reaping an idle
  // container instance at the platform level. That reap arrives as onError
  // (the monitor sees the container gone), NOT onActivityExpired/onStop - see
  // the lifecycle contract above onStart(). It is why containers can stop with
  // none of our timeouts having fired.
  override sleepAfter = '24h';

  // User-configured idle timeout (1h/2h/4h/8h/12h; legacy minute values tolerated). Enforced by collectMetrics,
  // NOT by the SDK. Stored in DO storage under the 'sleepAfter' key for
  // backwards compat with existing sessions created before this refactor.
  //
  // Default is the MAX supported value (12h), not the min. Rationale: this
  // class field is the fallback that wins when (a) the DO is freshly
  // constructed and storage hasn't been populated yet, or (b) a code path
  // skipped the setBucketName flow that writes the user pref. In either
  // case, defaulting LOW would kill the container before the pref could be
  // applied, destroying user work. Defaulting HIGH only lets the container
  // live longer than expected, which is a strictly safer failure mode. The
  // collectMetrics tick re-reads storage as the authoritative source on
  // every fire (60s cadence) so any drift is corrected within one tick.
  idleTimeoutPref: string = '12h';

  // Environment variables - set via property assignment in updateEnvVars()
  // These satisfy the ContainerEnvState interface, so they are not `private`.
  _bucketName: string | null = null;
  _mcpPortals: Array<{ name: string; url: string }> = [];
  _r2AccountId: string | null = null;
  _r2Endpoint: string | null = null;
  /** REQ-ENTERPRISE-016: strict Gateway egress active (enterprise + KV toggle); resolved once in the constructor. */
  _strictEgress: boolean = false;
  /** REQ-ENTERPRISE-018: Governed Mode — this bucket's R2 SSE-C disabled; set per-start from the setBucketName body. */
  _r2SseDisabled: boolean = false;
  _remoteCurationActive: boolean = false;
  _remoteCurationReleaseDigest: string | null = null;
  _remoteCurationManifestDigest: string | null = null;
  _managedResourcePolicy: ManagedResourcePolicy = 'mutable';
  _managedResourcePathsDigest: string | null = null;
  _r2AccessKeyId: string | null = null;
  _r2SecretAccessKey: string | null = null;
  _workspaceSyncEnabled: boolean = false;
  _syncPolicyMode: import('../lib/sync-policy').SyncPolicyMode = 'exclude';
  _fastStartEnabled: boolean = true;
  _tabConfig: TabConfig[] | null = null;
  _openaiApiKey: string | null = null;
  _geminiApiKey: string | null = null;
  _githubToken: string | null = null;
  _cloudflareApiToken: string | null = null;
  _cloudflareAccountId: string | null = null;
  _cloudflareOauthAccountId: string | null = null;
  _encryptionKey: string | null = null;
  _sessionMode: string = 'default';
  _sessionWorkspace: SessionWorkspace = 'terminal';
  _terminalMode: TerminalMode = 'classic';
  _containerAuthToken: string | null = null;
  /**
   * Per-session vault encryption key (REQ-VAULT-008 AC1). 32 random
   * bytes, base64-encoded. Generated on first ensureVaultKey() call,
   * persisted in ctx.storage under 'vaultKey', restored on DO wake.
   * Wiped by destroy() so deletion is forward-secret: a recovered
   * browser profile after session DELETE cannot decrypt the orphaned
   * IndexedDB ciphertext because the only key that ever existed lived
   * in this DO's storage. The Worker /.config proxy reads this via
   * RPC and injects it into SilverBullet's BootConfig so the browser
   * encrypts IDB without prompting the user for a passphrase.
   *
   * Public (not `private`) so the extracted config helpers in
   * container-config.ts can read/write it through the ContainerHost surface.
   */
  _vaultKey: string | null = null;
  _sessionId: string | null = null;
  _userEmail: string | null = null;
  /**
   * The user's matches from the configured Cloudflare user-access group list
   * (REQ-ENTERPRISE-004 revised), populated by the internal-config handler
   * alongside _userEmail. Passed as the LlmInterceptor `groups` prop so
   * cf-aig-metadata carries one tag per configured user group for gateway policy.
   */
  _userGroups: string[] = [];
  /**
   * Enterprise dynamic-route config (REQ-ENTERPRISE-005 revised), populated by the
   * internal-config handler. buildEnvVars fans these to entrypoint.sh as
   * ENTERPRISE_ROUTE_CATALOG / ENTERPRISE_DEFAULT_ROUTE / ENTERPRISE_DEFAULT_REASONING.
   */
  _routeCatalog: string[] = [];
  _allowPersonalPiProviders = false;
  _piDefaultSource: PiDefaultSource = 'managed';
  _defaultRoute: string | null = null;
  _defaultReasoning: string | null = null;
  _routeContextWindows: Record<string, number> = {};
  _routeReasoningLevels: Record<string, string[]> = {};
  _modelDisplayNames: Record<string, string> = {};
  _promptCacheTargets: string[] = [];
  /** REQ-MEM-001 AC4: user's IANA timezone (e.g. "Europe/Zurich"). */
  _userTimezone: string | null = null;
  /** REQ-GITHUB-004: clone directive (repo owner/name + optional ref) for a
   * session created from a repository. Instance memory only; the Worker re-sends
   * it from session KV before each container start. */
  _gitCloneRepo: string | null = null;
  _gitCloneRef: string | null = null;
/** Durable non-secret origin/profile. Raw Access authority remains memory-only. */
  _operatorContainerProfile?: OperatorContainerProfile;
  _operatorPackageResources?: OperatorPackageResourceProjection;
  _operatorAttachments?: OperatorAttachmentProjection;
  _operatorPolicy?: OperatorPolicy;
  _jwtStamping?: JwtStampingPolicy;
  _jwtAuthority?: JwtStampingAuthority;
  _gitCloneTargets: string | null = null;
  /**
   * Timestamp captured at the start of destroy(); read by onStop() to
   * log shutdown elapsed-ms. Helps telemetry decide whether the 135s
   * SIGTERM budget is right or needs another bump. A warn fires inside
   * destroy() at 110s elapsed so sessions approaching the ceiling
   * surface in logs before the 15-min cadence makes them routine.
   *
   * Public so container-lifecycle.ts can read/write it via LifecycleHost.
   */
  _shutdownStartedAt = 0;
  /** Diagnostic identity from existing lifecycle reads, never permission for an effect. */
  _observedLifecycleGeneration: number | null = null;
  _teardownEpoch = 0;
  /** Monotonic usage counter (seconds) - sent to Timekeeper for delta computation */
  _usageSeconds = 0;
  containerStartedAt = 0;
  /** Last seen lastInputAt from /activity - used to detect NEW input for renewal. */
  lastSeenInputAt: number | null = null;
  private monitoredGeneration: number | null = null;
  private pendingExit: ExitEvidence | null = null;
  private static readonly EXIT_OBSERVED_KEY = 'monitoredExitGeneration';

  /** Native Stop proof retains its accepted address/intent after operational cleanup. */
  private async exitEvidenceIsCurrent(evidence: ExitEvidence,
    storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<boolean> {
    const { owner, session, generation } = evidence;
    if (await storage.get<number>('lifecycleGeneration') !== generation) return false;
    const storedOwner = await storage.get<string>('bucketName');
    const storedSession = await storage.get<string>(SESSION_ID_KEY);
    if (evidence.terminationIntentId !== undefined) {
      return this.env.CONTAINER.idFromName(`${owner}-${session}`).toString() === this.ctx.id.toString()
        && (!storedOwner || storedOwner === owner) && (!storedSession || storedSession === session)
        && (!this._bucketName || this._bucketName === owner) && (!this._sessionId || this._sessionId === session);
    }
    return storedOwner === owner && storedSession === session && this._bucketName === owner && this._sessionId === session;
  }

  /** Own only finite work after success, not a never-settling provider's lifetime. */
  private recordNativeStopExit(evidence: ExitEvidence): Promise<void> {
    const epoch = this._teardownEpoch;
    const work = (async () => {
      const persisted = await this.ctx.storage.transaction(async txn => {
        if (!await this.exitEvidenceIsCurrent(evidence, txn)) return false;
        await txn.put(container.EXIT_OBSERVED_KEY, evidence);
        return true;
      });
      if (!persisted) return;
      await this.reconcileObservedExit({ ownerKey: evidence.owner, sessionId: evidence.session,
        generation: evidence.generation }, () => this._teardownEpoch === epoch, false, 'unknown');
    })();
    this.ctx.waitUntil(work);
    return work;
  }

  private async retryObservedExit(
    reason: 'platform' | 'unknown' = 'unknown',
    onObservation?: (incidentId: string | null) => void,
    expected?: MetricsPin,
  ): Promise<boolean> {
    const pending = this.pendingExit;
    if (pending) {
      const persisted = await this.ctx.storage.transaction(async (txn) => {
        if (await txn.get<number>('lifecycleGeneration') !== pending.generation
            || await txn.get<string>('bucketName') !== pending.owner
            || await txn.get<string>(SESSION_ID_KEY) !== pending.session) return false;
        await txn.put(container.EXIT_OBSERVED_KEY, pending);
        return true;
      });
      if (this.pendingExit === pending) this.pendingExit = null;
      if (!persisted) return false;
    }
    const evidence = await this.ctx.storage.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
    if (!evidence) return false;
    const { owner, session, generation } = evidence;
    if (!await this.exitEvidenceIsCurrent(evidence)) {
      await this.ctx.storage.transaction(async (txn) => {
        const stored = await txn.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
        if (stored?.generation === generation && stored.owner === owner && stored.session === session
            && stored.terminationIntentId === evidence.terminationIntentId
            && !await this.exitEvidenceIsCurrent(evidence, txn)) {
          await txn.delete(container.EXIT_OBSERVED_KEY);
        }
      });
      return false;
    }
    const matchesExpected = !expected || (expected.ownerKey === owner
      && expected.sessionId === session && expected.generation === generation);
    const confirmed = await confirmMonitoredExit(this.ctx, this.env, owner, session, generation,
      matchesExpected ? reason : 'unknown', matchesExpected ? onObservation : undefined, evidence.terminationIntentId);
    let superseded = false;
    if (!confirmed) {
      const current = await new D1SessionRepository(this.env.USAGE_DB).getSession(owner, session);
      if (current?.lifecycleState !== 'stopped' || current.lifecycleGeneration !== generation) {
        superseded = evidence.terminationIntentId !== undefined && (!current
          || current.lifecycleGeneration !== generation || current.lifecycleState !== 'stopping'
          || current.terminationGeneration !== generation || current.terminationIntentId !== evidence.terminationIntentId);
        if (!superseded) return false;
      }
    }
    await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
      if (stored?.generation === generation && stored.owner === owner && stored.session === session
          && stored.terminationIntentId === evidence.terminationIntentId) {
        await txn.delete(container.EXIT_OBSERVED_KEY);
      }
    });
    if (superseded || await this.ctx.storage.get<number>('lifecycleGeneration') !== generation) return false;
    await this.recordHermesSettlement(session, generation);
    this.monitoredGeneration = generation;
    return true;
  }

  /** Share captured retry context without a logging-only authority read. */
  private async reconcileObservedExit(
    pin: MetricsPin | undefined,
    current: () => boolean,
    replaceSchedule = false,
    reason?: 'platform' | 'unknown',
  ): Promise<boolean> {
    let incidentId: string | null = null;
    let retry = false;
    try {
      // A deliberate Stop erased the operational keys used to restore a metrics
      // pin. Its durable positive evidence is sufficient to address retries.
      if (!pin) {
        const evidence = await this.ctx.storage.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
        if (evidence?.terminationIntentId !== undefined) {
          pin = { ownerKey: evidence.owner, sessionId: evidence.session, generation: evidence.generation };
        }
      }
      if (await this.retryObservedExit(reason ?? 'unknown', observed => { incidentId = observed; }, pin)) return true;
      const evidence = await this.ctx.storage.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
      retry = reason !== undefined || (!!evidence && evidence.generation === pin?.generation);
    } catch {
      this.logger.warn('Container exit confirmation retry failed', {
        sessionId: pin?.sessionId ?? null, lifecycleGeneration: pin?.generation ?? null,
        incidentId, errorClass: 'exit_confirmation_failed',
      });
      retry = true;
    }
    if (!retry || !pin) return false;
    if (current()) {
      const schedule = async () => {
        if (replaceSchedule) this.deleteSchedules('collectMetrics');
        await this.schedule(60, 'collectMetrics', pin);
      };
      const logFailure = () => this.logger.error('Container exit retry alarm unavailable', undefined, {
        sessionId: pin.sessionId, lifecycleGeneration: pin.generation, incidentId, errorClass: 'schedule_failed',
      });
      try { await schedule(); }
      catch (error) {
        logFailure();
        // Preserve the existing warm monitor/metrics second chance for a transient scheduler failure.
        if (current() && (replaceSchedule || reason !== undefined)) {
          try { await schedule(); }
          catch (retryError) { logFailure(); throw retryError; }
        } else throw error;
      }
    }
    return true;
  }

  private async monitorExistingRuntime(verifiedByPort = false, expected?: MetricsPin): Promise<void> {
    const runtime = this.ctx.container;
    const owner = this._bucketName;
    const session = this._sessionId;
    const epoch = this._teardownEpoch;
    const current = () => this.ctx.container === runtime && this._teardownEpoch === epoch
      && this._bucketName === owner && this._sessionId === session;
    if (!runtime || !this._bucketName || !this._sessionId) return;
    const generation = await this.ctx.storage.get<number>('lifecycleGeneration');
    if (!current() || !generation || !Number.isSafeInteger(generation)
        || (expected && (expected.ownerKey !== owner || expected.sessionId !== session || expected.generation !== generation))
        || this.monitoredGeneration === generation
        || (await this.ctx.storage.get<ExitEvidence>(container.EXIT_OBSERVED_KEY))?.generation === generation) return;
    if (!runtime.running && !verifiedByPort) {
      const token = await this.ctx.storage.get<string>('containerAuthToken');
      if (!token) return;
      try {
        const response = await runtime.getTcpPort(8080).fetch('http://container/health', {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
      } catch { return; } // Probe failure cannot establish process exit.
    }
    if (await this.ctx.storage.get<number>('lifecycleGeneration') !== generation || !current() || !owner || !session) return;
    this.monitoredGeneration = generation;
    const recordExit = (reason: 'platform' | 'unknown') => {
      if (this.pendingExit && this.pendingExit.generation > generation) return;
      this.pendingExit = { owner, session, generation };
      // Own finite work after positive exit observation, not the monitor's lifetime.
      this.ctx.waitUntil(this.reconcileObservedExit(
        { ownerKey: owner, sessionId: session, generation }, current, false, reason));
    };
    try {
      const exit = runtime.monitor();
      void exit.then(() => recordExit('unknown'), error => {
        // Trust explicit exit messages from this attached monitor, including rollouts.
        // Bare numbers, no-instance and transport failures are not proof here.
        const exitCode = error instanceof Error
          ? /^(?:container exited with unexpected exit code:|runtime signalled the container to exit(?: due to a new version rollout)?:)\s*(\d+)$/i.exec(error.message)?.[1]
          : undefined;
        if (exitCode !== undefined && Number.isSafeInteger(Number(exitCode)) && Number(exitCode) >= 0) {
          recordExit(error instanceof Error && /^runtime signalled the container to exit due to a new version rollout:/i.test(error.message)
            ? 'platform' : 'unknown');
          return;
        }
        if (this.monitoredGeneration === generation) this.monitoredGeneration = null;
        this.logger.warn('Container monitor failed', { sessionId: session, lifecycleGeneration: generation,
          incidentId: null, errorClass: 'monitor_failed' });
      });
    } catch {
      this.monitoredGeneration = null;
      this.logger.warn('Container monitor registration failed', { sessionId: session, lifecycleGeneration: generation,
        incidentId: null, errorClass: 'monitor_registration_failed' });
    }
  }

  private _configurationRunning = false;
  private _bucketStorageTail: Promise<void> = Promise.resolve();

  /** One deployment task authority; an interrupted task may only resume its identical input. */
  async configureDeployment(input: SetupConfigurationInput): Promise<Response> {
    const refused = (error: string) => new Response(JSON.stringify({ done: true, success: false, error }) + '\n', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
    if (this._configurationRunning) return refused('Setup configuration is already in progress. Please wait and try again.');
    this._configurationRunning = true;
    let handedOff = false;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson({ body: input.body, workerName: getWorkerNameFromHostname(input.requestUrl, this.env.CLOUDFLARE_WORKER_NAME) })));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const key = 'setup:admission';
      const prior = await this.ctx.storage.get<{ token: string; fingerprint: string }>(key);
      if (prior && prior.fingerprint !== fingerprint) return refused('An interrupted setup task requires recovery. Retry the same configuration before starting a different configuration.');
      const token = prior?.token ?? crypto.randomUUID();
      await this.ctx.storage.put(key, { token, fingerprint });
      const response = runSetupConfiguration({ ...input, env: this.env }, {
        waitUntil: task => this.ctx.waitUntil(task),
        settled: async (successful, terminalFailure = false) => {
          try {
            // A fresh definite failure permits correction. A retained uncertain
            // task still needs successful same-input convergence, not a later validation failure.
            if (successful || (terminalFailure && !prior)) await this.ctx.storage.transaction(async txn => {
              if ((await txn.get<{ token: string }>(key))?.token === token) await txn.delete(key);
            });
          } finally { this._configurationRunning = false; }
        },
      });
      handedOff = true;
      return response;
    } finally {
      if (!handedOff) this._configurationRunning = false;
    }
  }

  /** DO-local async exclusion; the operation and provider response settle before its successor. */
  private async serializeBucketStorage<T>(operation: () => Promise<T>): Promise<T> {
    const before = this._bucketStorageTail;
    let release!: () => void;
    this._bucketStorageTail = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { return await operation(); }
    finally { release(); }
  }

  private async bindBucketStorageOwner(bucketName: string): Promise<void> {
    const owner = await this.ctx.storage.get<string>('storage:owner');
    if (owner && owner !== bucketName) throw new Error('Bucket storage owner mismatch');
    if (!owner) await this.ctx.storage.put('storage:owner', bucketName);
  }

  async runBucketMultipart(operation: BucketMultipartOperation | Request): Promise<Response> {
    // Request bodies use the existing streaming RPC transport, preserving the HTTP part-size envelope.
    const input = operation instanceof Request ? await operation.json() as BucketMultipartOperation : operation;
    const error = validateBucketNameInput({ bucketName: input.bucketName });
    if (error) throw new Error(error);
    return this.serializeBucketStorage(async () => {
      await this.bindBucketStorageOwner(input.bucketName);
      try { return await performBucketMultipart(this.env, this.ctx.storage, input); }
      catch (cause) {
        if (cause instanceof AppError) return Response.json(cause.toJSON(), { status: cause.statusCode });
        throw cause;
      }
    });
  }

  async retryBucketMigration(bucketName: string, haltedAt: string): Promise<Response> {
    const error = validateBucketNameInput({ bucketName });
    if (error) throw new Error(error);
    return this.serializeBucketStorage(async () => {
      await this.bindBucketStorageOwner(bucketName);
      const refuse = (message: string) => Response.json({ code: 'MIGRATION_RETRY_BLOCKED', error: message }, { status: 409 });
      const state = await getRegimeState(this.env, bucketName);
      const verified = await this.ctx.storage.get<RegimeState>('multipart:regime');
      if (state.status === 'ready' || !state.halted || state.updatedAt !== haltedAt
        || (verified && verified.generation > state.generation)) {
        return refuse('The migration status changed. Refresh the dashboard before retrying.');
      }
      if (state.leaseExpiresAt && state.leaseExpiresAt > Date.now()) {
        return refuse('Migration work is still finishing. Wait a moment and retry.');
      }
      const target = state.status === 'mixed-recovery' ? state.regime : state.to;
      if (!target || target !== regimeForPolicy(await getR2SsePolicyDisabled(this.env))) {
        return refuse('The storage policy changed. Ask your administrator to restore the migration target before retrying.');
      }
      if (!state.keyMd5) {
        return refuse('This migration did not record the original encryption key identity. Ask your administrator to recover the halted migration.');
      }
      try {
        const key = this.env.ENCRYPTION_KEY;
        const fingerprint = key && computeKeyMd5(key);
        if (!fingerprint || fingerprint !== state.keyMd5) {
          return refuse('The original storage encryption key could not be confirmed. Ask your administrator to check the key before retrying.');
        }
      } catch {
        return refuse('The storage encryption key is invalid. Ask your administrator to restore the original key.');
      }
      if (await this.ctx.storage.get(MULTIPART_PENDING_COMPLETION)) {
        return refuse('An upload is awaiting recovery. Resolve it in Storage before retrying migration.');
      }
      try {
        if (await hasOwningSessionContainer(this.env, bucketName)) {
          return refuse('Stop your running sessions before retrying the storage migration.');
        }
      } catch {
        return refuse('Could not confirm that your sessions have stopped. Refresh and retry.');
      }
      // Restart the idempotent scan without clearing the write gate or changing
      // the original direction, key fingerprint, or committed generation.
      await setRegimeState(this.env, bucketName, {
        ...state, halted: false, stuckCount: 0, cursor: null, phase: 'migrate', processed: 0,
        lastFailedKey: undefined, lastError: undefined, leaseExpiresAt: undefined,
      });
      return Response.json({ success: true }, { status: 202 });
    });
  }

  async advanceBucketMigration(bucketName: string): Promise<void> {
    const error = validateBucketNameInput({ bucketName });
    if (error) throw new Error(error);
    await this.serializeBucketStorage(async () => {
      await this.bindBucketStorageOwner(bucketName);
      const verified = await this.ctx.storage.get<RegimeState>('multipart:regime');
      const observed = await getRegimeState(this.env, bucketName);
      if (verified && observed.generation < verified.generation) {
        // Repair an interrupted KV publication from durable verified state, never re-run an older generation.
        await setRegimeState(this.env, bucketName, verified);
        return;
      }
      if (await this.ctx.storage.get(MULTIPART_PENDING_COMPLETION)) {
        this.logger.warn('Multipart completion is uncertain; explicit upload recovery is required before migration');
        return;
      }
      const noOwner = async () => {
        if (await hasOwningSessionContainer(this.env, bucketName)) throw new Error('Session workload owns the bucket');
      };
      await advanceMigrationChunk(this.env, bucketName, {
        drainContainers: noOwner,
        hasHealthyContainer: () => hasOwningSessionContainer(this.env, bucketName),
        beforeReady: ready => this.ctx.storage.put('multipart:regime', ready),
      });
    });
  }

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);

    // Load bucket name from storage on startup and update envVars
    this.ctx.blockConcurrencyWhile(async () => {
      this._bucketName = await this.ctx.storage.get<string>('bucketName') || null;
      this._syncPolicyMode = parseStoredSyncPolicyMode(await this.ctx.storage.get('syncPolicyMode'));
      const storedWorkspaceSyncEnabled = await this.ctx.storage.get<boolean>('workspaceSyncEnabled');
      if (typeof storedWorkspaceSyncEnabled === 'boolean') {
        this._workspaceSyncEnabled = storedWorkspaceSyncEnabled;
      }
      const storedFastStartEnabled = await this.ctx.storage.get<boolean>('fastStartEnabled');
      if (typeof storedFastStartEnabled === 'boolean') {
        this._fastStartEnabled = storedFastStartEnabled;
      }
      this._tabConfig = await this.ctx.storage.get<TabConfig[]>('tabConfig') || null;
      const storedSessionWorkspace = await this.ctx.storage.get<SessionWorkspace>('sessionWorkspace');
      this._sessionWorkspace = storedSessionWorkspace === 'vscode' ? 'vscode' : 'terminal';
      const storedTerminalMode = await this.ctx.storage.get<TerminalMode>('terminalMode');
      this._terminalMode = storedTerminalMode === 'herdr' ? 'herdr' : 'classic';
      this._sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY) || null;
      const restoredGeneration = await this.ctx.storage.get<number>('lifecycleGeneration');
      this._observedLifecycleGeneration = restoredGeneration !== undefined && Number.isSafeInteger(restoredGeneration) && restoredGeneration >= 0
        ? restoredGeneration : null;
      const restoredPin = this._bucketName && this._sessionId && Number.isSafeInteger(restoredGeneration)
        ? { ownerKey: this._bucketName, sessionId: this._sessionId, generation: restoredGeneration! } : undefined;
      this._usageSeconds = await this.ctx.storage.get<number>('usageSeconds') || 0;
      this._userEmail = await this.ctx.storage.get<string>('userEmail') || null;
      // Back-compat: older sessions persisted a single string under 'userGroup'.
      // Prefer the new 'userGroups' list; fall back to coercing the legacy scalar
      // to a one-element array so an in-flight session keeps its attribution.
      const storedGroups = await this.ctx.storage.get<string[]>('userGroups');
      if (Array.isArray(storedGroups)) {
        this._userGroups = storedGroups;
      } else {
        const legacy = await this.ctx.storage.get<string>('userGroup');
        this._userGroups = legacy ? [legacy] : [];
      }
      // REQ-ENTERPRISE-005 (revised): restore the dynamic-route config so a DO wake
      // re-emits the entrypoint env (matches the userGroups / userEmail pattern).
      this._routeCatalog = await this.ctx.storage.get<string[]>('routeCatalog') || [];
      this._allowPersonalPiProviders = await this.ctx.storage.get<boolean>('allowPersonalPiProviders') === true;
      this._piDefaultSource = await this.ctx.storage.get<string>('piDefaultSource') === 'pi-native' ? 'pi-native' : 'managed';
      this._defaultRoute = await this.ctx.storage.get<string>('defaultRoute') || null;
      this._defaultReasoning = await this.ctx.storage.get<string>('defaultReasoning') || null;
      this._routeContextWindows = await this.ctx.storage.get<Record<string, number>>('routeContextWindows') || {};
      this._routeReasoningLevels = await this.ctx.storage.get<Record<string, string[]>>('routeReasoningLevels') || {};
      this._modelDisplayNames = await this.ctx.storage.get<Record<string, string>>('modelDisplayNames') || {};
      this._promptCacheTargets = await this.ctx.storage.get<string[]>('promptCacheTargets') || [];
      // REQ-MEM-001 AC4: restore the user's IANA timezone so the capture
      // pipeline's TZ resolution produces wall-clock filenames after a
      // DO wake (matches the pattern for sessionId / userEmail above).
      this._userTimezone = await this.ctx.storage.get<string>('userTimezone') || null;
      // Restore the container auth token from storage. Without this,
      // every DO wake regenerates a fresh UUID via updateEnvVars() while the
      // container process (which may have been hibernated, not restarted)
      // keeps its old CONTAINER_AUTH_TOKEN env var. Result: DO sends
      // `Authorization: Bearer Y`, container compares against old `X` →
      // `{"error":"Unauthorized"}` on every proxied request until the user
      // recreates the session manually.
      this._containerAuthToken = await this.ctx.storage.get<string>('containerAuthToken') || null;
      // REQ-VAULT-008 AC1: restore the per-session vault key on wake.
      // Generation is lazy (ensureVaultKey()); restore is eager so the
      // Worker /.config proxy can hand it out without ever waiting for
      // a write on the request path.
      this._vaultKey = await this.ctx.storage.get<string>('vaultKey') || null;

      // Restore user-configured idle timeout (survives DO resets).
      // Storage key remains 'sleepAfter' for backwards compat with existing sessions.
      const storedIdleTimeout = await this.ctx.storage.get<string>('sleepAfter');
      if (storedIdleTimeout && /^(5m|15m|30m|1h|2h|4h|8h|12h)$/.test(storedIdleTimeout)) {
        this.idleTimeoutPref = storedIdleTimeout;
      }

      // Resolve R2 config via shared helper (env vars first, KV fallback)
      try {
        const r2Config = await getR2Config(this.env);
        this._r2AccountId = r2Config.accountId;
        this._r2Endpoint = r2Config.endpoint;
      } catch {
        this.logger.warn('R2 config not available, will use empty values in envVars', {
          errorClass: 'r2_config_unavailable',
        });
      }

      // Resolve strict Gateway egress once (REQ-ENTERPRISE-016 AC1) so buildEnvVars emits
      // placeholder R2 creds and the interception registry wires the catch-all without
      // a per-request KV read. Enterprise unreadable/invalid policy resolves true, keeping
      // strict transport and raw-network denial even if Browser owner-reference lookup fails.
      this._strictEgress = await hasStrictGatewayEgress(this.env);
      // REQ-ENTERPRISE-016: when strict Gateway egress is active, also deny the container
      // raw (non-HTTP) egress at the platform. enableInternet=false leaves only ports
      // 80/443 + Cloudflare DNS available — which the catch-all EgressController carries
      // to the Gateway — so raw TCP/UDP (SSH, arbitrary sockets, WireGuard/MASQUE) is
      // fail-closed at the boundary the container cannot manipulate. Left at the platform
      // default (true) when strict is off / non-enterprise, so every other mode is
      // byte-identical to today.
      if (this._strictEgress) this.enableInternet = false;

      // Operator restrictions and package resources are restored before env construction
      // or a later pre-start interception pass. No credential or authority is persisted.
      const [storedPackageResources, storedAttachments] = await Promise.all([
        this.ctx.storage.get<unknown>('operatorPackageResources'),
        this.ctx.storage.get<unknown>('operatorAttachments'),
      ]);
      if (storedPackageResources != null) {
        this._operatorPackageResources = parseOperatorPackageResourceProjection(storedPackageResources);
      }
      if (storedAttachments != null) this._operatorAttachments = parseOperatorAttachmentProjection(storedAttachments);
      await contextRestoreOperatorContext(this.operatorContextHost);
      if (this._operatorContainerProfile) this.enableInternet = false;

      if (this._bucketName) {
        this.logger.info('Loaded bucket name from storage', { bucketName: this._bucketName });
        await refreshMcpPortalConfiguration(this.host);
        this.updateEnvVars();
      }
      const restoration = (async () => {
        if (await this.reconcileObservedExit(restoredPin, () => true)) return;
        await this.monitorExistingRuntime();
      })();
      this.ctx.waitUntil(restoration);
      // Keep startup usable while the required operation retains its DO-owned rejection.
      await restoration.catch(() => undefined);
    });
  }

  /** This DO as the ContainerHost surface the config/router helpers consume. */
  private get host(): ContainerHost { return this as unknown as ContainerHost; }

  /** This DO as the LifecycleHost surface the lifecycle helpers consume. */
  private get lifecycleHost(): LifecycleHost { return this as unknown as LifecycleHost; }

  /** This DO as the InterceptionHost surface the interception registry consumes. */
  private get interceptionHost(): InterceptionHost { return this as unknown as InterceptionHost; }

  /** This DO as the durable operator context surface. */
  private get operatorContextHost(): OperatorContextHost { return this as unknown as OperatorContextHost; }

  /**
   * Parent-only RPC: commit exact owner/activity restrictions before startup.
   * Child requests cannot reach this typed DO method through the HTTP router.
   */
  async configureOperatorContext(profile: unknown, authority: JwtStampingAuthority): Promise<void> {
    await contextConfigureOperatorContext(this.operatorContextHost, profile, authority);
    this.enableInternet = false;
  }

  /** Persist inert, digest-bound package bytes before context/start. */
  async configureOperatorResources(input: unknown): Promise<void> {
    const projection = await verifyOperatorPackageResourceProjection(input);
    await this.ctx.storage.put('operatorPackageResources', projection);
    this._operatorPackageResources = structuredClone(projection);
    this.updateEnvVars();
  }

  /** Persist activity-owned opaque attachment declarations before startup. */
  async configureOperatorAttachments(input: unknown): Promise<void> {
    const projection = parseOperatorAttachmentProjection(input);
    await this.ctx.storage.put('operatorAttachments', projection);
    this._operatorAttachments = structuredClone(projection);
    this.updateEnvVars();
  }

  /** Rebind current exact-human authority after wake without persisting the JWT. */
  bindOperatorAuthority(authority: JwtStampingAuthority): void {
    contextBindOperatorAuthority(this.operatorContextHost, authority);
  }

  /** Parent-only restricted stop: never invokes the ordinary whole-home final bisync lane. */
  async stopOperatorSession(activityId: string, sessionId: string): Promise<'stopped' | 'unknown'> {
    const profile = this._operatorContainerProfile;
    if (!profile || profile.activityId !== activityId || profile.sessionId !== sessionId) {
      throw new Error('Operator session ownership mismatch');
    }
    try {
      await this.superDestroy();
      return 'stopped';
    } catch {
      return 'unknown';
    }
  }

  /** Historical RPC remains fail-closed; application timers now belong to Registry. */
  async armRenovateScan(_input: unknown): Promise<{ ok: false }> {
    return { ok: false };
  }

  /** Consume an old scheduled callback without rediscovery, replay or rearming. */
  async scanRenovate(_delivered?: unknown): Promise<void> {}

  /** Set the bucket name for this container (called by worker on first access). */
  async setBucketName(name: string, r2Creds?: SetBucketNameCreds): Promise<void> {
    await configSetBucketName(this.host, name, r2Creds);
  }

  /** Get the bucket name. */
  getBucketName(): string | null {
    return configGetBucketName(this.host);
  }

  /** Strongly consistent ownership arbitration for one derived R2 bucket. */
  async claimBucketOwner(email: string, allowInitialClaim: boolean): Promise<'owned' | 'conflict' | 'ambiguous'> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || normalizedEmail !== email) return 'conflict';

    return this.ctx.storage.transaction(async (txn) => {
      const owner = await txn.get<string>('bucketOwnerEmail');
      if (owner === normalizedEmail) return 'owned';
      if (owner) return 'conflict';
      if (!allowInitialClaim) return 'ambiguous';

      await txn.put('bucketOwnerEmail', normalizedEmail);
      return 'owned';
    });
  }

  private mcpCleanupActive = false;
  private hermesRetention?: HermesRetention;

  private async recordHermesSettlement(sessionId: string, generation: number): Promise<void> {
    try {
      await this.ctx.storage.transaction(async txn => {
        if (!await txn.get<boolean>(HERMES_DIRECT_LAYOUT_KEY)) return;
        const audit = await txn.get<{ outcome: string; sessionId: string; lifecycleGeneration: number }>(FINAL_SYNC_AUDIT_KEY);
        if (audit?.outcome === 'completed' && audit.sessionId === sessionId && audit.lifecycleGeneration === generation
          && generation > (await txn.get<number>(HERMES_SETTLED_GENERATION_KEY) ?? 0)) {
          await txn.put(HERMES_SETTLED_GENERATION_KEY, generation);
        }
      });
    } catch { /* Lack of a receipt defers retention, never ordinary lifecycle. */ }
  }

  async hermesWriterExited(bucket: string, writer: HermesWriter): Promise<boolean> {
    const { sessionId, generation } = writer;
    if (!SESSION_ID_PATTERN.test(sessionId) || !Number.isSafeInteger(generation) || generation < 1
      || this.env.CONTAINER.idFromName(`${bucket}-${sessionId}`).toString() !== this.ctx.id.toString()) return false;
    const session = await new D1SessionRepository(this.env.USAGE_DB).getSession(bucket, sessionId);
    // A later generation can only be claimed from confirmed stopped state.
    return !!session && (session.lifecycleGeneration > generation
      || (session.lifecycleGeneration === generation && session.lifecycleState === 'stopped'));
  }

  async hermesWriterSettled(bucket: string, writer: HermesWriter): Promise<boolean> {
    const { sessionId, generation } = writer;
    if (!SESSION_ID_PATTERN.test(sessionId)
      || this.env.CONTAINER.idFromName(`${bucket}-${sessionId}`).toString() !== this.ctx.id.toString()) return false;
    if (await this.ctx.storage.get<number>(HERMES_SETTLED_GENERATION_KEY) === generation) return true;
    const audit = await this.ctx.storage.get<{ outcome: string; sessionId: string; lifecycleGeneration: number }>(FINAL_SYNC_AUDIT_KEY);
    if (audit?.outcome !== 'completed' || audit.sessionId !== sessionId || audit.lifecycleGeneration !== generation) return false;
    return this.hermesWriterExited(bucket, writer);
  }

  async admitHermesStore(bucket: string, writer: HermesWriter, remoteCuration: boolean, deadline: number,
    hadDirectLayout: boolean): Promise<HermesAdmission | 'legacy'> {
    if (!SESSION_ID_PATTERN.test(writer.sessionId) || !Number.isSafeInteger(writer.generation)) return 'deferred';
    await this.verifyMcpOwner(bucket);
    const remaining = Math.min(CONTAINER_POLL_BUDGET_MS, deadline - Date.now());
    if (remaining <= 0 || this.mcpCleanupActive) return 'deferred';
    const signal = AbortSignal.timeout(remaining);
    const regime = await getRegimeState(this.env, bucket);
    if (regime.status !== 'ready') return 'deferred';
    const { endpoint } = await getR2Config(this.env);
    const r2 = hermesRetentionR2(this.env, endpoint, bucket, regime.regime === 'plain', signal);
    const retention = this.hermesRetention ??= new HermesRetention(this.ctx.storage);
    const current = () => new D1SessionRepository(this.env.USAGE_DB).getSession(bucket, writer.sessionId);
    const canAdmit = async () => {
      const session = await current();
      return !signal.aborted && !this.mcpCleanupActive && session?.lifecycleState === 'starting'
        && session.lifecycleGeneration === writer.generation && !session.terminationIntentId;
    };
    if (!await canAdmit()) return 'deferred';
    if (remoteCuration) {
      const installed = await r2.adapterDigest();
      if (installed === HERMES_MASTER_ADAPTER || installed === HERMES_CHECKPOINT_ADAPTER) {
        if (hadDirectLayout || await retention.hasStore(writer.sessionId)
          || (installed === HERMES_MASTER_ADAPTER
            && (writer.generation !== 1 || await r2.hasCheckpoint(writer.sessionId)))) return 'deferred';
        return await canAdmit() ? 'legacy' : 'deferred';
      }
      const baked = AGENTS_SEEDED_CONFIGS.find(file => file.key === HERMES_ADAPTER_KEY && file.modes.includes('advanced'));
      if (!baked || createHash('sha256').update(baked.content).digest('hex') !== installed) return 'deferred';
    }
    const writerEvidence = async (prior: HermesWriter, method: 'hermesWriterExited' | 'hermesWriterSettled') => {
      const id = this.env.CONTAINER.idFromName(`${bucket}-${prior.sessionId}`);
      const owner = this.env.CONTAINER.get(id) as unknown as Pick<container, typeof method>;
      return (await raceBudget(owner[method](bucket, prior), Math.max(1, deadline - Date.now()))) === true;
    };
    return retention.admit(writer, {
      canAdmit,
      inventory: r2.inventory,
      observe: r2.observe,
      prefixEmpty: r2.prefixEmpty,
      writerExited: prior => writerEvidence(prior, 'hermesWriterExited'),
      writerSettled: prior => writerEvidence(prior, 'hermesWriterSettled'),
      evict: async prefix => {
        const [before, admitted] = await Promise.all([getRegimeState(this.env, bucket), canAdmit()]);
        if (!admitted || signal.aborted || before.status !== 'ready' || before.generation !== regime.generation) {
          return 'not-started';
        }
        return r2.evict(prefix);
      },
    }, signal);
  }

  private async verifyMcpOwner(owner: string, email?: string): Promise<void> {
    if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(owner)
      || !this.ctx.id.equals(this.env.CONTAINER.idFromName(`bucket-owner:${owner}`))) {
      throw new Error('MCP owner identity mismatch');
    }
    const claimed = await this.ctx.storage.get<string>('bucketOwnerEmail');
    if (!claimed || claimed !== claimed.trim().toLowerCase()
      || (email !== undefined && (typeof email !== 'string' || email.trim().toLowerCase() !== claimed))) {
      throw new Error('MCP owner identity mismatch');
    }
  }

  async mcpPortalRead(owner: string, portalName: string) {
    await this.verifyMcpOwner(owner);
    return new McpPortalState(this.ctx.storage).read(portalName);
  }
  async mcpPortalImport(owner: string, portalName: string, expected: McpFence, ciphertext: string) {
    await this.verifyMcpOwner(owner);
    return new McpPortalState(this.ctx.storage).import(portalName, expected, ciphertext);
  }
  async mcpPortalSavePending(owner: string, input: McpPendingInput) {
    await this.verifyMcpOwner(owner);
    return new McpPortalState(this.ctx.storage).savePending(input);
  }
  async mcpPortalConsumePending(owner: string, state: string, binding?: McpCallbackBinding) {
    await this.verifyMcpOwner(owner);
    if (binding && (typeof binding.instance !== 'string' || (binding.issuer !== undefined && typeof binding.issuer !== 'string'))) {
      throw new Error('Invalid MCP callback binding');
    }
    return new McpPortalState(this.ctx.storage).consumePending(state, binding ? async pending => {
      const payload = await decryptMcpRecord<{ instance: string; discovery: { authorizationServerUrl: string } }>(this.env,
        mcpRecordContext(owner, pending.fence.epoch, 'pending', state), pending.ciphertext);
      return !!payload && payload.instance === binding.instance
        && (!binding.issuer || payload.discovery?.authorizationServerUrl === binding.issuer);
    } : undefined);
  }
  async mcpPortalPublish(owner: string, portalName: string, expected: McpFence, ciphertext: string) {
    await this.verifyMcpOwner(owner);
    return new McpPortalState(this.ctx.storage).publish(portalName, expected, ciphertext);
  }
  async mcpPortalDisconnect(owner: string, portalName: string) {
    await this.verifyMcpOwner(owner);
    return new McpPortalState(this.ctx.storage).disconnect(portalName);
  }
  async mcpPortalBeginOffboarding(owner: string, email: string) {
    await this.verifyMcpOwner(owner, email);
    if (this.mcpCleanupActive) throw new AppError('user_cleanup_incomplete', 503, 'User cleanup already in progress');
    return new McpPortalState(this.ctx.storage).beginOffboarding();
  }
  async mcpPortalCompleteOffboarding(owner: string, operationId: string) {
    await this.verifyMcpOwner(owner);
    if (this.mcpCleanupActive) return false;
    return new McpPortalState(this.ctx.storage).completeOffboarding(operationId);
  }
  async cleanupOwnedUser(owner: string, email: string): Promise<CleanupResult> {
    // Set before the first await: another live deletion cannot outlast this one
    // and erase a newly provisioned account after its completion.
    const admitted = !this.mcpCleanupActive;
    try {
      if (!admitted) throw new AppError('user_cleanup_incomplete', 503, 'User cleanup already in progress');
      this.mcpCleanupActive = true;
      await this.verifyMcpOwner(owner, email);
      const state = new McpPortalState(this.ctx.storage);
      let operationId: string | undefined;
      const result = await runOwnedUserCleanup(email.trim().toLowerCase(), owner, this.env, async () => {
        operationId = (await state.beginOffboarding()).operationId;
      });
      if (!operationId || !await state.completeOffboarding(operationId)) {
        throw new AppError('user_cleanup_incomplete', 503, 'User cleanup completion could not be confirmed');
      }
      return result;
    } catch (error) {
      // RPC preserves Error.message, not custom AppError fields. Carry only the
      // existing cleanup error contract; the public wrapper restores its type.
      if (error instanceof AppError) {
        throw new Error(`MCP_USER_CLEANUP:${JSON.stringify({ code: error.code, statusCode: error.statusCode,
          message: error.message, userMessage: error.userMessage })}`);
      }
      throw error;
    } finally {
      // Failure releases only live exclusion. Durable admission stays closed.
      if (admitted) this.mcpCleanupActive = false;
    }
  }

  /** Owner metadata only: request-owned Root authority; never starts a container. */
  async dispatcherSdkCredentials(scope: SdkStorageScope, body: unknown,
    authority: SdkCredentialAuthority): Promise<DispatcherSdkCredentialResult> {
    try {
      if (!scope || typeof scope.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(scope.bucket)
        || typeof scope.email !== 'string' || !scope.email || scope.email !== scope.email.trim().toLowerCase()
        || !this.ctx.id.equals(this.env.CONTAINER.idFromName(`bucket-owner:${scope.bucket}`))
        || await this.ctx.storage.get<string>('bucketOwnerEmail') !== scope.email) {
        throw new DispatcherSdkStorageError(403);
      }
      const provider = body && typeof body === 'object' && 'providerId' in body ? String(body.providerId) : '';
      const prior = this.#sdkCredentialQueues.get(provider) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      this.#sdkCredentialQueues.set(provider, pending);
      let modification: Promise<unknown> = Promise.resolve();
      try {
        await prior;
        return { ok: true, value: await handleDispatcherSdkCredentials(this.ctx.storage, this.env, scope, body, authority,
          pending => { modification = pending; }) };
      } finally {
        // getAuth may return on abort while SDK's 15s refresh still runs.
        // Keep serialization until it settles, without retaining write authority.
        this.ctx.waitUntil(modification.catch(() => undefined).then(() => {
          release();
          if (this.#sdkCredentialQueues.get(provider) === pending) this.#sdkCredentialQueues.delete(provider);
        }));
      }
    } catch (error) {
      if (!(error instanceof DispatcherSdkStorageError)) throw error;
      // Custom exception properties do not survive RPC propagation. Keep the
      // intentional status and existing private error detail in plain data.
      const status = error.status === 409 || error.status === 413 ? error.status : 403;
      const captured = captureRawValue(error);
      // RPC requires ordinary objects, not the safe snapshot's null-prototype dictionaries.
      const cause = captured && typeof captured === 'object' && Object.hasOwn(captured, 'cause')
        ? { cause: JSON.parse(JSON.stringify((captured as Record<string, unknown>).cause)) } : {};
      return { ok: false, status, message: error.message, stack: error.stack, ...cause,
        ...(error.authFailure ? { authFailure: error.authFailure } : {}) };
    }
  }

  /** Update envVars with current bucket name and credentials. */
  private updateEnvVars(): void {
    configUpdateEnvVars(this.host);
  }

  /** Operator-context callback; public only to the extracted trusted helper. */
  refreshEnv(): void {
    this.updateEnvVars();
  }

  /**
   * REQ-VAULT-008 AC1: Return the per-session vault encryption key,
   * generating + persisting on the first call. See container-config.ts
   * ensureVaultKey for the full forward-secrecy + race-guard rationale.
   * Worker callers reach this method via a DO RPC from the /.config
   * proxy handler (REQ-VAULT-008 AC3).
   */
  async ensureVaultKey(): Promise<string> {
    return configEnsureVaultKey(this.host);
  }

  private async admitsPiWeb(url: URL, headers: Headers): Promise<boolean> {
    const sessionId = piWebSessionId(url.pathname);
    const bucket = this._bucketName;
    const generation = Number(headers.get(PI_WEB_GENERATION_HEADER));
    const epoch = this._teardownEpoch;
    const stillOwned = () => this._bucketName === bucket && this._sessionId === sessionId
      && !this._operatorContainerProfile && !this._operatorPolicy && this._teardownEpoch === epoch
      && !this._shutdownStartedAt && !this.sessionStopInFlight && !this.sessionKillInFlight;
    if (!bucket || !sessionId || !stillOwned() || !Number.isSafeInteger(generation) || generation < 1
      || headers.get(PI_WEB_GENERATION_HEADER) !== String(generation)
      || !matchesPiWebGeneration(url.pathname, sessionId, generation)
      || headers.get('X-Forwarded-Host') !== url.host
      || headers.get('X-Forwarded-Proto') !== url.protocol.slice(0, -1)) return false;
    const session = await new D1SessionRepository(this.env.USAGE_DB).getSession(bucket, sessionId);
    if (!session || session.lifecycleState !== 'running' || session.lifecycleGeneration !== generation
      || session.terminationIntentId || session.boundaryActivityId || !isPiWebEligible(session)) return false;
    const [storedGeneration, shutdown] = await Promise.all([
      this.ctx.storage.get<number>('lifecycleGeneration'), this.ctx.storage.get(SHUTDOWN_REQUESTED_KEY),
    ]);
    return storedGeneration === generation && shutdown == null && stillOwned();
  }

  /** Parent-only passive app dispatch. The two authority checks still bracket I/O. */
  async forwardPiWebRead(request: Request, authority: PiWebReadAuthority): Promise<Response> {
    const url = new URL(request.url);
    if (typeof authority?.bucket !== 'string' || typeof authority.sessionId !== 'string'
      || typeof authority.email !== 'string' || !authority.email || !Number.isSafeInteger(authority.generation) || authority.generation < 1
      || piWebSessionId(url.pathname) !== authority.sessionId
      || !url.pathname.startsWith(piWebAppPrefix(authority.sessionId, authority.generation))
      || request.headers.get(PI_WEB_GENERATION_HEADER) !== String(authority.generation)
      || (request.method !== 'GET' && request.method !== 'HEAD') || request.headers.has('Upgrade')) {
      return Response.json({ error: 'Invalid Pi web app read' }, { status: 400 });
    }
    const epoch = this._teardownEpoch;
    const stillOwned = () => this._bucketName === authority.bucket && this._sessionId === authority.sessionId
      && this._userEmail?.toLowerCase() === authority.email.toLowerCase() && this._teardownEpoch === epoch
      && !this._operatorContainerProfile && !this._operatorPolicy && !this._shutdownStartedAt
      && !this.sessionStopInFlight && !this.sessionKillInFlight;
    try {
      const ordinary = await getPersonalPiSession(this.interceptionHost, authority, true);
      if (ordinary.generation !== authority.generation || !stillOwned()) {
        return Response.json({ error: 'Pi web generation changed' }, { status: 409 });
      }
    } catch (error) {
      if (error instanceof AppError) return Response.json(error.toJSON(), { status: error.statusCode });
      throw error;
    }
    return this.forwardExistingPort(request, undefined, stillOwned);
  }

  /** Low-level port forwarding cannot start a replacement or trust stale SDK state. */
  async forwardExisting(request: Request, loggingContext?: OperatorLoggingContext): Promise<Response> {
    return this.forwardExistingPort(request, loggingContext);
  }

  private async forwardExistingPort(request: Request, loggingContext?: OperatorLoggingContext,
    stillOwned?: () => boolean): Promise<Response> {
    const token = await this.ctx.storage.get<string>('containerAuthToken');
    if (!this.ctx.container || !token) return new Response('Existing container unavailable', { status: 503 });
    try {
      // The private port accepts HTTP only. Preserve the public request's path,
      // query, method and upgrade headers, but never forward its HTTPS origin.
      const url = new URL(request.url);
      const piWeb = isPiWebPath(url.pathname);
      if (piWeb && (!await this.admitsPiWeb(url, request.headers) || (stillOwned && !stillOwned()))) {
        return Response.json({ error: 'Pi web lifecycle no longer authorized' }, { status: 409 });
      }
      const privateUrl = new URL('http://container');
      privateUrl.pathname = url.pathname;
      privateUrl.search = url.search;
      const forwarded = new Request(privateUrl, request);
      forwarded.headers.delete('x-codeflare-operator-logging');
      if (loggingContext && typeof loggingContext === 'object'
        && Object.keys(loggingContext).length === 3
        && Object.keys(loggingContext).every(key => ['activityId', 'generation', 'loggingEnabled'].includes(key))
        && typeof loggingContext.activityId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(loggingContext.activityId)
        && Number.isSafeInteger(loggingContext.generation) && loggingContext.generation > 0
        && typeof loggingContext.loggingEnabled === 'boolean' && request.method === 'POST'
        && (url.pathname === '/operator-inference' || url.pathname === '/operator-inference/profile')
        && !url.search && !url.hash
        && request.headers.get('x-codeflare-operator-activity') === loggingContext.activityId
        && request.headers.get('x-codeflare-operator-generation') === String(loggingContext.generation)) {
        forwarded.headers.set('x-codeflare-operator-logging', loggingContext.loggingEnabled ? 'on' : 'off');
      }
      forwarded.headers.set('Authorization', `Bearer ${token}`);
      // `running` can itself transiently read false after DO reconstruction.
      // Only an answer from the existing private port proves it survived.
      const response = await this.ctx.container.getTcpPort(8080).fetch(forwarded);
      if (response.ok && this.monitoredGeneration === null) {
        // A port answer can establish survival even while the SDK running flag
        // is stale. Attach exit observation without delaying the response.
        void this.monitorExistingRuntime(true).catch(error => {
          this.logger.warn('Container monitor attachment unavailable', { error: toErrorMessage(error) });
        });
      }
      return response;
    } catch (error) {
      this.logger.warn('Existing container port unavailable', { error: toErrorMessage(error) });
      return new Response('Existing container unavailable', { status: 503 });
    }
  }

  /**
   * The private port hands back an unaccepted socket. Returning it directly
   * leaves nothing in this object listening, so it dies when the Durable
   * Object shuts down at an alarm boundary. Accept both ends here so the
   * object owns the relay (same pattern as the Containers SDK, not imported
   * because that path would start the container).
   */
  private relayWebSocket(containerResponse: Response, options: { terminalKeepalive: boolean }): Response {
    const containerWs = containerResponse.webSocket;
    if (!containerWs) return containerResponse;
    containerWs.accept();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Reserved codes cannot be sent. Keep the existing final-close policy
    // except for abnormal terminal upstream loss, handled below.
    const sendableCode = (code: number): number => (code === 1005 || code === 1006 ? 1000 : code);
    const closeQuietly = (socket: WebSocket, code: number, reason: string): void => {
      try {
        socket.close(code, reason);
      } catch {
        // Already closed by the other direction.
      }
    };
    const forward = async (target: WebSocket, data: string | ArrayBuffer | Blob): Promise<void> => {
      try {
        target.send(data instanceof Blob ? await data.arrayBuffer() : data);
      } catch {
        // Target closed mid-flight; its close event handles teardown.
      }
    };

    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stopKeepalive = (): void => {
      if (keepalive === undefined) return;
      clearInterval(keepalive);
      keepalive = undefined;
    };
    if (options.terminalKeepalive) {
      // Pending work from the heartbeat keeps the object alive across alarm boundaries.
      keepalive = setInterval(() => {
        try {
          containerWs.send(JSON.stringify({ type: 'heartbeat' }));
        } catch {
          // Container end closed; its close event stops this timer.
        }
      }, TERMINAL_KEEPALIVE_MS);
    }

    containerWs.addEventListener('message', event => { void forward(server, event.data); });
    server.addEventListener('message', event => { void forward(containerWs, event.data); });
    containerWs.addEventListener('close', event => {
      // Terminal transport loss must remain retryable under the existing error
      // policy. IDE and client-originated close behavior stay unchanged.
      const code = options.terminalKeepalive && event.code === 1006 ? 1011 : sendableCode(event.code);
      closeQuietly(server, code, event.reason);
    });
    server.addEventListener('close', event => closeQuietly(containerWs, sendableCode(event.code), event.reason));
    containerWs.addEventListener('error', () => closeQuietly(server, 1011, 'container-socket-error'));
    server.addEventListener('error', () => closeQuietly(containerWs, 1011, 'client-socket-error'));
    for (const socket of [containerWs, server]) {
      socket.addEventListener('close', stopKeepalive);
      socket.addEventListener('error', stopKeepalive);
    }

    return new Response(null, { status: 101, webSocket: client, headers: containerResponse.headers });
  }

  /** Override fetch to handle internal routes via typed dispatch (CF-016). */
  override async fetch(request: Request): Promise<Response> {
    // Ordinary ingress cannot manufacture the separate admitted RPC context.
    if (request.headers.has('x-codeflare-operator-logging')) {
      const headers = new Headers(request.headers);
      headers.delete('x-codeflare-operator-logging');
      request = new Request(request, { headers });
    }
    // WebSocket responses cannot cross the DO RPC serialization boundary.
    // Stub.fetch has native WebSocket response transport; keep terminal and IDE
    // sockets on the same no-start private-port forwarding used for health probes.
    const pathname = new URL(request.url).pathname;
    if (isPiWebPath(pathname) || ((pathname === '/terminal' || pathname.startsWith('/api/vscode/')) &&
        request.headers.get('Upgrade')?.toLowerCase() === 'websocket')) {
      const forwarded = await this.forwardExisting(request);
      return forwarded.webSocket ? this.relayWebSocket(forwarded, { terminalKeepalive: pathname === '/terminal' }) : forwarded;
    }
    if (pathname === '/_internal/setBucketName' && request.method === 'POST') {
      return this.configureSessionStart(request);
    }
    const internal = dispatchInternalRoute(this.host, request);
    if (internal) return internal;

    // Sync now and ordinary HTTP requests may reach the existing private port
    // but cannot enter the SDK's implicit start path. A false running hint at
    // this inner gate is retryable, not authoritative 4503.
    if (!this.ctx.container?.running) {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(1013, 'container-state-transient');
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return new Response(JSON.stringify({ error: 'Container not running' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!this._containerAuthToken) {
      return new Response(JSON.stringify({ error: 'Container authorization unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return this.forwardExisting(request);
  }

  /**
   * D1 is the shared lifecycle authority (REQ-SESSION-018). onStart projects
   * the current generation and arms metrics; onStop/onError are SDK observations
   * that may be synthetic or transient and cannot alone declare exit. The
   * low-level process monitor resolves on exit and confirms only its captured
   * generation. User Stop/Delete await destruction before confirming D1 stopped.
   * Idle/quota stop signals are not exit proof. Bounded transport recovery
   * preserves ownership if it cannot establish whether a process survived.
   */
  /** Called when the container starts successfully. */
  override async onStart(): Promise<void> {
    const launch = this.sessionStartInFlight;
    if (!launch) {
      await lifecycleOnStart(this.lifecycleHost, undefined, this._operatorContainerProfile !== undefined);
      await this.monitorExistingRuntime();
      return;
    }
    if (launch.cancellation.signal.aborted) return;
    const pin = { ownerKey: launch.bucket, sessionId: launch.sessionId, generation: launch.generation };
    try {
      await lifecycleOnStart(this.lifecycleHost, pin);
      await this.monitorExistingRuntime(false, pin);
      launch.startup.ready = true;
    } catch {
      // The SDK runs this hook inside blockConcurrencyWhile. Reject the RPC
      // after the hook returns, without resetting the DO and its pending Stop.
    }
  }

  /**
   * Wire outbound-HTTPS interception BEFORE the container boots.
   *
   * REQ-ENTERPRISE-004: `interceptOutboundHttps` must be registered before the
   * SDK calls `container.start()`, so the platform mounts the ephemeral
   * Cloudflare containers CA at `/etc/cloudflare/certs/` in time for
   * entrypoint.sh to install it into the trust store. Wiring it in `onStart()`
   * — which fires AFTER the container has booted and the entrypoint has already
   * run its CA-trust block — was too late: the entrypoint found no cert, skipped
   * trust, and every agent's intercepted-TLS handshake to api.openai.com then
   * failed with "Connection error" (the interceptor was never even reached).
   * The SDK also applies its own pre-start interception. Ordinary Start and the
   * separate Operator path both prepare interception before invoking the SDK.
   *
   * Which transports wire (and their guards) is data-driven: see the registry
   * in container-interception.ts. Enterprise mode registers its transports even
   * without Gateway configuration; affected requests then fail closed. The OAuth api.cloudflare.com
   * transport (REQ-AGENT-078) is a no-op unless this is a non-enterprise
   * "Connect to Cloudflare" session (detected by the injected OAuth placeholder).
   */
  override async startAndWaitForPorts(
    ...args: Parameters<Container<Env>['startAndWaitForPorts']>
  ): Promise<void> {
    if (this.sessionStartInFlight) throw new Error('Another session start is in progress');
    await this.prepareNativeStart();
    await super.startAndWaitForPorts(...args);
  }

  private async prepareNativeStart(): Promise<void> {
    await refreshMcpPortalConfiguration(this.host);
    this.updateEnvVars();
    await wireContainerInterception(this.interceptionHost);
  }

  private async configureSessionStart(request: Request): Promise<Response> {
    const conflict = () => Response.json({ error: 'Session configuration no longer authorized' }, { status: 412 });
    const value = request.headers.get('X-Codeflare-Start-Generation');
    if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return conflict();
    const body = await request.clone().json().catch(() => null) as {
      bucketName?: unknown; sessionId?: unknown; surface?: unknown; sessionWorkspace?: SessionWorkspace; tabConfig?: TabConfig[]; terminalMode?: TerminalMode;
    } | null;
    const { bucketName, sessionId } = body ?? {};
    const surface = PiSurfaceSchema.optional().safeParse(body?.surface);
    if (!surface.success) return Response.json({ error: 'Invalid Pi surface' }, { status: 400 });
    if (typeof bucketName !== 'string' || typeof sessionId !== 'string'
      || this.env.CONTAINER.idFromName(`${bucketName}-${sessionId}`).toString() !== this.ctx.id.toString()) return conflict();
    if (this.sessionConfigurationInFlight || this.sessionStartInFlight || this.sessionStopInFlight || this.sessionKillInFlight) return conflict();
    const completion = Promise.resolve().then(async () => {
      const repository = new D1SessionRepository(this.env.USAGE_DB);
      const current = await repository.getSession(bucketName, sessionId);
      if (!current || current.lifecycleGeneration !== Number(value) || current.terminationIntentId
        || current.lifecycleState === 'starting' || current.lifecycleState === 'stopping'
        || this.sessionStopInFlight || this.sessionKillInFlight || this._operatorContainerProfile
        || (this._bucketName && this._bucketName !== bucketName) || (this._sessionId && this._sessionId !== sessionId)) return conflict();
      if (surface.data && (current.boundaryActivityId || this._operatorPolicy || !isPiWebEligible(current)
        || !body?.tabConfig || !isPiWebEligible({
          agentType: current.agentType, workspace: body.sessionWorkspace, tabConfig: body.tabConfig, terminalMode: body.terminalMode,
        }))) {
        return conflict();
      }
      if (current.lifecycleState === 'stopped') {
        if (this.ctx.container?.running) return conflict();
      } else if (!this._bucketName || await this.ctx.storage.get<number>('lifecycleGeneration') !== current.lifecycleGeneration) {
        return conflict();
      }
      if (this.sessionStopInFlight || this.sessionKillInFlight) return conflict();
      const response = await dispatchInternalRoute(this.host, request)!;
      if (current.lifecycleState !== 'stopped' || (response.status !== 200 && response.status !== 409)) return response;
      if (this._bucketName !== bucketName || this._sessionId !== sessionId) return conflict();
      // Keep configuration and the claim under the same reservation. A second
      // request for the previous generation cannot overwrite the winner's config.
      await this.ctx.storage.put(SESSION_LAUNCH_GENERATION_KEY, current.lifecycleGeneration + 1);
      if (this.sessionStopInFlight || this.sessionKillInFlight) return conflict();
      const claimed = await repository.start(bucketName, sessionId, new Date().toISOString(), current.lifecycleGeneration);
      if (!claimed) return conflict();
      // Own the launch before acknowledgement. It waits for this configuration
      // reservation to settle, but does not depend on its RPC caller returning.
      void this.launchSession({ bucket: bucketName, sessionId, generation: claimed.lifecycleGeneration }, surface.data).catch(() => {
        this.logger.warn('Session start not confirmed', { sessionId, lifecycleGeneration: claimed.lifecycleGeneration });
      });
      const headers = new Headers(response.headers);
      headers.set('X-Codeflare-Start-Claim', String(claimed.lifecycleGeneration));
      return new Response(response.body, { status: response.status, headers });
    }).finally(() => { this.sessionConfigurationInFlight = undefined; });
    this.sessionConfigurationInFlight = completion;
    this.ctx.waitUntil(completion);
    return completion;
  }

  /** Join the DO-owned Start; an RPC arriving after completion cannot re-dispatch it. */
  async startSession(input: SessionStopRequest): Promise<void> {
    const { bucket, sessionId, generation } = input;
    const launch = this.sessionStartInFlight;
    if (launch?.bucket === bucket && launch.sessionId === sessionId && launch.generation === generation) {
      return launch.completion;
    }
    const current = await new D1SessionRepository(this.env.USAGE_DB).getSession(bucket, sessionId);
    if (this._bucketName !== bucket || this._sessionId !== sessionId
      || current?.lifecycleGeneration !== generation || current.lifecycleState !== 'running' || current.terminationIntentId) {
      throw new Error('Session start not confirmed');
    }
  }

  private async launchSession(input: SessionStopRequest, surface?: PiSurface): Promise<void> {
    const { bucket, sessionId, generation } = input;
    if (this.env.CONTAINER.idFromName(`${bucket}-${sessionId}`).toString() !== this.ctx.id.toString()) {
      throw new Error('Session start address mismatch');
    }
    if (this.sessionStartInFlight) throw new Error('Session lifecycle operation is in progress');
    const cancellation = new AbortController();
    const startup = { ready: false };
    const epoch = this._teardownEpoch;
    const repository = new D1SessionRepository(this.env.USAGE_DB);
    const stillAdmitted = async () => {
      const session = await repository.getSession(bucket, sessionId);
      if (cancellation.signal.aborted || this._teardownEpoch !== epoch
          || this._bucketName !== bucket || this._sessionId !== sessionId
          || session?.lifecycleGeneration !== generation || session.lifecycleState !== 'starting'
          || session.terminationIntentId) throw new Error('Session start superseded');
    };
    const configure = this.sessionConfigurationInFlight;
    const completion = Promise.resolve().then(async () => {
      await configure;
      await stillAdmitted();
      await this.prepareNativeStart();
      if (this._sessionMode === 'advanced') {
        const budget = CONTAINER_POLL_BUDGET_MS;
        const deadline = Date.now() + budget;
        const disposition = await raceBudget((async () => {
          const hadDirectLayout = (await this.ctx.storage.get<boolean>(HERMES_DIRECT_LAYOUT_KEY)) === true;
          return getBucketOwnerStub(this.env, bucket).admitHermesStore(bucket, { sessionId, generation },
            this._remoteCurationActive, deadline, hadDirectLayout);
        })(), budget).catch(() => null);
        if (disposition === 'new' || disposition === 'existing') {
          await this.ctx.storage.put(HERMES_DIRECT_LAYOUT_KEY, true);
        }
        this.envVars = { ...this.envVars, CODEFLARE_HERMES_PERSISTENCE: disposition ?? 'deferred',
          CODEFLARE_HERMES_GENERATION: String(generation) };
      }
      await stillAdmitted();
      if (this.ctx.container?.running) throw new Error('Unexpected existing session process');
      if (surface) {
        this.envVars = { ...this.envVars, CODEFLARE_PI_SURFACE: surface, CODEFLARE_PI_GENERATION: String(generation) };
      }
      await super.startAndWaitForPorts({ cancellationOptions: { abort: cancellation.signal } });
      if (cancellation.signal.aborted || !startup.ready) throw new Error('Session start not confirmed');
    }).finally(() => { this.sessionStartInFlight = undefined; });
    this.sessionStartInFlight = { ...input, cancellation, startup, completion };
    this.ctx.waitUntil(completion);
    await completion;
  }

  private async quiesceSessionStart(): Promise<void> {
    const launch = this.sessionStartInFlight;
    const configure = this.sessionConfigurationInFlight;
    if (!launch && !configure) return;
    launch?.cancellation.abort();
    // SDK 0.3.7 can already be past a cancellation check before native launch.
    // Wait for any outstanding launch or configuration before destroying.
    const settled = await raceBudget(Promise.allSettled([launch?.completion, configure]), CONTAINER_POLL_BUDGET_MS);
    if (!settled) throw new Error('Session start has not settled; retry termination');
  }

  async collectMetrics(delivered?: MetricsPin): Promise<void> {
    const epoch = this._teardownEpoch;
    const runtime = this.ctx.container;
    // Exit-only retries cannot require an operational identity or runtime: Stop
    // deliberately cleared them before dispatching native destruction.
    const evidence = await this.ctx.storage.get<ExitEvidence>(container.EXIT_OBSERVED_KEY);
    if (this._teardownEpoch !== epoch || this.ctx.container !== runtime) return;
    if (evidence?.terminationIntentId !== undefined && (!delivered || (delivered.ownerKey === evidence.owner
        && delivered.sessionId === evidence.session && delivered.generation === evidence.generation))) {
      if (await this.reconcileObservedExit(delivered, () => this._teardownEpoch === epoch, true)) return;
    }
    // Capture generation, native runtime and local teardown epoch before any
    // asynchronous monitor/host observation. A scheduled payload can only join
    // that exact assignment, never the latest generation returned by D1.
    const execution = await captureMetricsExecution(this.ctx, delivered,
      () => this._teardownEpoch === epoch && this.ctx.container === runtime);
    if (!execution || !execution.isCurrent()) return;
    const pin = { ownerKey: execution.ownerKey, sessionId: execution.sessionId, generation: execution.generation };
    // This public call owns its rejection; future callbacks/restoration use waitUntil instead.
    if (await this.reconcileObservedExit(pin, execution.isCurrent, true)) return;
    if (!execution.isCurrent()) return;
    // The metrics observation already probes SDK-false runtimes directly; a
    // second pre-probe here would spend two host budgets on every failure tick.
    if (execution.runtime.running) {
      try { await this.monitorExistingRuntime(false, pin); } catch {
        this.logger.warn('Container monitor attachment unavailable', { sessionId: pin.sessionId,
          lifecycleGeneration: pin.generation, incidentId: null, errorClass: 'monitor_attachment_failed' });
      }
    }
    await lifecycleCollectMetrics(this.lifecycleHost, pin, { ...execution,
      onHostResponse: () => this.monitorExistingRuntime(true, pin) });
  }

  /**
   * Override destroy to drain a final R2 bisync while the container is still
   * running, BEFORE signalling stop (REQ-SESSION-011); the entrypoint trap is
   * only a best-effort backstop. See container-lifecycle.ts destroy() for the
   * full rationale.
   */
  override async destroy(): Promise<void> {
    await this.destroyWithContext();
  }

  private async destroyWithContext(context?: LifecycleLogContext, onNativeExit?: () => Promise<void>): Promise<void> {
    if (this.sessionKillInFlight) {
      await this.sessionKillInFlight.completion;
      return;
    }
    await lifecycleDestroy(this.lifecycleHost, context, onNativeExit,
      (this.sessionStartInFlight || this.sessionConfigurationInFlight) ? () => this.quiesceSessionStart() : undefined);
  }

  /** Own claim through confirmation even if the invoking Worker disconnects. */
  async stopSession(input: SessionStopRequest): Promise<void> {
    if (this.env.CONTAINER.idFromName(`${input.bucket}-${input.sessionId}`).toString() !== this.ctx.id.toString()) {
      throw new Error('Session stop address mismatch');
    }
    const pending = this.sessionStopInFlight;
    if (pending) {
      if (pending.bucket !== input.bucket || pending.sessionId !== input.sessionId || pending.generation !== input.generation) {
        throw new Error('Another session stop generation is in progress');
      }
      await pending.completion;
      return;
    }
    // Capture authority before ownership I/O: even a delayed old D1 reply
    // cannot authorize teardown after KILL or a replacement start supersedes it.
    const epoch = this._teardownEpoch;
    // Register the entire operation before any I/O, including its claim.
    const completion: Promise<void> = Promise.resolve().then(() =>
      lifecycleStopSession(this.env, input, async owned => {
        if (this._teardownEpoch !== epoch) throw new Error('Session stop superseded');
        await this.destroyWithContext({ sessionId: owned.sessionId, lifecycleGeneration: owned.lifecycleGeneration,
          incidentId: owned.unreachableIncidentId ?? null, terminationIntentId: owned.terminationIntentId ?? undefined, reason: 'user' }, () => this.recordNativeStopExit({
            owner: input.bucket, session: input.sessionId, generation: input.generation,
            terminationIntentId: owned.terminationIntentId!,
          }));
        await this.recordHermesSettlement(input.sessionId, input.generation);
      })
    ).finally(() => {
      if (this.sessionStopInFlight?.completion === completion) this.sessionStopInFlight = undefined;
    });
    this.sessionStopInFlight = { ...input, completion };
    this.ctx.waitUntil(completion);
    await completion;
  }

  /** A caller-independent force lane, separate from any blocked graceful Stop. */
  async killSession(input: SessionStopRequest): Promise<void> {
    if (this.env.CONTAINER.idFromName(`${input.bucket}-${input.sessionId}`).toString() !== this.ctx.id.toString()) {
      throw new Error('Session KILL address mismatch');
    }
    const pending = this.sessionKillInFlight;
    if (pending) {
      if (pending.bucket !== input.bucket || pending.sessionId !== input.sessionId || pending.generation !== input.generation) {
        throw new Error('Another session KILL generation is in progress');
      }
      await pending.completion;
      return;
    }
    const completion: Promise<void> = Promise.resolve().then(() =>
      lifecycleKillSession(this.lifecycleHost, input, () => this.quiesceSessionStart()))
      .then(() => {
        const stop = this.sessionStopInFlight;
        if (stop?.bucket === input.bucket && stop.sessionId === input.sessionId && stop.generation === input.generation) {
          this.sessionStopInFlight = undefined;
        }
      }).finally(() => {
        if (this.sessionKillInFlight?.completion === completion) this.sessionKillInFlight = undefined;
      });
    this.sessionKillInFlight = { ...input, completion };
    this.ctx.waitUntil(completion);
    await completion;
  }

  /** Parent-only Enterprise session authority; never exported to container env vars. */
  async bindReviewHuman(input: {
    bucket: string; sessionId: string; generation: number;
    human: VerifiedHumanAccessClaims; accessJwt: string;
  } | null, expected?: Parameters<typeof bindReviewSessionHuman>[2]): Promise<void> {
    await bindReviewSessionHuman(this as unknown as Parameters<typeof bindReviewSessionHuman>[0], input, expected);
  }

  _browserAcquisition?: Promise<string>;

  async getOwnedBrowser(ref: BrowserOwnerReference, operation: BrowserOperation): Promise<string> {
    return ownedBrowser(this.interceptionHost, ref, operation);
  }

  async getPersonalPiSession(ref: { bucket: string; sessionId: string; email: string }, ordinaryOnly = false): Promise<{
    generation: number; groups: string[];
  }> {
    return await getPersonalPiSession(this.interceptionHost, ref, ordinaryOnly);
  }

  async openReviewHuman(ref: { bucket: string; sessionId: string; email: string }): Promise<{
    human: VerifiedHumanAccessClaims; accessJwt: string; generation: number;
  }> {
    return openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], ref);
  }

  /** Join Pi evidence and observed Git success in either arrival order, without starting work. */
  async getReviewLifecycleGeneration(ref: { bucket: string; sessionId: string; email: string }): Promise<number> {
    await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], ref);
    const generation = await this.ctx.storage.get<number>('lifecycleGeneration');
    if (!Number.isSafeInteger(generation) || !generation || generation < 1) throw Error('Lifecycle unavailable');
    return generation;
  }

  private async putReviewEvidence<T extends { generation: number }>(key: string, value: T): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      const [generation, shutdown] = await Promise.all([
        txn.get<number>('lifecycleGeneration'), txn.get('shutdownRequested'),
      ]);
      if (generation !== value.generation || shutdown !== undefined) throw Error('Review lifecycle changed');
      await txn.put(key, value);
    });
  }

  async stageBoundaryInput(value: { sessionId: string; generation: number; input: BoundaryInput;
    owner?: string; repository?: string; ref?: string }): Promise<{
    generation: number; input: BoundaryInput; push: { owner: string; repository: string; ref: string; head: string };
  } | null> {
    if (!this._bucketName || !this._userEmail || value.sessionId !== this._sessionId) {
      throw new Error('Boundary session unavailable');
    }
    const authority = await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], {
      bucket: this._bucketName, sessionId: value.sessionId, email: this._userEmail,
    });
    const input = parseBoundedBoundaryInput(value.input);
    await this.putReviewEvidence('review:boundary-input', {
      sessionId: value.sessionId, generation: value.generation, subject: authority.human.subject, input,
      owner: value.owner, repository: value.repository, ref: value.ref,
    });
    return this.getReadyBoundary({ bucket: this._bucketName, sessionId: value.sessionId,
      email: this._userEmail, generation: value.generation });
  }

  async stagePushEvidence(value: { sessionId: string; generation: number; owner: string; repository: string;
    ref: string; head: string }): Promise<{
    generation: number; input: BoundaryInput; push: { owner: string; repository: string; ref: string; head: string };
  } | null> {
    if (!this._bucketName || !this._userEmail || this._sessionId !== value.sessionId
      || !/^[A-Za-z0-9_.-]+$/.test(value.owner) || !/^[A-Za-z0-9_.-]+$/.test(value.repository)
      || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.ref) || !/^[a-f0-9]{40}$/i.test(value.head)) {
      throw new Error('Invalid push evidence');
    }
    const authority = await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], {
      bucket: this._bucketName, sessionId: value.sessionId, email: this._userEmail,
    });
    await this.putReviewEvidence('review:push-evidence', { ...value, subject: authority.human.subject,
      observedAt: Date.now() });
    return this.getReadyBoundary({ bucket: this._bucketName, sessionId: value.sessionId,
      email: this._userEmail, generation: value.generation });
  }

  async stagePrCreationEvidence(value: { sessionId: string; generation: number; pullRequest: number;
    repositoryId: number; repositoryNodeId: string; pullRequestNodeId: string;
    owner: string; repository: string; head: string;
    headRefName: string; baseRefName: string }): Promise<{
    generation: number; input: BoundaryInput; push: { owner: string; repository: string; ref: string; head: string };
    creation?: { repositoryNodeId: string; pullRequestNodeId: string;
      headRefName: string; baseRefName: string };
  } | null> {
    if (!this._bucketName || !this._userEmail || this._sessionId !== value.sessionId
      || !Number.isSafeInteger(value.pullRequest) || value.pullRequest < 1
      || !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1
      || !/^[A-Za-z0-9_.-]+$/.test(value.owner) || !/^[A-Za-z0-9_.-]+$/.test(value.repository)
      || !/^[a-f0-9]{40}$/i.test(value.head)
      || !/^[A-Za-z0-9_=-]{1,256}$/.test(value.pullRequestNodeId)
      || !/^[A-Za-z0-9_=-]{1,256}$/.test(value.repositoryNodeId)
      || !/^[A-Za-z0-9._/-]{1,200}$/.test(value.headRefName)
      || !/^[A-Za-z0-9._/-]{1,200}$/.test(value.baseRefName)) throw Error('Invalid PR creation evidence');
    const authority = await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], {
      bucket: this._bucketName, sessionId: value.sessionId, email: this._userEmail,
    });
    await this.putReviewEvidence('review:pr-creation', { ...value, subject: authority.human.subject,
      observedAt: Date.now() });
    return this.getReadyBoundary({ bucket: this._bucketName, sessionId: value.sessionId,
      email: this._userEmail, generation: value.generation });
  }

  async getReadyBoundary(ref: { bucket: string; sessionId: string; email: string; generation: number }): Promise<{
    generation: number; input: BoundaryInput; push: { owner: string; repository: string; ref: string; head: string };
    creation?: { repositoryNodeId: string; pullRequestNodeId: string;
      headRefName: string; baseRefName: string };
  } | null> {
    const authority = await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], ref);
    const current = await this.getReviewLifecycleGeneration(ref);
    if (current !== ref.generation) return null;
    const [staged, push, creation] = await Promise.all([
      this.ctx.storage.get<{ sessionId: string; generation: number; subject: string; input: BoundaryInput;
        owner?: string; repository?: string; ref?: string }>('review:boundary-input'),
      this.ctx.storage.get<{ sessionId: string; generation: number; subject: string; owner: string; repository: string;
        ref: string; head: string; observedAt: number }>('review:push-evidence'),
      this.ctx.storage.get<{ sessionId: string; generation: number; subject: string; pullRequest: number;
        repositoryId: number; repositoryNodeId: string; pullRequestNodeId: string;
        owner: string; repository: string; head: string;
        headRefName: string; baseRefName: string; observedAt: number }>('review:pr-creation'),
    ]);
    if (!staged || staged.sessionId !== ref.sessionId || staged.generation !== ref.generation
      || staged.subject !== authority.human.subject) return null;
    if (push && push.sessionId === ref.sessionId && push.generation === ref.generation
      && push.subject === authority.human.subject
      && push.head === staged.input.targetHead && Number.isFinite(push.observedAt)
      && push.observedAt <= Date.now() && push.observedAt >= Date.now() - 5 * 60_000
      && (!staged.owner || staged.owner.toLowerCase() === push.owner.toLowerCase())
      && (!staged.repository || staged.repository.toLowerCase() === push.repository.toLowerCase())) {
      return { generation: ref.generation, input: structuredClone(staged.input), push: {
        owner: push.owner, repository: push.repository, ref: push.ref, head: push.head,
      } };
    }
    if (creation && creation.sessionId === ref.sessionId && creation.generation === ref.generation
      && creation.subject === authority.human.subject
      && creation.pullRequest === staged.input.pullRequest
      && creation.repositoryId === staged.input.repositoryId
      && creation.head === staged.input.targetHead && Number.isFinite(creation.observedAt)
      && creation.observedAt <= Date.now() && creation.observedAt >= Date.now() - 5 * 60_000
      && staged.owner?.toLowerCase() === creation.owner.toLowerCase()
      && staged.repository?.toLowerCase() === creation.repository.toLowerCase()
      && staged.ref === `refs/heads/${creation.headRefName}`) {
      return { generation: ref.generation, input: structuredClone(staged.input), push: {
        owner: creation.owner, repository: creation.repository,
        ref: staged.ref, head: creation.head,
      }, creation: { repositoryNodeId: creation.repositoryNodeId,
        pullRequestNodeId: creation.pullRequestNodeId,
        headRefName: creation.headRefName, baseRefName: creation.baseRefName } };
    }
    return null;
  }

  async getBoundaryInput(ref: { bucket: string; sessionId: string; email: string }): Promise<BoundaryInput | null> {
    const authority = await openReviewSessionHuman(this as unknown as Parameters<typeof openReviewSessionHuman>[0], ref);
    const record = await this.ctx.storage.get<{
      sessionId: string; subject: string; input: BoundaryInput;
    }>('review:boundary-input');
    return record?.sessionId === ref.sessionId && record.subject === authority.human.subject
      ? structuredClone(record.input) : null;
  }

  /** Invoke the superclass destroy (SDK teardown). Used by container-lifecycle. */
  superDestroy(): Promise<void> {
    return super.destroy();
  }

  // Note: we intentionally do NOT override onActivityExpired() anymore. With
  // sleepAfter pinned to 24h the SDK's timer effectively never fires, and
  // collectMetrics() owns all idle-stop decisions. If an idle container does
  // reach the 24h ceiling, the SDK's default onActivityExpired will stop it,
  // which is the correct fallback.

  /** Called when the container stops. */
  override async onStop(): Promise<void> {
    await lifecycleOnStop(this.lifecycleHost);
  }

  /** Called when the container encounters an error. */
  override async onError(error: unknown): Promise<void> {
    await lifecycleOnError(this.lifecycleHost, error);
  }

}
