/**
 * Container Durable Object — internal route response shapes
 *
 * POST /_internal/setBucketName
 *   Request:  { bucketName: string; sessionId?: string; r2AccessKeyId?: string;
 *               r2SecretAccessKey?: string; r2AccountId?: string; r2Endpoint?: string;
 *               workspaceSyncEnabled?: boolean; fastStartEnabled?: boolean;
 *               tabConfig?: TabConfig[] }
 *   Response (200): { success: true; bucketName: string }
 *   Response (409): { error: "Bucket name already set" }  — idempotent; still stores sessionId/prefs
 *   Response (400): { error: string }                     — validation failure
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
import type { DurableObjectState } from '@cloudflare/workers-types';
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
export class container extends Container<Env> {
  private logger = createLogger('container');

  // Port where the container's HTTP server listens
  // Terminal server handles all endpoints: WebSocket, health check, metrics
  defaultPort = 8080;

  // SDK's sleepAfter timer is effectively disabled — we pin it to 24h so the
  // SDK never fires onActivityExpired in practice. The real idle detector is
  // collectMetrics(), which polls the in-container /activity endpoint every 60s
  // and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref.
  //
  // Why: @cloudflare/containers v0.2.x refreshes the SDK timer on every
  // WebSocket message in both directions (client↔container). That means the
  // SDK timer tracks "any activity", whereas we want "user-input activity" —
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
  private _bucketName: string | null = null;
  private _r2AccountId: string | null = null;
  private _r2Endpoint: string | null = null;
  private _r2AccessKeyId: string | null = null;
  private _r2SecretAccessKey: string | null = null;
  private _workspaceSyncEnabled: boolean = false;
  private _fastStartEnabled: boolean = true;
  private _tabConfig: TabConfig[] | null = null;
  private _openaiApiKey: string | null = null;
  private _geminiApiKey: string | null = null;
  private _githubToken: string | null = null;
  private _cloudflareApiToken: string | null = null;
  private _cloudflareAccountId: string | null = null;
  private _encryptionKey: string | null = null;
  private _sessionMode: string = 'default';
  private _containerAuthToken: string | null = null;
  private _sessionId: string | null = null;
  private _userEmail: string | null = null;
  /** Monotonic usage counter (seconds) — sent to Timekeeper for delta computation */
  private _usageSeconds = 0;
  private containerStartedAt = 0;
  /** Last seen lastInputAt from /activity — used to detect NEW input for renewal. */
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
  private get envState(): ContainerEnvState { return this as unknown as ContainerEnvState; }

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
    // Generate auth token for container communication (once per DO lifecycle)
    if (!this._containerAuthToken) {
      this._containerAuthToken = crypto.randomUUID();
    }

    this.envVars = buildEnvVars(this.envState, this.env);
  }

  /** Override fetch to handle internal routes via map-based dispatch. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routeKey = `${request.method}:${url.pathname}`;
    const handler = this.internalRoutes.get(routeKey);
    if (handler) return handler(request);

    // Reject non-internal requests when the container is not running.
    // This prevents WebSocket reconnect attempts from waking a hibernated
    // container via super.fetch() (which triggers the SDK's startIfNotRunning).
    // The DO knows the container state authoritatively — no KV read needed.
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
    // no role in idle detection — collectMetrics() owns that decision.
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
      const { bucketName, sessionId, userEmail, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint, workspaceSyncEnabled, fastStartEnabled, tabConfig, openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId, encryptionKey, sessionMode, sleepAfter: sleepAfterPref } =
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
          sleepAfter?: string;
        };

      // FIX-28: Idempotency — once bucket name is set, reject subsequent calls.
      // But always store sessionId so collectMetrics/onStop can find the KV entry
      // (sessionId may be missing if the DO was created before SESSION_ID_KEY existed).
      if (this._bucketName) {
        // Update user preferences on restart even though bucket is already set.
        // Without this, preference changes made between sessions are lost.
        const prefsChanged = await applyPrefsOnRestart(this.envState, this.ctx.storage, {
          sessionId, userEmail, workspaceSyncEnabled, fastStartEnabled, tabConfig,
          openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId,
          encryptionKey, sessionMode,
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

      // Store sessionId BEFORE setBucketName — updateEnvVars() inside
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
      this._bucketName = null;
      this._sessionId = null;
      this._r2AccessKeyId = null;
      this._r2SecretAccessKey = null;
      this._containerAuthToken = null;
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
      const timeoutMs = 25_000;
      const pollMs = 250;
      const start = Date.now();
      try {
        await this.stop('SIGTERM');
        while (this.ctx.container?.running && Date.now() - start < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
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
    // Kill the collectMetrics alarm loop — without this, the schedule
    // continues firing on a dead container indefinitely (zombie alarms).
    try { this.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
    this.logger.info('Container stopped');
    await updateKvStatus(this.ctx, this.env, this._bucketName, 'stopped', 'lastActiveAt');
  }

  /** Called when the container encounters an error. */
  override onError(error: unknown): void {
    this.logger.error('Container error', error instanceof Error ? error : new Error(toErrorMessage(error)));
  }

}
