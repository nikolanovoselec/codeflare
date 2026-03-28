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
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { getR2Config } from '../lib/r2-config';
import { toError, toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import type { ActivityState } from '../lib/activity-policy';
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
  parseSleepAfterMs,
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

  // Default idle timeout before the container goes to sleep.
  // collectMetrics() renews via renewActivityTimeout() when new user input is detected.
  // The fetch() override uses super.fetch() (SDK handles readiness/networking).
  // collectMetrics() handles real idle detection independently.
  override sleepAfter = '5m';

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

  /** Parse sleepAfter string ('5m', '30m', '1h', '2h') to milliseconds. */
  private parseSleepAfterMs(): number {
    return parseSleepAfterMs(this.sleepAfter);
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
    // readiness, WebSocket upgrades, and container networking).
    // Note: super.fetch() calls renewActivityTimeout() internally, resetting
    // the SDK sleepAfter timer on every request. This means the SDK timer
    // alone cannot enforce idle sleep. Instead, collectMetrics() tracks real
    // user input and calls this.stop('SIGTERM') explicitly when idle.
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

        // Update sleepAfter on restart
        if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
          this.sleepAfter = sleepAfterPref;
          this.renewActivityTimeout();
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

      // Apply user-configurable sleepAfter (validated values: 5m, 15m, 30m, 1h, 2h)
      if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
        this.sleepAfter = sleepAfterPref;
        this.renewActivityTimeout();
        this.logger.info('sleepAfter set from user preference', { sleepAfter: sleepAfterPref });
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
      renewActivityTimeout: () => this.renewActivityTimeout(),
      stop: (signal: number | string) => this.stop(signal as number),
      schedule: (delaySec: number, method: string) => this.schedule(delaySec, method) as Promise<unknown>,
      parseSleepAfterMs: () => this.parseSleepAfterMs(),
      sleepAfter: this.sleepAfter,
    };
    await doCollectMetrics(this.metricsState, this.ctx, this.env, callbacks);
  }

  /** Override destroy to clean up operational storage before SDK teardown. */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying container, clearing operational storage');
    try {
      // Delete SESSION_ID_KEY and null _bucketName so that onStop()
      // (triggered by super.destroy() killing the container process)
      // bails out early and does NOT resurrect the KV entry.
      await this.ctx.storage.delete(SESSION_ID_KEY);
      await this.ctx.storage.delete('bucketName');
      await this.ctx.storage.delete('workspaceSyncEnabled');
      await this.ctx.storage.delete('fastStartEnabled');
      await this.ctx.storage.delete('tabConfig');
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
    return super.destroy();
  }

  /** Called when sleepAfter expires — check for new user input one last time. */
  override async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) {
      this.logger.info('onActivityExpired: container not running, allowing sleep');
      await this.stop('SIGTERM');
      return;
    }

    try {
      const tcpPort = this.ctx.container.getTcpPort(TERMINAL_SERVER_PORT);
      const res = await tcpPort.fetch('http://localhost/activity');
      if (!res.ok) {
        this.logger.warn('onActivityExpired: /activity returned non-OK, stopping', { status: res.status });
        await this.stop('SIGTERM');
        return;
      }
      const activity = await res.json() as ActivityState;

      // Check for new input one last time before stopping.
      // If user typed since the last collectMetrics poll, renew.
      const hasNewInput = activity.lastInputAt !== null
        && activity.lastInputAt !== this.lastSeenInputAt;

      if (hasNewInput) {
        this.lastSeenInputAt = activity.lastInputAt;
        this.logger.info('onActivityExpired: new input detected, renewing', {
          lastInputAt: activity.lastInputAt,
          connectedClients: activity.connectedClients,
        });
        this.renewActivityTimeout();
        return;
      }

      this.logger.info('onActivityExpired: no new input, stopping container', {
        lastInputAt: activity.lastInputAt,
        lastSeenInputAt: this.lastSeenInputAt,
        connectedClients: activity.connectedClients,
      });
    } catch (err) {
      this.logger.warn('onActivityExpired: failed to check activity, stopping', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this.stop('SIGTERM');
  }

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
