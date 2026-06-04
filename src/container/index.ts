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
 * and container-lifecycle.ts (onStart/collectMetrics/destroy/onStop/onError).
 */
import { Container } from '@cloudflare/containers';
import type { Env, TabConfig } from '../types';
import { getR2Config } from '../lib/r2-config';
import { toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import {
  validateBucketNameInput,
  type ContainerEnvState,
  type SetBucketNameCreds,
} from './container-env';
import {
  setBucketName as configSetBucketName,
  getBucketName as configGetBucketName,
  updateEnvVars as configUpdateEnvVars,
  ensureVaultKey as configEnsureVaultKey,
  type ContainerHost,
} from './container-config';
import { dispatchInternalRoute } from './container-router';
import {
  onStart as lifecycleOnStart,
  collectMetrics as lifecycleCollectMetrics,
  destroy as lifecycleDestroy,
  onStop as lifecycleOnStop,
  onError as lifecycleOnError,
  type LifecycleHost,
} from './container-lifecycle';

export { validateBucketNameInput };

const SESSION_ID_KEY = '_sessionId';

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
export class container extends Container<Env> implements ContainerEnvState {
  logger = createLogger('container');

  // Port where the container's HTTP server listens
  // Terminal server handles all endpoints: WebSocket, health check, metrics
  defaultPort = 8080;

  // SDK's sleepAfter timer is effectively disabled - we pin it to 24h so the
  // SDK never fires onActivityExpired in practice. The real idle detector is
  // collectMetrics(), which polls the in-container /activity endpoint every 60s
  // and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref.
  //
  // Why: @cloudflare/containers v0.3.5 refreshes the SDK timer on every
  // WebSocket message in both directions (client<->container)
  // (parseTimeExpression('24h') = 86400s). That means the SDK timer tracks
  // "any activity", whereas we want "user-input activity" - a container running
  // `tail -f` or `yes` should still sleep when the user walks away.
  // collectMetrics reads lastInputAt from the in-container terminal server,
  // which tracks PTY input only, giving us the correct semantics independent of
  // the SDK.
  //
  // NOTE: pinning the SDK timer does NOT stop Cloudflare from reaping an idle
  // container instance at the platform level. That reap arrives as onError
  // (the monitor sees the container gone), NOT onActivityExpired/onStop - see
  // the lifecycle contract above onStart(). It is why containers can stop with
  // none of our timeouts having fired.
  override sleepAfter = '24h';

  // User-configured idle timeout (5m/15m/30m/1h/2h). Enforced by collectMetrics,
  // NOT by the SDK. Stored in DO storage under the 'sleepAfter' key for
  // backwards compat with existing sessions created before this refactor.
  //
  // Default is the MAX supported value (2h), not the min. Rationale: this
  // class field is the fallback that wins when (a) the DO is freshly
  // constructed and storage hasn't been populated yet, or (b) a code path
  // skipped the setBucketName flow that writes the user pref. In either
  // case, defaulting LOW would kill the container before the pref could be
  // applied, destroying user work. Defaulting HIGH only lets the container
  // live longer than expected, which is a strictly safer failure mode. The
  // collectMetrics tick re-reads storage as the authoritative source on
  // every fire (60s cadence) so any drift is corrected within one tick.
  idleTimeoutPref: string = '2h';

  // Environment variables - set via property assignment in updateEnvVars()
  // These satisfy the ContainerEnvState interface, so they are not `private`.
  _bucketName: string | null = null;
  _r2AccountId: string | null = null;
  _r2Endpoint: string | null = null;
  _r2AccessKeyId: string | null = null;
  _r2SecretAccessKey: string | null = null;
  _workspaceSyncEnabled: boolean = false;
  _fastStartEnabled: boolean = true;
  _tabConfig: TabConfig[] | null = null;
  _openaiApiKey: string | null = null;
  _geminiApiKey: string | null = null;
  _githubToken: string | null = null;
  _cloudflareApiToken: string | null = null;
  _cloudflareAccountId: string | null = null;
  _encryptionKey: string | null = null;
  _sessionMode: string = 'default';
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
  /** REQ-MEM-001 AC4: user's IANA timezone (e.g. "Europe/Zurich"). */
  _userTimezone: string | null = null;
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
  /** Monotonic usage counter (seconds) - sent to Timekeeper for delta computation */
  _usageSeconds = 0;
  containerStartedAt = 0;
  /** Last seen lastInputAt from /activity - used to detect NEW input for renewal. */
  lastSeenInputAt: number | null = null;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);

    // Load bucket name from storage on startup and update envVars
    this.ctx.blockConcurrencyWhile(async () => {
      this._bucketName = await this.ctx.storage.get<string>('bucketName') || null;
      const storedWorkspaceSyncEnabled = await this.ctx.storage.get<boolean>('workspaceSyncEnabled');
      if (typeof storedWorkspaceSyncEnabled === 'boolean') {
        this._workspaceSyncEnabled = storedWorkspaceSyncEnabled;
      }
      const storedFastStartEnabled = await this.ctx.storage.get<boolean>('fastStartEnabled');
      if (typeof storedFastStartEnabled === 'boolean') {
        this._fastStartEnabled = storedFastStartEnabled;
      }
      this._tabConfig = await this.ctx.storage.get<TabConfig[]>('tabConfig') || null;
      this._sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY) || null;
      this._usageSeconds = await this.ctx.storage.get<number>('usageSeconds') || 0;
      this._userEmail = await this.ctx.storage.get<string>('userEmail') || null;
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
      if (storedIdleTimeout && /^(5m|15m|30m|1h|2h)$/.test(storedIdleTimeout)) {
        this.idleTimeoutPref = storedIdleTimeout;
      }

      // Resolve R2 config via shared helper (env vars first, KV fallback)
      try {
        const r2Config = await getR2Config(this.env);
        this._r2AccountId = r2Config.accountId;
        this._r2Endpoint = r2Config.endpoint;
      } catch (err) {
        this.logger.warn('R2 config not available, will use empty values in envVars', {
          error: toErrorMessage(err),
        });
      }

      if (this._bucketName) {
        this.logger.info('Loaded bucket name from storage', { bucketName: this._bucketName });
        this.updateEnvVars();
      }
    });
  }

  /** This DO as the ContainerHost surface the config/router helpers consume. */
  private get host(): ContainerHost { return this as unknown as ContainerHost; }

  /** This DO as the LifecycleHost surface the lifecycle helpers consume. */
  private get lifecycleHost(): LifecycleHost { return this as unknown as LifecycleHost; }

  /** Set the bucket name for this container (called by worker on first access). */
  async setBucketName(name: string, r2Creds?: SetBucketNameCreds): Promise<void> {
    await configSetBucketName(this.host, name, r2Creds);
  }

  /** Get the bucket name. */
  getBucketName(): string | null {
    return configGetBucketName(this.host);
  }

  /** Update envVars with current bucket name and credentials. */
  private updateEnvVars(): void {
    configUpdateEnvVars(this.host);
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

  /** Override fetch to handle internal routes via typed dispatch (CF-016). */
  override async fetch(request: Request): Promise<Response> {
    const internal = dispatchInternalRoute(this.host, request);
    if (internal) return internal;

    // Note on POST /internal/bisync-trigger (REQ-STOR-015): the Worker
    // fan-out at /api/sessions/sync calls this DO with that path. It is
    // intentionally NOT in the internal route table (no leading underscore)
    // so it falls through to the standard forward path below: the DO
    // injects the container auth token and super.fetch() routes it to
    // the host server's matching handler. The 503 short-circuit on a
    // hibernated container is the hibernation-safety guarantee for the
    // Sync-now feature - no DO-side state, no daemon-PID cache, all
    // decisions made at call time against ctx.container?.running.

    // Reject non-internal requests when the container is not running.
    // This prevents WebSocket reconnect attempts from waking a hibernated
    // container via super.fetch() (which triggers the SDK's startIfNotRunning).
    // The DO knows the container state authoritatively - no KV read needed.
    if (!this.ctx.container?.running) {
      // WS upgrade: accept then close with custom code 4503 so the client
      // can distinguish "container stopped" from network errors (1006).
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(4503, 'container-stopped');
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return new Response(JSON.stringify({ error: 'Container not running' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use super.fetch() for reliable container proxying (handles startup
    // readiness, WebSocket upgrades, and container networking). The SDK's
    // sleepAfter timer is pinned to 24h (see class field comment) and plays
    // no role in idle detection - collectMetrics() owns that decision.
    if (this._containerAuthToken) {
      const authedRequest = new Request(request, {
        headers: new Headers(request.headers),
      });
      authedRequest.headers.set('Authorization', `Bearer ${this._containerAuthToken}`);
      return super.fetch(authedRequest);
    }
    return super.fetch(request);
  }

  /**
   * CONTAINER LIFECYCLE + KV STATUS CONTRACT
   * (canonical reference - collectMetrics() and kv-keys.ts point here)
   *
   * KV `status` ('running' | 'stopped') is the single source of truth the
   * dashboard reads (REQ-SESSION-010). Keeping it accurate is the job of these
   * hooks. @cloudflare/containers v0.3.5 invokes them as follows:
   *
   *   onStart()            container is up -> write 'running'; (re)arm the
   *                        collectMetrics alarm loop.
   *   onStop(params)       GRACEFUL stop ONLY - reached via stop() / destroy()
   *                        or the SDK's default onActivityExpired -> write
   *                        'stopped'. (this._shutdownStartedAt is set only by
   *                        destroy(), so onStop's shutdownElapsedMs is non-null
   *                        ONLY for a user Stop/Delete; null for other stops.)
   *   onError(error)       UNEXPECTED exit caught by the SDK container monitor:
   *                        a process crash, a Worker code DEPLOY that resets the
   *                        DO ("Durable Object reset because its code was
   *                        updated") and rolls the running container, or
   *                        Cloudflare reaping an idle container at the platform
   *                        level. The SDK does NOT call onStop here, so without
   *                        an exit-writes-stopped path the session would dangle
   *                        'running' forever (codeflare#153). onError does NOT
   *                        write 'stopped' directly, though: it ALSO fires on
   *                        TRANSIENT errors where the container is actually alive
   *                        (a deploy-roll the container survives, a brief monitor
   *                        blip), and an immediate write there flips a live
   *                        session to stopped and then sticks (REQ-SESSION-018
   *                        AC3). Instead onError opens the not-running
   *                        confirmation window and re-arms collectMetrics, which
   *                        confirms a genuine exit to 'stopped' within the window
   *                        and clears it on recovery. Empirically onError is the
   *                        COMMON way idle containers die: over a 96h prod sample
   *                        onActivityExpired fired 0x and the idle-stop 3x, while
   *                        onError fired on every unexpected exit (including a
   *                        near-daily ~00:00 UTC platform reap and any deploy
   *                        that lands while a session is live).
   *   onActivityExpired()  SDK sleepAfter timer (pinned to 24h, see the
   *                        `sleepAfter` field) -> default stop() -> onStop.
   *                        Effectively never fires; collectMetrics owns idle.
   *   destroy()            user Stop/Delete -> graceful SIGTERM -> onStop.
   *
   * There is NO legacy 30-minute (or any other) hard idle timeout anywhere -
   * a recurring misconception. The only idle stops we own are collectMetrics'
   * idle-stop at idleTimeoutPref (default 2h, logs "idle exceeded threshold")
   * and the in-container PTY reaper (PTY_KEEPALIVE_MS, a 2h safety net). A
   * container can still vanish well before any of those via onError
   * (deploy / platform reap), which is unrelated to any configured timeout.
   */
  /** Called when the container starts successfully. */
  override async onStart(): Promise<void> {
    await lifecycleOnStart(this.lifecycleHost);
  }

  async collectMetrics(): Promise<void> {
    await lifecycleCollectMetrics(this.lifecycleHost);
  }

  /**
   * Override destroy to drain a final R2 bisync while the container is still
   * running, BEFORE signalling stop (REQ-SESSION-011); the entrypoint trap is
   * only a best-effort backstop. See container-lifecycle.ts destroy() for the
   * full rationale.
   */
  override async destroy(): Promise<void> {
    await lifecycleDestroy(this.lifecycleHost);
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
