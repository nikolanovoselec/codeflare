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
 */
import { Container } from '@cloudflare/containers';
import type { Env, TabConfig } from '../types';
import { getR2Config } from '../lib/r2-config';
import { toError, toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import {
  validateBucketNameInput,
  buildEnvVars,
  applyBucketName,
  applyPrefsOnRestart,
  type ContainerEnvState,
  type SetBucketNameCreds,
} from './container-env';
import {
  collectMetrics as doCollectMetrics,
  updateKvStatus,
  type MetricsState,
  type MetricsCallbacks,
} from './container-metrics';

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
export class container extends Container<Env> implements ContainerEnvState {
  private logger = createLogger('container');

  // Port where the container's HTTP server listens
  // Terminal server handles all endpoints: WebSocket, health check, metrics
  defaultPort = 8080;

  // SDK's sleepAfter timer is effectively disabled - we pin it to 24h so the
  // SDK never fires onActivityExpired in practice. The real idle detector is
  // collectMetrics(), which polls the in-container /activity endpoint every 60s
  // and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref.
  //
  // Why: @cloudflare/containers v0.2.x refreshes the SDK timer on every
  // WebSocket message in both directions (client↔container). That means the
  // SDK timer tracks "any activity", whereas we want "user-input activity" -
  // a container running `tail -f` or `yes` should still sleep when the user
  // walks away. collectMetrics reads lastInputAt from the in-container
  // terminal server, which tracks PTY input only, giving us the correct
  // semantics independent of the SDK.
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
   */
  private _vaultKey: string | null = null;
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
   */
  private _shutdownStartedAt = 0;
  /** Monotonic usage counter (seconds) - sent to Timekeeper for delta computation */
  private _usageSeconds = 0;
  private containerStartedAt = 0;
  /** Last seen lastInputAt from /activity - used to detect NEW input for renewal. */
  private lastSeenInputAt: number | null = null;

  // Map-based dispatch for internal routes
  private readonly internalRoutes: Map<string, (request: Request) => Promise<Response> | Response>;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);

    // Initialize internal route dispatch table
    this.internalRoutes = new Map<string, (request: Request) => Promise<Response> | Response>([
      ['POST:/_internal/setBucketName', (request) => this.handleSetBucketName(request)],
      ['PUT:/_internal/setSessionId', (request) => this.handleSetSessionId(request)],
      ['GET:/_internal/getBucketName', () => this.handleGetBucketName()],
    ]);
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

  /** Env-related state for sub-module functions. */
  private get envState(): ContainerEnvState { return this; }

  /** Metrics-related state for sub-module functions. */
  private get metricsState(): MetricsState { return this as unknown as MetricsState; }

  /** Set the bucket name for this container (called by worker on first access). */
  async setBucketName(name: string, r2Creds?: SetBucketNameCreds): Promise<void> {
    await applyBucketName(this.envState, name, this.env, this.ctx.storage, r2Creds);
    this.updateEnvVars();
  }

  /** Get the bucket name. */
  getBucketName(): string | null {
    return this._bucketName;
  }

  /** Update envVars with current bucket name and credentials. */
  private updateEnvVars(): void {
    // Generate the container auth token on first need, then persist it so
    // a subsequent DO wake restores the same value (the container's env
    // var CONTAINER_AUTH_TOKEN, set when the container started, survives
    // hibernation; the DO's in-memory copy does not, so re-generating here
    // produces a token mismatch - see the restore in blockConcurrencyWhile).
    // ctx.waitUntil pins the put to the request lifecycle so the runtime
    // cannot hibernate the DO before the storage write commits; without
    // that pin, a wake-then-immediately-hibernate sequence could regenerate
    // a fresh token on the next wake even after this branch ran.
    if (!this._containerAuthToken) {
      this._containerAuthToken = crypto.randomUUID();
      // Promise.resolve() wrap: in production ctx.storage.put returns a
      // Promise per the Workers Runtime API, but some test mocks return
      // undefined synchronously. Wrapping makes `.catch` safe in both.
      const putPromise = Promise.resolve(
        this.ctx.storage.put('containerAuthToken', this._containerAuthToken),
      ).catch((err) => {
        this.logger.warn('Failed to persist containerAuthToken', { error: toErrorMessage(err) });
      });
      // waitUntil is unavailable on some test mocks of ctx; guard so unit
      // tests that don't stub it don't crash. Production always has it.
      if (typeof this.ctx.waitUntil === 'function') {
        this.ctx.waitUntil(putPromise);
      }
    }

    this.envVars = buildEnvVars(this.envState, this.env);
  }

  /**
   * REQ-VAULT-008 AC1: Return the per-session vault encryption key,
   * generating + persisting on the first call. The key is 32 random
   * bytes, base64-encoded so SilverBullet can use it as a string token
   * in BootConfig. Repeated calls return the cached value -- no extra
   * storage writes.
   *
   * The key is wiped only on container.destroy(); a DO hibernation +
   * wake cycle restores the same key from ctx.storage (see the
   * blockConcurrencyWhile restore branch). This is the guarantee that
   * deletion is forward-secret: once destroy() runs, the key is gone
   * everywhere and the browser's IDB ciphertext is unrecoverable.
   *
   * Worker callers reach this method via a DO RPC from the /.config
   * proxy handler (REQ-VAULT-008 AC3).
   */
  async ensureVaultKey(): Promise<string> {
    if (this._vaultKey) return this._vaultKey;

    // Critical-section body: re-check cache, restore from storage,
    // mint on first miss, and PERSIST INLINE before returning. Must
    // run inside blockConcurrencyWhile so a concurrent second caller
    // queued behind the first sees the persisted key on its own
    // storage.get (REQ-VAULT-008 AC1). The put MUST be awaited inside
    // the critical section - using waitUntil would let the block exit
    // before the write commits, defeating the guard.
    const mintAndPersist = async (): Promise<string> => {
      if (this._vaultKey) return this._vaultKey;
      const existing = await this.ctx.storage.get<string>('vaultKey');
      if (existing) {
        this._vaultKey = existing;
        return existing;
      }
      // No cached key -- mint one. crypto.getRandomValues is the
      // WebCrypto entry point available on the Workers runtime.
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      // Convert to base64 without Buffer (not available on Workers).
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const key = btoa(binary);
      // Promise.resolve wrap matches the containerAuthToken pattern:
      // production returns a real Promise but some test mocks return
      // undefined synchronously, so awaiting the bare call would NPE
      // without the wrap.
      //
      // CRITICAL: do NOT swallow persistence errors. If storage.put
      // silently fails, we would return `key` to the caller (the
      // Worker injects it into BootConfig, browser encrypts IDB with
      // it), then on the next DO wake the storage.get(key) returns
      // null and we mint a fresh key - permanently breaking IDB
      // decryption. Better to throw and force the caller to retry.
      try {
        await Promise.resolve(this.ctx.storage.put('vaultKey', key));
      } catch (err) {
        // Clear the in-memory mint so the next call retries instead
        // of returning a key we know was never persisted.
        this._vaultKey = null;
        const wrapped = err instanceof Error ? err : new Error(toErrorMessage(err));
        this.logger.error('Failed to persist vaultKey', wrapped);
        throw new Error(`ensureVaultKey: storage.put failed: ${toErrorMessage(err)}`);
      }
      this._vaultKey = key;
      return key;
    };

    // Race guard: two concurrent first-callers must NOT both mint
    // distinct keys. blockConcurrencyWhile serialises the full
    // get + mint + put sequence so the second caller's storage.get
    // sees the first caller's persisted key. Without this the browser
    // could be handed key A while storage retains key B, permanently
    // breaking IDB decryption on the next DO wake.
    const blocker = this.ctx.blockConcurrencyWhile;
    if (typeof blocker === 'function') {
      let result = '';
      await blocker.call(this.ctx, async () => {
        result = await mintAndPersist();
      });
      return result;
    }
    // Test mocks without blockConcurrencyWhile: best-effort, no guard.
    return mintAndPersist();
  }

  /** Override fetch to handle internal routes via map-based dispatch. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routeKey = `${request.method}:${url.pathname}`;
    const handler = this.internalRoutes.get(routeKey);
    if (handler) return handler(request);

    // Note on POST /internal/bisync-trigger (REQ-STOR-015): the Worker
    // fan-out at /api/sessions/sync calls this DO with that path. It is
    // intentionally NOT in the internalRoutes map (no leading underscore)
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

  /** Handle POST /_internal/setBucketName. */
  private async handleSetBucketName(request: Request): Promise<Response> {
    try {
      const { bucketName, sessionId, userEmail, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint, workspaceSyncEnabled, fastStartEnabled, tabConfig, openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId, encryptionKey, sessionMode, userTimezone, sleepAfter: sleepAfterPref } =
        await request.json() as {
          bucketName: string;
          sessionId?: string;
          userEmail?: string;
          r2AccessKeyId?: string;
          r2SecretAccessKey?: string;
          r2AccountId?: string;
          r2Endpoint?: string;
          workspaceSyncEnabled?: boolean;
          fastStartEnabled?: boolean;
          tabConfig?: TabConfig[];
          openaiApiKey?: string;
          geminiApiKey?: string;
          githubToken?: string;
          cloudflareApiToken?: string;
          cloudflareAccountId?: string;
          encryptionKey?: string;
          sessionMode?: string;
          // REQ-MEM-001 AC4: user's IANA timezone forwarded by the Worker
          // from preferences.userTimezone. applyBucketName persists it and
          // buildEnvVars surfaces it to the container as USER_TIMEZONE;
          // entrypoint.sh applies the three-artifact contract (export TZ,
          // /etc/timezone, /etc/localtime symlink).
          userTimezone?: string;
          sleepAfter?: string;
        };

      // FIX-28: Idempotency - once bucket name is set, reject subsequent calls.
      // But always store sessionId so collectMetrics/onStop can find the KV entry
      // (sessionId may be missing if the DO was created before SESSION_ID_KEY existed).
      if (this._bucketName) {
        // Update user preferences on restart even though bucket is already set.
        // Without this, preference changes made between sessions are lost.
        const prefsChanged = await applyPrefsOnRestart(this.envState, this.ctx.storage, {
          sessionId, userEmail, workspaceSyncEnabled, fastStartEnabled, tabConfig,
          openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId,
          encryptionKey, sessionMode, userTimezone,
        });

        // Update idle timeout on restart. Storage key is 'sleepAfter' for
        // backwards compat; the SDK's sleepAfter property is pinned to 24h.
        if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
          this.idleTimeoutPref = sleepAfterPref;
          await this.ctx.storage.put('sleepAfter', sleepAfterPref);
        }

        if (prefsChanged) {
          this.updateEnvVars();
        }

        return new Response(JSON.stringify({ error: 'Bucket name already set' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // FIX-15: Validate inputs
      const validationError = validateBucketNameInput({
        bucketName, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint,
        workspaceSyncEnabled, fastStartEnabled, sessionMode,
      });
      if (validationError) {
        return new Response(JSON.stringify({ error: validationError }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Store sessionId BEFORE setBucketName - updateEnvVars() inside
      // setBucketName reads this._sessionId to populate SESSION_ID env var
      if (sessionId) {
        await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
        this._sessionId = sessionId;
      }

      // Store user email for Timekeeper pings
      if (userEmail) {
        await this.ctx.storage.put('userEmail', userEmail);
        this._userEmail = userEmail;
      }

      await this.setBucketName(bucketName, {
        r2AccessKeyId,
        r2SecretAccessKey,
        r2AccountId,
        r2Endpoint,
        workspaceSyncEnabled,
        fastStartEnabled,
        tabConfig,
        openaiApiKey,
        geminiApiKey,
        githubToken,
        cloudflareApiToken,
        cloudflareAccountId,
        encryptionKey,
        sessionMode,
        userTimezone,
      });

      // Apply user-configurable idle timeout (validated values: 5m, 15m, 30m, 1h, 2h).
      // Storage key is 'sleepAfter' for backwards compat with existing sessions.
      if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
        this.idleTimeoutPref = sleepAfterPref;
        await this.ctx.storage.put('sleepAfter', sleepAfterPref);
        this.logger.info('idle timeout set from user preference', { idleTimeout: sleepAfterPref });
      }

      return new Response(JSON.stringify({ success: true, bucketName }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      this.logger.error('setBucketName failed', toError(err));
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /** Handle PUT /_internal/setSessionId (idempotent). */
  private async handleSetSessionId(request: Request): Promise<Response> {
    try {
      const { sessionId } = await request.json() as { sessionId?: string };
      if (sessionId) {
        await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
        this._sessionId = sessionId;
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      this.logger.error('setSessionId failed', toError(err));
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /** Handle GET /_internal/getBucketName. */
  private handleGetBucketName(): Response {
    return new Response(JSON.stringify({ bucketName: this._bucketName }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Called when the container starts successfully. */
  override async onStart(): Promise<void> {
    this.containerStartedAt = Date.now();
    this.updateEnvVars();
    await updateKvStatus(this.ctx, this.env, this._bucketName, 'running', 'lastStartedAt');
    // Also set lastActiveAt to start time so the frontend timer icon
    // has a reference timestamp even before any user input occurs.
    await updateKvStatus(this.ctx, this.env, this._bucketName, null, 'lastActiveAt');
    this.logger.info('Container started');
    // Clear any stale schedule rows from previous runs before arming fresh
    try { this.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
    await this.schedule(60, 'collectMetrics');
  }

  async collectMetrics(): Promise<void> {
    const callbacks: MetricsCallbacks = {
      stop: (signal: number | string) => this.stop(signal as number),
      schedule: (delaySec: number, method: string) => this.schedule(delaySec, method) as Promise<unknown>,
      idleTimeoutPref: this.idleTimeoutPref,
      setIdleTimeoutPref: (next: string) => { this.idleTimeoutPref = next; },
    };
    await doCollectMetrics(this.metricsState, this.ctx, this.env, callbacks);
  }

  /**
   * Override destroy to do a graceful SIGTERM shutdown so the entrypoint trap
   * runs final R2 bisync (REQ-SESSION-011) before SDK teardown SIGKILLs the
   * container. Storage identifiers are cleared first so any onStop() racing
   * with the trap-driven exit cannot resurrect the KV entry (REQ-SESSION-009).
   */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying container, clearing operational storage');
    try {
      await this.ctx.storage.delete(SESSION_ID_KEY);
      await this.ctx.storage.delete('bucketName');
      await this.ctx.storage.delete('workspaceSyncEnabled');
      await this.ctx.storage.delete('fastStartEnabled');
      await this.ctx.storage.delete('tabConfig');
      await this.ctx.storage.delete('sleepAfter');
      // Drop the persisted auth token: the next session under this DO ID will
      // be a different container instance with a fresh token, so reusing the
      // old one would let an unrelated request out of a previous lifecycle
      // authenticate against the new container.
      await this.ctx.storage.delete('containerAuthToken');
      // REQ-VAULT-008 AC1: wipe the vault key so deletion is
      // forward-secret. The browser's IDB ciphertext (if not yet
      // cleaned by the frontend lifecycle hook) becomes permanently
      // unrecoverable once this delete commits.
      await this.ctx.storage.delete('vaultKey');
      this._bucketName = null;
      this._sessionId = null;
      this._r2AccessKeyId = null;
      this._r2SecretAccessKey = null;
      this._containerAuthToken = null;
      this._vaultKey = null;
      this._openaiApiKey = null;
      this._geminiApiKey = null;
      this._githubToken = null;
      this._cloudflareApiToken = null;
      this._cloudflareAccountId = null;
      this._encryptionKey = null;
      this._sessionMode = 'default';
      this.logger.info('Operational storage cleared');
    } catch (err) {
      this.logger.error('Failed to clear storage', toError(err));
    }

    if (this.ctx.container?.running) {
      // 135s = 120s budget for the entrypoint's final bisync (set in
      // entrypoint.sh:shutdown_handler) plus a 15s buffer for clean
      // process exit. Budget history: 25_000 (original) -> 75_000
      // (vault rollout: vault edits in the last seconds were silently
      // truncated when the SDK SIGKILLed mid-bisync) -> 135_000 (this
      // change, alongside the 15-min cadence). Under the 15-min
      // cadence (AD56) a single final bisync can accumulate more
      // changes than under the old 60s cadence, so the watchdog at
      // the entrypoint layer needed 120s; the DO budget tracks that
      // plus the same 15s clean-exit buffer. See AD57.
      this._shutdownStartedAt = Date.now();
      const timeoutMs = 135_000;
      const warnThresholdMs = 110_000;
      const pollMs = 250;
      const start = this._shutdownStartedAt;
      let warned = false;
      try {
        await this.stop('SIGTERM');
        while (this.ctx.container?.running && Date.now() - start < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          if (!warned && Date.now() - start >= warnThresholdMs) {
            warned = true;
            this.logger.warn('Shutdown approaching budget ceiling', {
              elapsedMs: Date.now() - start,
              budgetMs: timeoutMs,
              warnThresholdMs,
            });
          }
        }
        const elapsed = Date.now() - start;
        if (this.ctx.container?.running) {
          this.logger.warn('Graceful shutdown timeout, escalating to SIGKILL', { timeoutMs, elapsed });
        } else {
          this.logger.info('Graceful shutdown complete', { elapsed });
        }
      } catch (err) {
        this.logger.warn('Graceful shutdown failed, falling back to SIGKILL', { error: toError(err).message });
      }
    }

    return super.destroy();
  }

  // Note: we intentionally do NOT override onActivityExpired() anymore. With
  // sleepAfter pinned to 24h the SDK's timer effectively never fires, and
  // collectMetrics() owns all idle-stop decisions. If an idle container does
  // reach the 24h ceiling, the SDK's default onActivityExpired will stop it,
  // which is the correct fallback.

  /** Called when the container stops. */
  override async onStop(): Promise<void> {
    // Kill the collectMetrics alarm loop - without this, the schedule
    // continues firing on a dead container indefinitely (zombie alarms).
    try { this.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
    const shutdownElapsedMs = this._shutdownStartedAt > 0 ? Date.now() - this._shutdownStartedAt : null;
    this.logger.info('Container stopped', { shutdownElapsedMs });
    await updateKvStatus(this.ctx, this.env, this._bucketName, 'stopped', 'lastActiveAt');
  }

  /** Called when the container encounters an error. */
  override onError(error: unknown): void {
    this.logger.error('Container error', error instanceof Error ? error : new Error(toErrorMessage(error)));
  }

}
