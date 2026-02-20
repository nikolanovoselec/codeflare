import { Container } from '@cloudflare/containers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Session, TabConfig } from '../types';
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { getR2Config } from '../lib/r2-config';
import { toErrorMessage } from '../lib/error-types';
import { getSessionKey } from '../lib/kv-keys';
import { createLogger } from '../lib/logger';

const SESSION_ID_KEY = '_sessionId';

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

  // SDK kills container after 24h of no HTTP fetch() activity.
  override sleepAfter = '3m';

  // Environment variables - dynamically generated via getter
  private _bucketName: string | null = null;
  private _r2AccountId: string | null = null;
  private _r2Endpoint: string | null = null;
  private _r2AccessKeyId: string | null = null;
  private _r2SecretAccessKey: string | null = null;
  private _workspaceSyncEnabled: boolean = false;
  private _tabConfig: TabConfig[] | null = null;
  private _containerAuthToken: string | null = null;

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
      this._bucketName = await this.ctx.storage.get<string>('bucketName') || null;
      const storedWorkspaceSyncEnabled = await this.ctx.storage.get<boolean>('workspaceSyncEnabled');
      if (typeof storedWorkspaceSyncEnabled === 'boolean') {
        this._workspaceSyncEnabled = storedWorkspaceSyncEnabled;
      }
      this._tabConfig = await this.ctx.storage.get<TabConfig[]>('tabConfig') || null;

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
   */
  override async onStart(): Promise<void> {
    this.updateEnvVars();
    await this.updateKvStatus(null, 'lastStartedAt');
    this.logger.info('Container started');
    await this.schedule(5, 'collectMetrics');
  }

  async collectMetrics(): Promise<void> {
    if (!this.ctx.container?.running) return;
    try {
      const tcpPort = this.ctx.container.getTcpPort(8080);
      const res = await tcpPort.fetch('http://localhost/health');
      const health = await res.json() as { cpu?: string; mem?: string; hdd?: string; syncStatus?: string };

      const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      if (sessionId && this._bucketName) {
        const key = getSessionKey(this._bucketName, sessionId);
        const session = await this.env.KV.get<Session>(key, 'json');
        if (session) {
          session.metrics = {
            cpu: health.cpu,
            mem: health.mem,
            hdd: health.hdd,
            syncStatus: health.syncStatus,
            updatedAt: new Date().toISOString(),
          };
          await this.env.KV.put(key, JSON.stringify(session));
        }
      }
    } catch (err) {
      this.logger.warn('Metrics collection failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // Re-arm if still running
    if (this.ctx.container?.running) {
      await this.schedule(5, 'collectMetrics');
    }
  }

  /**
   * Update a timestamp field on the KV session record (best-effort).
   * Optionally sets session.status (e.g. 'stopped' on hibernation).
   */
  private async updateKvStatus(status: 'running' | 'stopped' | null, field: 'lastStartedAt' | 'lastActiveAt'): Promise<void> {
    try {
      const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      const bucketName = this._bucketName;
      if (!sessionId || !bucketName) return;
      const key = getSessionKey(bucketName, sessionId);
      const session = await this.env.KV.get<Session>(key, 'json');
      if (session) {
        if (status !== null) {
          session.status = status;
        }
        session[field] = new Date().toISOString();
        if (status === 'stopped') {
          delete session.metrics;
        }
        await this.env.KV.put(key, JSON.stringify(session));
      }
    } catch (err) {
      this.logger.error('Failed to update KV status', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Override destroy to clean up operational storage before SDK teardown.
   */
  override async destroy(): Promise<void> {
    this.logger.info('Destroying container, clearing operational storage');
    try {
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
  override async onStop(): Promise<void> {
    this.logger.info('Container stopped');
    await this.updateKvStatus('stopped', 'lastActiveAt');
  }

  /**
   * Called when the container encounters an error
   */
  override onError(error: unknown): void {
    this.logger.error('Container error', error instanceof Error ? error : new Error(toErrorMessage(error)));
  }

}
