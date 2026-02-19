import { Container } from '@cloudflare/containers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Session, TabConfig } from '../types';
import {
  TERMINAL_SERVER_PORT,
  IDLE_TIMEOUT_MS,
  ACTIVITY_POLL_INTERVAL_MS,
  ACTIVITY_FETCH_MAX_RETRIES,
  ACTIVITY_FETCH_RETRY_DELAY_MS,
  MAX_CONSECUTIVE_ACTIVITY_FAILURES,
} from '../lib/constants';
import { getR2Config } from '../lib/r2-config';
import { toErrorMessage } from '../lib/error-types';
import { getSessionKey } from '../lib/kv-keys';
import { createLogger } from '../lib/logger';

/**
 * Storage key to mark a DO as destroyed - prevents zombie resurrection
 */
const DESTROYED_FLAG_KEY = '_destroyed';
const SESSION_ID_KEY = '_sessionId';
const LAST_SHUTDOWN_INFO_KEY = '_last_shutdown_info';

interface ShutdownInfo {
  reason: string;
  at: string;
  details?: Record<string, unknown>;
}

/**
 * container - Container Durable Object for user workspaces
 *
 * Each user gets one container that persists their workspace via s3fs mount to R2.
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

  // Bug 3 fix: Extend sleepAfter to 24h - our activity polling handles hibernation
  sleepAfter = '24h';

  // Environment variables - dynamically generated via getter
  private _bucketName: string | null = null;
  private _r2AccountId: string | null = null;
  private _r2Endpoint: string | null = null;
  private _r2AccessKeyId: string | null = null;
  private _r2SecretAccessKey: string | null = null;
  private _workspaceSyncEnabled: boolean = false;
  private _tabConfig: TabConfig[] | null = null;
  private _containerAuthToken: string | null = null;

  // Bug 3 fix: Activity polling timer
  private _activityPollAlarm: boolean = false;

  // Zombie prevention: in-memory flag loaded from storage in constructor
  private _destroyed = false;

  // Consecutive activity endpoint failures — forces destruction after threshold
  private _consecutiveActivityFailures = 0;

  // Map-based dispatch for internal routes (AR9)
  private readonly internalRoutes: Map<string, (request: Request) => Promise<Response> | Response>;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);

    // Initialize internal route dispatch table
    this.internalRoutes = new Map<string, (request: Request) => Promise<Response> | Response>([
      ['POST:/_internal/setBucketName', (request) => this.handleSetBucketName(request)],
      ['GET:/_internal/getBucketName', () => this.handleGetBucketName()],
      ['GET:/_internal/debugEnvVars', () => this.handleDebugEnvVars()],
    ]);
    // Load bucket name from storage on startup and update envVars
    this.ctx.blockConcurrencyWhile(async () => {
      // Check if this DO was already destroyed - if so, keep tombstone but clear alarm
      const wasDestroyed = await this.ctx.storage.get<boolean>(DESTROYED_FLAG_KEY);
      if (wasDestroyed) {
        this.logger.warn('Zombie detected in constructor, keeping tombstone, clearing alarm');
        this._destroyed = true;
        await this.ctx.storage.deleteAlarm();
        return; // Don't initialize anything else
      }

      this._bucketName = await this.ctx.storage.get<string>('bucketName') || null;
      const storedWorkspaceSyncEnabled = await this.ctx.storage.get<boolean>('workspaceSyncEnabled');
      if (typeof storedWorkspaceSyncEnabled === 'boolean') {
        this._workspaceSyncEnabled = storedWorkspaceSyncEnabled;
      }
      this._tabConfig = await this.ctx.storage.get<TabConfig[]>('tabConfig') || null;

      // If no bucket name stored, this is an orphan/zombie DO - set tombstone and clear alarm
      if (!this._bucketName) {
        this.logger.warn('Orphan DO detected, no bucketName, setting tombstone');
        this._destroyed = true;
        await this.ctx.storage.put(DESTROYED_FLAG_KEY, true);
        await this.ctx.storage.deleteAlarm();
        return; // Don't initialize anything else
      }

      // Resolve R2 config via shared helper (env vars first, KV fallback)
      // Done AFTER zombie/orphan checks to avoid unnecessary KV reads for doomed DOs
      try {
        const r2Config = await getR2Config(this.env);
        this._r2AccountId = r2Config.accountId;
        this._r2Endpoint = r2Config.endpoint;
      } catch (err) {
        this.logger.warn('R2 config not available, will use empty values in envVars', {
          error: toErrorMessage(err),
        });
      }

      this.logger.info('Loaded bucket name from storage', { bucketName: this._bucketName });
      this.updateEnvVars();
    });
  }

  /**
   * Set the bucket name for this container (called by worker on first access)
   */
  async setBucketName(name: string, r2Creds?: {
    r2AccessKeyId?: string;
    r2SecretAccessKey?: string;
    r2AccountId?: string;
    r2Endpoint?: string;
    workspaceSyncEnabled?: boolean;
    tabConfig?: TabConfig[];
  }): Promise<void> {
    this._bucketName = name;
    await this.ctx.storage.put('bucketName', name);
    if (typeof r2Creds?.workspaceSyncEnabled === 'boolean') {
      this._workspaceSyncEnabled = r2Creds.workspaceSyncEnabled;
      await this.ctx.storage.put('workspaceSyncEnabled', r2Creds.workspaceSyncEnabled);
    }

    // Store tab config if provided
    if (r2Creds?.tabConfig) {
      this._tabConfig = r2Creds.tabConfig;
      await this.ctx.storage.put('tabConfig', r2Creds.tabConfig);
    }

    // Use Worker-provided R2 credentials (most reliable — Worker definitely has secrets)
    if (r2Creds?.r2AccessKeyId) this._r2AccessKeyId = r2Creds.r2AccessKeyId;
    if (r2Creds?.r2SecretAccessKey) this._r2SecretAccessKey = r2Creds.r2SecretAccessKey;
    if (r2Creds?.r2AccountId) this._r2AccountId = r2Creds.r2AccountId;
    if (r2Creds?.r2Endpoint) this._r2Endpoint = r2Creds.r2Endpoint;

    // Fall back to getR2Config only if Worker didn't provide account ID
    if (!this._r2AccountId) {
      try {
        const r2Config = await getR2Config(this.env);
        this._r2AccountId = r2Config.accountId;
        this._r2Endpoint = r2Config.endpoint;
      } catch (err) {
        this.logger.warn('R2 config not available in setBucketName', {
          error: toErrorMessage(err),
        });
      }
    }

    this.updateEnvVars();
    this.logger.info('Stored bucket name', { bucketName: name });
  }

  /**
   * Get the bucket name
   */
  getBucketName(): string | null {
    return this._bucketName;
  }

  /**
   * Update envVars with current bucket name
   * Called after setBucketName to ensure envVars has correct value
   */
  private updateEnvVars(): void {
    const bucketName = this._bucketName || 'unknown-bucket';
    const accessKeyId = this._r2AccessKeyId || this.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = this._r2SecretAccessKey || this.env.R2_SECRET_ACCESS_KEY || '';
    const accountId = this._r2AccountId || this.env.R2_ACCOUNT_ID || '';
    const endpoint = this._r2Endpoint || this.env.R2_ENDPOINT || '';

    // Generate auth token for container communication (once per DO lifecycle)
    if (!this._containerAuthToken) {
      this._containerAuthToken = crypto.randomUUID();
    }

    this.logger.info('R2 credentials configured', {
      bucketName,
      hasAccessKey: !!accessKeyId,
      hasSecretKey: !!secretAccessKey,
      hasAccountId: !!accountId,
      hasEndpoint: !!endpoint,
      workspaceSyncEnabled: this._workspaceSyncEnabled,
    });

    this.envVars = {
      // R2 credentials - using AWS naming convention for s3fs compatibility
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      // R2 configuration
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_SECRET_ACCESS_KEY: secretAccessKey,
      R2_ACCOUNT_ID: accountId,
      R2_BUCKET_NAME: bucketName,  // User's personal bucket
      R2_ENDPOINT: endpoint,
      WORKSPACE_SYNC_ENABLED: this._workspaceSyncEnabled ? 'true' : 'false',
      SYNC_MODE: this._workspaceSyncEnabled ? 'full' : 'none',
      // Terminal server port
      TERMINAL_PORT: String(TERMINAL_SERVER_PORT),
      // Auth token for container HTTP requests
      CONTAINER_AUTH_TOKEN: this._containerAuthToken ?? '',
      // Tab configuration (JSON string for the terminal server to parse)
      ...(this._tabConfig && { TAB_CONFIG: JSON.stringify(this._tabConfig) }),
    };
  }

  /**
   * Override fetch to handle internal routes via map-based dispatch
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routeKey = `${request.method}:${url.pathname}`;
    const handler = this.internalRoutes.get(routeKey);
    if (handler) return handler(request);

    // Inject container auth token for requests proxied to the container
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
   * Handle POST /_internal/setBucketName
   */
  private async handleSetBucketName(request: Request): Promise<Response> {
    try {
      // FIX-28: Idempotency — once bucket name is set, reject subsequent calls
      if (this._bucketName) {
        return new Response(JSON.stringify({ error: 'Bucket name already set' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const { bucketName, sessionId, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint, workspaceSyncEnabled, tabConfig } =
        await request.json() as {
          bucketName: string;
          sessionId?: string;
          r2AccessKeyId?: string;
          r2SecretAccessKey?: string;
          r2AccountId?: string;
          r2Endpoint?: string;
          workspaceSyncEnabled?: boolean;
          tabConfig?: TabConfig[];
        };

      // FIX-15: Validate inputs
      if (typeof bucketName !== 'string' || bucketName.trim() === '') {
        return new Response(JSON.stringify({ error: 'bucketName must be a non-empty string' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (r2AccessKeyId !== undefined && (typeof r2AccessKeyId !== 'string' || r2AccessKeyId.trim() === '')) {
        return new Response(JSON.stringify({ error: 'r2AccessKeyId must be a non-empty string when provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (r2SecretAccessKey !== undefined && (typeof r2SecretAccessKey !== 'string' || r2SecretAccessKey.trim() === '')) {
        return new Response(JSON.stringify({ error: 'r2SecretAccessKey must be a non-empty string when provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (workspaceSyncEnabled !== undefined && typeof workspaceSyncEnabled !== 'boolean') {
        return new Response(JSON.stringify({ error: 'workspaceSyncEnabled must be a boolean when provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (r2AccountId !== undefined && (typeof r2AccountId !== 'string' || r2AccountId.trim() === '')) {
        return new Response(JSON.stringify({ error: 'r2AccountId must be a non-empty string when provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (r2Endpoint !== undefined) {
        if (typeof r2Endpoint !== 'string' || r2Endpoint.trim() === '') {
          return new Response(JSON.stringify({ error: 'r2Endpoint must be a non-empty string when provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          new URL(r2Endpoint);
        } catch {
          return new Response(JSON.stringify({ error: 'r2Endpoint must be a valid URL' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Clear orphan tombstone if set — this DO is being actively configured
      if (this._destroyed) {
        this.logger.info('Clearing orphan tombstone: DO is being configured with bucketName');
        this._destroyed = false;
        await this.ctx.storage.delete(DESTROYED_FLAG_KEY);
      }

      await this.setBucketName(bucketName, {
        r2AccessKeyId,
        r2SecretAccessKey,
        r2AccountId,
        r2Endpoint,
        workspaceSyncEnabled,
        tabConfig,
      });

      // Store sessionId for KV reconciliation on self-destruct
      if (sessionId) {
        await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
      }

      return new Response(JSON.stringify({ success: true, bucketName }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: toErrorMessage(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Handle GET /_internal/getBucketName
   */
  private handleGetBucketName(): Response {
    return new Response(JSON.stringify({ bucketName: this._bucketName }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Handle GET /_internal/debugEnvVars (DEV_MODE only)
   */
  private handleDebugEnvVars(): Response {
    if (this.env.DEV_MODE !== 'true') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const debugInfo = {
      bucketName: this._bucketName,
      resolvedR2Config: {
        accountId: this._r2AccountId || 'NOT SET',
        endpoint: this._r2Endpoint || 'NOT SET',
        source: this._r2AccountId
          ? (this.env.R2_ACCOUNT_ID ? 'env' : 'kv')
          : 'none',
      },
      envVars: {
        R2_BUCKET_NAME: this.envVars?.R2_BUCKET_NAME || 'NOT SET',
        R2_ENDPOINT: this.envVars?.R2_ENDPOINT || 'NOT SET',
        R2_ACCOUNT_ID: this.envVars?.R2_ACCOUNT_ID || 'NOT SET',
        R2_ACCESS_KEY_ID: this.envVars?.R2_ACCESS_KEY_ID ? 'SET' : 'NOT SET',
        R2_SECRET_ACCESS_KEY: this.envVars?.R2_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET',
        WORKSPACE_SYNC_ENABLED: this.envVars?.WORKSPACE_SYNC_ENABLED || 'NOT SET',
        SYNC_MODE: this.envVars?.SYNC_MODE || 'NOT SET',
        TERMINAL_PORT: this.envVars?.TERMINAL_PORT || 'NOT SET',
      },
      workerEnv: {
        R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID ? 'SET' : 'NOT SET',
        R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET',
        R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID || 'NOT SET',
        R2_ENDPOINT: this.env.R2_ENDPOINT || 'NOT SET',
      },
    };
    return new Response(JSON.stringify(debugInfo, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Called when the container starts successfully.
   * Acts as a kill switch: if the DO was marked destroyed or has no bucket,
   * immediately tear down to prevent zombie resurrection.
   */
  override onStart(): void {
    // Kill switch: destroyed DO should not run
    // Do NOT call this.destroy() — super.destroy() restarts the container, creating a zombie loop.
    // Just delete the alarm so nothing reschedules. Container dies via sleepAfter.
    if (this._destroyed) {
      this.logger.warn('onStart kill switch: DO is destroyed, clearing alarm only');
      void this.ctx.storage.deleteAlarm();
      return;
    }

    // Kill switch: orphan DO with no bucket should not run
    if (!this._bucketName) {
      this.logger.warn('onStart kill switch: no bucketName, setting tombstone');
      this._destroyed = true;
      void (async () => {
        await this.ctx.storage.put(DESTROYED_FLAG_KEY, true);
        await this.ctx.storage.deleteAlarm();
      })();
      return;
    }

    void this.logStartContext();

    // Bug 3 fix: Start activity polling
    void this.scheduleActivityPoll();
  }

  /**
   * Log restart context to make container restarts diagnosable.
   */
  private async logStartContext(): Promise<void> {
    const runtimeConfig = {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      activityPollIntervalMs: ACTIVITY_POLL_INTERVAL_MS,
      activityFetchMaxRetries: ACTIVITY_FETCH_MAX_RETRIES,
      activityFetchRetryDelayMs: ACTIVITY_FETCH_RETRY_DELAY_MS,
    };
    try {
      const lastShutdown = await this.ctx.storage.get<ShutdownInfo>(LAST_SHUTDOWN_INFO_KEY);
      if (lastShutdown) {
        this.logger.warn('Container restarted after prior shutdown', {
          ...runtimeConfig,
          previousReason: lastShutdown.reason,
          previousAt: lastShutdown.at,
          previousDetails: lastShutdown.details,
        });
        await this.ctx.storage.delete(LAST_SHUTDOWN_INFO_KEY);
      } else {
        this.logger.info('Container started (no prior shutdown info; possible deploy/platform restart)', runtimeConfig);
      }
    } catch (err) {
      this.logger.warn('Failed to load shutdown info at startup', {
        ...runtimeConfig,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Persist the most recent shutdown cause for restart diagnostics.
   */
  private async recordShutdownInfo(
    reason: string,
    details?: Record<string, unknown>,
    options?: { overwrite?: boolean }
  ): Promise<void> {
    const overwrite = options?.overwrite ?? true;
    try {
      if (!overwrite) {
        const existing = await this.ctx.storage.get<ShutdownInfo>(LAST_SHUTDOWN_INFO_KEY);
        if (existing) return;
      }
      await this.ctx.storage.put(LAST_SHUTDOWN_INFO_KEY, {
        reason,
        at: new Date().toISOString(),
        ...(details && { details }),
      } satisfies ShutdownInfo);
    } catch (err) {
      this.logger.warn('Failed to persist shutdown info', {
        reason,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Bug 3 fix: Schedule the next activity poll using DO alarm
   */
  private async scheduleActivityPoll(): Promise<void> {
    if (this._activityPollAlarm) return; // Already scheduled

    try {
      const nextPollTime = Date.now() + ACTIVITY_POLL_INTERVAL_MS;
      await this.ctx.storage.setAlarm(nextPollTime);
      this._activityPollAlarm = true;
      this.logger.info('Activity poll scheduled', { nextPollTime: new Date(nextPollTime).toISOString() });
    } catch (err) {
      this.logger.error('Failed to schedule activity poll', err instanceof Error ? err : new Error(toErrorMessage(err)));
    }
  }

  /**
   * Check if DO was explicitly destroyed - prevents zombie resurrection.
   * Uses only DO storage (not Container methods) to avoid waking up hibernated DO.
   * @returns true if DO should be cleaned up and alarm handler should exit
   */
  private async checkDestroyedState(): Promise<boolean> {
    const wasDestroyed = await this.ctx.storage.get<boolean>(DESTROYED_FLAG_KEY);
    if (wasDestroyed) {
      this.logger.warn('Zombie prevented: DO was destroyed, clearing alarm (keeping tombstone)');
      await this.ctx.storage.deleteAlarm();
      return true;
    }
    return false;
  }

  /**
   * Check if DO is an orphan (no bucket name) - these are zombies from old code.
   * @returns true if DO should be cleaned up and alarm handler should exit
   */
  private async checkOrphanState(): Promise<boolean> {
    if (!this._bucketName) {
      this.logger.warn('Zombie detected: no bucketName stored, setting tombstone', { doId: this.ctx.id.toString() });
      try {
        await this.ctx.storage.put(DESTROYED_FLAG_KEY, true);
        await this.ctx.storage.deleteAlarm();
      } catch (err) {
        this.logger.error('Failed to cleanup zombie', err instanceof Error ? err : new Error(toErrorMessage(err)));
      }
      return true;
    }
    return false;
  }

  /**
   * Check if container is stopped and clean it up if so.
   * @returns true if container was stopped and cleaned up
   */
  private async checkContainerStopped(): Promise<boolean> {
    try {
      const state = await this.getState();
      if (state.status === 'stopped' || state.status === 'stopped_with_code') {
        this.logger.info('Container stopped, destroying to prevent zombie resurrection', { status: state.status });
        await this.cleanupAndDestroy('container_stopped_state', { status: state.status });
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn('Could not get state in alarm, skipping stopped-state check this cycle', {
        error: toErrorMessage(err),
      });
      return false;
    }
  }

  /**
   * Handle idle container by checking activity and destroying if idle too long.
   * @returns true if container was destroyed due to being idle
   */
  private async handleIdleContainer(): Promise<boolean> {
    // Don't probe containers that aren't running — prevents zombie resurrection
    // via this.fetch() -> super.fetch() -> containerFetch() auto-start path
    try {
      const state = await this.getState();
      if (state.status !== 'running' && state.status !== 'healthy') {
        await this.ctx.storage.deleteAlarm();
        this._activityPollAlarm = false;
        return true;
      }
    } catch {
      // getState() failed — don't proceed with fetch that could auto-start
      return false;
    }

    const activityInfo = await this.getActivityInfoWithRetry();

    if (!activityInfo) {
      this._consecutiveActivityFailures++;
      this.logger.warn('Activity endpoint unavailable after retries', {
        maxRetries: ACTIVITY_FETCH_MAX_RETRIES,
        consecutiveFailures: this._consecutiveActivityFailures,
        threshold: MAX_CONSECUTIVE_ACTIVITY_FAILURES,
      });

      // After N consecutive failures (~30 min at 5-min intervals), the container
      // process is presumed dead. Destroy to prevent "headless DO" zombies that
      // run their alarm loop forever with an unreachable terminal server.
      if (this._consecutiveActivityFailures >= MAX_CONSECUTIVE_ACTIVITY_FAILURES) {
        this.logger.warn('Max consecutive activity failures reached, force-destroying container', {
          consecutiveFailures: this._consecutiveActivityFailures,
        });
        await this.cleanupAndDestroy('activity_unreachable', {
          consecutiveFailures: this._consecutiveActivityFailures,
        });
        return true;
      }

      return false;
    }

    // Activity endpoint reachable — reset failure counter
    this._consecutiveActivityFailures = 0;

    const { hasActiveConnections, disconnectedForMs } = activityInfo;

    this.logger.info('Activity check', { hasActiveConnections, disconnectedForMs });

    // Active connections = alive
    if (hasActiveConnections) {
      return false;
    }

    // No connections for longer than idle timeout = kill
    if (disconnectedForMs !== null && disconnectedForMs > IDLE_TIMEOUT_MS) {
      this.logger.info('Container idle (no WebSocket connections), destroying', {
        disconnectedForMs,
        thresholdMs: IDLE_TIMEOUT_MS,
      });
      await this.cleanupAndDestroy('ws_idle_timeout', { disconnectedForMs });
      return true;
    }

    // Not yet timed out
    return false;
  }

  /**
   * Best-effort update of KV session status to 'stopped' when the DO self-destructs.
   * Reads sessionId + bucketName from DO storage, constructs the KV key, and patches
   * the session record. Failures are logged but never propagated.
   */
  private async updateKvSessionStopped(): Promise<void> {
    try {
      const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      const bucketName = await this.ctx.storage.get<string>('bucketName');
      if (!sessionId || !bucketName) {
        this.logger.info('Skipping KV update: missing sessionId or bucketName', { sessionId, bucketName });
        return;
      }
      const key = getSessionKey(bucketName, sessionId);
      const session = await this.env.KV.get<Session>(key, 'json');
      if (session && session.status !== 'stopped') {
        session.status = 'stopped';
        await this.env.KV.put(key, JSON.stringify(session));
        this.logger.info('Updated KV session status to stopped', { sessionId, bucketName });
      }
    } catch (err) {
      this.logger.warn('Failed to update KV session status (best-effort)', {
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Helper to mark DO as destroyed and clean up all storage.
   * Used by alarm handler to aggressively prevent zombie resurrection.
   */
  private async cleanupAndDestroy(reason: string, details?: Record<string, unknown>): Promise<void> {
    await this.recordShutdownInfo(reason, details, { overwrite: true });
    await this.updateKvSessionStopped();
    this._destroyed = true;
    await this.ctx.storage.put(DESTROYED_FLAG_KEY, true);
    await this.ctx.storage.deleteAlarm();
    this._activityPollAlarm = false;

    // Clean operational storage (same as destroy() but WITHOUT super.destroy())
    // super.destroy() restarts the container in the SDK, which triggers onStart()
    // on a fresh instance where _destroyed=false, scheduling a new alarm → zombie loop.
    // Instead: set tombstone, delete alarm, clean storage, walk away.
    // The container process dies naturally via sleepAfter (24h backstop).
    try {
      await this.ctx.storage.delete('bucketName');
      await this.ctx.storage.delete('workspaceSyncEnabled');
      await this.ctx.storage.delete('tabConfig');
    } catch (err) {
      this.logger.error('Failed to clear storage in cleanupAndDestroy', err instanceof Error ? err : new Error(toErrorMessage(err)));
    }
  }

  /**
   * Bug 3 fix: Handle DO alarm for activity polling
   *
   * CRITICAL ZOMBIE FIX: The alarm() method must check for destroyed state FIRST
   * before calling ANY Container base class methods like getState().
   *
   * Why? When destroy() is called, it sets the _destroyed flag and deletes the alarm.
   * However, if an alarm was already scheduled to fire, it will still trigger.
   * When alarm() fires and calls getState() on a destroyed container, it can
   * resurrect the DO, creating a zombie loop.
   *
   * The fix: Check storage for _destroyed flag FIRST. This uses only DO storage,
   * not Container methods, so it won't resurrect the container.
   */
  async alarm(): Promise<void> {
    this._activityPollAlarm = false;
    this.logger.info('Activity poll alarm triggered');

    // Step 1: Check if DO was explicitly destroyed (uses only storage, not Container methods)
    if (await this.checkDestroyedState()) {
      return;
    }

    // Step 2: Check if this is an orphan/zombie DO (no bucket name)
    if (await this.checkOrphanState()) {
      return;
    }

    // Step 3: Check if container is stopped
    if (await this.checkContainerStopped()) {
      return;
    }

    // Step 4: Handle activity polling and idle detection
    try {
      if (await this.handleIdleContainer()) {
        return;
      }

      // Schedule next poll
      await this.scheduleActivityPoll();
    } catch (err) {
      this.logger.error('Error in activity poll', err instanceof Error ? err : new Error(toErrorMessage(err)));
      // Keep session alive on transient alarm errors; retry on next poll.
      try {
        await this.scheduleActivityPoll();
      } catch (scheduleErr) {
        this.logger.error('Failed to reschedule activity poll after error', scheduleErr instanceof Error ? scheduleErr : new Error(toErrorMessage(scheduleErr)));
      }
    }
  }

  /**
   * Bug 3 fix: Get activity info from the terminal server
   */
  private async getActivityInfo(): Promise<{
    hasActiveConnections: boolean;
    disconnectedForMs: number | null;
  } | null> {
    try {
      const headers: HeadersInit = {};
      if (this._containerAuthToken) {
        headers['Authorization'] = `Bearer ${this._containerAuthToken}`;
      }
      const response = await this.fetch(
        new Request(this.getTerminalActivityUrl(), { method: 'GET', headers })
      );

      if (response.ok) {
        const data = await response.json() as {
          hasActiveConnections: boolean;
          disconnectedForMs: number | null;
        };
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Retry activity checks multiple times to avoid destroying active sessions
   * due to one transient fetch failure.
   */
  private async getActivityInfoWithRetry(): Promise<{
    hasActiveConnections: boolean;
    disconnectedForMs: number | null;
  } | null> {
    for (let attempt = 1; attempt <= ACTIVITY_FETCH_MAX_RETRIES; attempt++) {
      const info = await this.getActivityInfo();
      if (info) return info;

      if (attempt < ACTIVITY_FETCH_MAX_RETRIES) {
        this.logger.warn('Activity fetch failed, retrying', {
          attempt,
          maxAttempts: ACTIVITY_FETCH_MAX_RETRIES,
        });
        await new Promise(resolve => setTimeout(resolve, ACTIVITY_FETCH_RETRY_DELAY_MS));
      }
    }
    return null;
  }

  /**
   * Bug 3 fix: Get the internal URL for the terminal server's activity endpoint
   */
  getTerminalActivityUrl(): string {
    return `http://container:${TERMINAL_SERVER_PORT}/activity`;
  }

  /**
   * Override destroy to clear the activity poll alarm and mark as destroyed
   *
   * CRITICAL ZOMBIE FIX: We set a _destroyed flag in storage BEFORE calling super.destroy().
   * This flag is checked by alarm() BEFORE any Container methods are called.
   * This prevents the zombie resurrection bug where:
   * 1. destroy() is called
   * 2. An already-scheduled alarm fires
   * 3. alarm() calls getState() which resurrects the DO
   *
   * By setting the flag first, alarm() can detect the destroyed state without
   * calling any Container methods that would resurrect it.
   */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying container, clearing operational storage');
    // Set in-memory flag BEFORE super.destroy() — if the SDK triggers onStart()
    // on the same instance, the kill switch sees this immediately
    this._destroyed = true;
    try {
      await this.recordShutdownInfo('destroy_called', undefined, { overwrite: false });

      // Clear the alarm first
      await this.ctx.storage.deleteAlarm();
      this._activityPollAlarm = false;

      // Ensure tombstone is persisted — destroy() may be called directly (not via cleanupAndDestroy)
      await this.ctx.storage.put(DESTROYED_FLAG_KEY, true);

      // Delete operational data but KEEP _destroyed flag and _sessionId
      // _destroyed: a stale alarm can still detect zombie state
      // _sessionId: needed for KV reconciliation on future resurrection attempts
      await this.ctx.storage.delete('bucketName');
      await this.ctx.storage.delete('workspaceSyncEnabled');
      await this.ctx.storage.delete('tabConfig');
      this.logger.info('Operational storage cleared');
    } catch (err) {
      this.logger.error('Failed to clear storage', err instanceof Error ? err : new Error(toErrorMessage(err)));
    }
    return super.destroy();
  }

  /**
   * Called when the container stops
   */
  override onStop(): void {
    this.logger.info('Container stopped');
    void this.recordShutdownInfo('on_stop', undefined, { overwrite: false });
  }

  /**
   * Called when the container encounters an error
   */
  override onError(error: unknown): void {
    this.logger.error('Container error', error instanceof Error ? error : new Error(toErrorMessage(error)));
    void this.recordShutdownInfo('on_error', { error: toErrorMessage(error) }, { overwrite: false });
  }

}
