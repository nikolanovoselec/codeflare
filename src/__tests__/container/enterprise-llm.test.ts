import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, hoisted call-order log so the mocked base Container can record when
// super.startAndWaitForPorts() runs relative to interceptOutboundHttps() — used
// by the REQ-ENTERPRISE-004 pre-start interception-ordering test below.
const { callOrder } = vi.hoisted(() => ({ callOrder: [] as string[] }));

/**
 * Container DO class tests.
 *
 * The container class (src/container/index.ts) extends Cloudflare's Container<Env>
 * base class. Idle detection is owned by collectMetrics (polls /activity every 60s
 * and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref). The SDK's
 * sleepAfter field is pinned to '24h' and plays no role in idle decisions.
 *
 * What we CAN test in isolation:
 * - Constructor initialization (bucketName loading, envVars population)
 * - Internal route dispatch table structure
 * - onStart/onStop lifecycle (KV timestamp updates)
 * - destroy() cleanup
 * - idleTimeoutPref persistence and loading
 *
 * What we CANNOT test without full Container runtime:
 * - setBucketName persistence (calls ctx.storage.put)
 * - The full fetch override (calls super.fetch for non-internal routes)
 */

// Mock dependencies before importing the container class
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({ accountId: 'test-account', endpoint: 'https://r2.test' }),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// Mock the @cloudflare/containers module
vi.mock('@cloudflare/containers', () => ({
  Container: class MockContainer {
    ctx: any;
    env: any;
    envVars?: Record<string, string>;
    defaultPort?: number;
    sleepAfter?: string;

    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }

    async fetch(_request: Request): Promise<Response> {
      return new Response('base fetch', { status: 200 });
    }

    async destroy(): Promise<void> {}
    async getState(): Promise<{ status: string }> {
      return { status: 'running' };
    }
    async getActivityInfo(): Promise<any> {
      return null;
    }
    async schedule(_seconds: number, _method: string): Promise<void> {}
    deleteSchedules(_method: string): void {}
    renewActivityTimeout(): void {}
    async stop(_signal: string): Promise<void> {}
    onStart(): void {}
    onStop(): void {}
    onError(_error: unknown): void {}
    onActivityExpired(): void {}
    async startAndWaitForPorts(..._args: any[]): Promise<void> {
      callOrder.push('super.startAndWaitForPorts');
    }
  },
}));

// Now import the container class after mocks are set up
import { container as ContainerClass } from '../../container/index';

// REQ-SESSION-019: Final-sync drain endpoint authentication
// REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard
// REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport
// REQ-OPS-010: Graceful container shutdown preserves data
// REQ-OPS-016: sleepAfter preference persistence and lifecycle
// REQ-SESSION-006: User can stop, restart, and delete sessions
// REQ-SESSION-008: Container restart preserves R2 bucket

describe('container DO class / REQ-SESSION-002 (one container per session) / REQ-SESSION-019', () => {
  let mockStorage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteAll: ReturnType<typeof vi.fn>;
    setAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
  };
  let mockTcpPortFetch: ReturnType<typeof vi.fn>;
  let mockContainerRuntime: {
    running: boolean;
    getTcpPort: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    monitor: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  let mockCtx: {
    storage: typeof mockStorage;
    id: { toString: () => string };
    blockConcurrencyWhile: ReturnType<typeof vi.fn>;
    container: typeof mockContainerRuntime;
  };
  let mockEnv: any;

  beforeEach(() => {
    mockStorage = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    mockTcpPortFetch = vi.fn();
    mockContainerRuntime = {
      running: true,
      getTcpPort: vi.fn().mockReturnValue({ fetch: mockTcpPortFetch }),
      start: vi.fn(),
      destroy: vi.fn(),
      monitor: vi.fn(),
      signal: vi.fn(),
    };
    mockCtx = {
      storage: mockStorage,
      id: { toString: () => 'test-do-id-hex' },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
      container: mockContainerRuntime,
    };
    mockEnv = {
      R2_ACCOUNT_ID: 'test-account',
      R2_ENDPOINT: 'https://r2.test',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      KV: {},
    };
  });

  describe('enterprise LLM interception wiring (REQ-ENTERPRISE-011)', () => {
    // The container DO reads the strict Gateway egress toggle (REQ-ENTERPRISE-016)
    // straight from KV at the start seam via hasStrictGatewayEgress, so an enterprise
    // env MUST expose a callable KV.get. Default OFF ('inactive') keeps every existing
    // REQ-ENTERPRISE-011/REQ-GITHUB-003 assertion byte-identical; pass strictEgress=true
    // to exercise the ON path.
    const enterpriseEnv = (strictEgress = false) => ({
      ...mockEnv,
      ENTERPRISE_MODE: 'active',
      AIG_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123',
      AIG_TOKEN: 'gw-token',
      KV: {
        get: vi.fn(async (key: string) =>
          key === 'setup:strict_egress' ? (strictEgress ? 'active' : 'inactive') : null),
      },
    });

    it('registers interceptOutboundHttps BEFORE the container starts so the CA is mounted when entrypoint.sh trusts it', async () => {
      // Root-cause regression: the wiring used to live in onStart() (post-boot),
      // so the ephemeral CF containers CA did not exist when entrypoint.sh ran
      // its trust block -> the intercepted TLS handshake failed with "Connection
      // error" and LlmInterceptor was never reached. It MUST be wired before
      // super.startAndWaitForPorts (= before the SDK's container.start()).
      callOrder.length = 0;
      const fetcher = { id: 'llm-interceptor-fetcher' };
      const LlmInterceptor = vi.fn(() => fetcher);
      const interceptOutboundHttps = vi.fn((_host: string, _worker: unknown) => {
        callOrder.push('interceptOutboundHttps');
      });
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor },
      };
      const instance = new ContainerClass(ctx as any, enterpriseEnv());

      await instance.startAndWaitForPorts(8080);

      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.openai.com', fetcher);
      expect(callOrder).toEqual(['interceptOutboundHttps', 'super.startAndWaitForPorts']);
    });

    it('does NOT wire interception on a non-enterprise start (SaaS start path byte-identical)', async () => {
      callOrder.length = 0;
      const interceptOutboundHttps = vi.fn();
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor: vi.fn() },
      };
      // mockEnv has no ENTERPRISE_MODE -> enterprise interception entries are a no-op.
      const instance = new ContainerClass(ctx as any, mockEnv);

      await instance.startAndWaitForPorts(8080);

      expect(interceptOutboundHttps).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['super.startAndWaitForPorts']);
    });

    it('stamps the user email (not the bucket id) as the interceptor per-user prop', async () => {
      callOrder.length = 0;
      const fetcher = { id: 'llm-interceptor-fetcher' };
      const LlmInterceptor = vi.fn(() => fetcher);
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps: vi.fn() },
        exports: { LlmInterceptor },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv());
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });

      await instance.startAndWaitForPorts(8080);

      // cf-aig-metadata attribution must carry the real email, not the opaque bucket id.
      expect(LlmInterceptor).toHaveBeenCalledWith({ props: { user: 'nikola@novoselec.ch', gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123', token: 'gw-token' } });
    });

    it('passes the matched Access groups as the interceptor groups prop when set', async () => {
      callOrder.length = 0;
      const fetcher = { id: 'llm-interceptor-fetcher' };
      const LlmInterceptor = vi.fn(() => fetcher);
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps: vi.fn() },
        exports: { LlmInterceptor },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'userGroups') return ['codeflare_admins', 'codeflare_developers'];
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv());
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userGroups');
      });

      await instance.startAndWaitForPorts(8080);

      // The matched groups ride alongside the email; the interceptor stamps one
      // cf-aig-metadata tag per group.
      expect(LlmInterceptor).toHaveBeenCalledWith({ props: { user: 'nikola@novoselec.ch', groups: ['codeflare_admins', 'codeflare_developers'], gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123', token: 'gw-token' } });
    });

    it('coerces a legacy single-string userGroup storage value to a one-element userGroups list on wake', async () => {
      callOrder.length = 0;
      const fetcher = { id: 'llm-interceptor-fetcher' };
      const LlmInterceptor = vi.fn(() => fetcher);
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps: vi.fn() },
        exports: { LlmInterceptor },
      };
      // Older sessions persisted a scalar under 'userGroup' and have NO 'userGroups'.
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'userGroups') return undefined; // new key absent on a legacy DO
        if (key === 'userGroup') return 'codeflare_admins'; // legacy scalar
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv());
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userGroup');
      });

      await instance.startAndWaitForPorts(8080);

      // The legacy scalar is coerced to a one-element list so the in-flight
      // session keeps its per-group attribution.
      expect(LlmInterceptor).toHaveBeenCalledWith({ props: { user: 'nikola@novoselec.ch', groups: ['codeflare_admins'], gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123', token: 'gw-token' } });
    });

    it('REQ-GITHUB-003: wires the GitHubInterceptor for the github hosts with the per-session user + bucket props', async () => {
      callOrder.length = 0;
      const llmFetcher = { id: 'llm-interceptor-fetcher' };
      const githubFetcher = { id: 'github-interceptor-fetcher' };
      const LlmInterceptor = vi.fn(() => llmFetcher);
      const GitHubInterceptor = vi.fn(() => githubFetcher);
      const interceptOutboundHttps = vi.fn();
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor, GitHubInterceptor },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv());
      // Wait for userEmail (loaded AFTER bucketName in the constructor) so _bucketName
      // is guaranteed assigned before we wire interception.
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });

      await instance.startAndWaitForPorts(8080);

      // The GitHub interceptor is bound to the per-session identity: the user email
      // for audit + the bucket as the SOLE token-resolution key (no request input).
      expect(GitHubInterceptor).toHaveBeenCalledWith({
        props: { user: 'nikola@novoselec.ch', bucket: 'codeflare-enterprise-nikola-novoselec-ch' },
      });
      // All github hosts route to the github fetcher (never the llm fetcher),
      // including Copilot's remote MCP host so its github-mcp-server is authed.
      expect(interceptOutboundHttps).toHaveBeenCalledWith('github.com', githubFetcher);
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.github.com', githubFetcher);
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.githubcopilot.com', githubFetcher);
    });

    it('REQ-GITHUB-003: still wires GitHub interception when the AI gateway is unconfigured (independent transports)', async () => {
      const githubFetcher = { id: 'github-interceptor-fetcher' };
      const GitHubInterceptor = vi.fn(() => githubFetcher);
      const interceptOutboundHttps = vi.fn();
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor: vi.fn(() => ({ id: 'llm-unconfigured' })), GitHubInterceptor },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      // Enterprise mode on, but AIG_GATEWAY_URL / AIG_TOKEN absent. KV.get is
      // required because the start seam now reads the strict egress toggle
      // (REQ-ENTERPRISE-016); 'inactive' keeps this OFF / byte-identical.
      const instance = new ContainerClass(ctx as any, {
        ...mockEnv,
        ENTERPRISE_MODE: 'active',
        KV: { get: vi.fn(async (key: string) => key === 'setup:strict_egress' ? 'inactive' : null) },
      } as any);
      // Wait for userEmail (loaded after bucketName) so _bucketName is set before wiring.
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });

      await instance.startAndWaitForPorts(8080);

      expect(ctx.exports.LlmInterceptor).toHaveBeenCalledWith({
        props: { user: 'nikola@novoselec.ch', gatewayUrl: undefined, token: undefined },
      });
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.openai.com', { id: 'llm-unconfigured' });
      expect(GitHubInterceptor).toHaveBeenCalledWith({
        props: { user: 'nikola@novoselec.ch', bucket: 'codeflare-enterprise-nikola-novoselec-ch' },
      });
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.github.com', githubFetcher);
    });

    it('fails startup when mandatory enterprise LLM registration throws', async () => {
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps: vi.fn() },
        exports: { LlmInterceptor: vi.fn(() => { throw new Error('registration failed'); }) },
      };
      const instance = new ContainerClass(ctx as any, {
        ...mockEnv,
        ENTERPRISE_MODE: 'active',
        KV: { get: vi.fn().mockResolvedValue(null) },
      } as any);

      const startsBefore = callOrder.filter((entry) => entry === 'super.startAndWaitForPorts').length;
      await expect(instance.startAndWaitForPorts(8080)).rejects.toThrow('registration failed');
      expect(callOrder.filter((entry) => entry === 'super.startAndWaitForPorts')).toHaveLength(startsBefore);
    });

    it('fails startup when the mandatory interception API is unavailable', async () => {
      const ctx = {
        ...mockCtx,
        container: undefined,
        exports: { LlmInterceptor: vi.fn(() => ({ id: 'llm' })) },
      };
      const instance = new ContainerClass(ctx as any, {
        ...mockEnv, ENTERPRISE_MODE: 'active', KV: { get: vi.fn().mockResolvedValue(null) },
      } as any);

      await expect(instance.startAndWaitForPorts(8080)).rejects.toThrow('Mandatory outbound HTTPS interception is unavailable');
    });

    // REQ-ENTERPRISE-016 / AD86: when the strict Gateway egress toggle is ON, the DO
    // wires a catch-all '*' interceptor to the EgressController (forcing the container's
    // direct-internet egress through env.EGRESS, while the controller itself egresses
    // THIS account's own R2 / CF API direct, account-scoped) and stamps strict:true onto
    // the GitHub interceptor props (external egress rides the Gateway). The LLM interceptor
    // always egresses direct (AI Gateway is platform-native), so it never carries strict.
    it('REQ-ENTERPRISE-016: wires the EgressController catch-all (\'*\') BEFORE super.startAndWaitForPorts when strict is ON', async () => {
      callOrder.length = 0;
      const egressFetcher = { id: 'egress-controller-fetcher' };
      const EgressController = vi.fn(() => egressFetcher);
      const interceptOutboundHttps = vi.fn((_host: string, _worker: unknown) => {
        callOrder.push('interceptOutboundHttps');
      });
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: {
          LlmInterceptor: vi.fn(() => ({ id: 'llm' })),
          GitHubInterceptor: vi.fn(() => ({ id: 'gh' })),
          EgressController,
        },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv(true));
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });
      instance._bucketName = 'codeflare-enterprise-nikola-novoselec-ch';
      instance._r2AccessKeyId = 'scoped-access-key';
      instance._r2SecretAccessKey = 'scoped-secret-key';

      await instance.startAndWaitForPorts(8080);

      // The catch-all routes through the EgressController fetcher.
      expect(interceptOutboundHttps).toHaveBeenCalledWith('*', egressFetcher);
      // WS3 account-scoped exemption (REQ-ENTERPRISE-016): the DO threads its own
      // account id (resolved via getR2Config) so the controller exempts ONLY this
      // account's R2 / CF API. getR2Config is mocked to return accountId 'test-account'.
      expect(EgressController).toHaveBeenCalledWith({
        props: {
          accountId: 'test-account',
          bucket: 'codeflare-enterprise-nikola-novoselec-ch',
          r2AccessKeyId: 'scoped-access-key',
          r2SecretAccessKey: 'scoped-secret-key',
          resourcePolicy: 'mutable',
          strict: true,
        },
      });
      // ALL interceptOutboundHttps calls (LLM + GitHub + catch-all) precede the
      // container boot so the CA is mounted before entrypoint.sh — the same
      // load-bearing ordering as the per-host registrations.
      expect(callOrder[callOrder.length - 1]).toBe('super.startAndWaitForPorts');
      expect(callOrder.indexOf('super.startAndWaitForPorts')).toBe(callOrder.length - 1);
      expect(callOrder).toContain('interceptOutboundHttps');
    });

    it('REQ-ENTERPRISE-016 / AD86: GitHub props carry strict:true when the toggle is ON, but the LLM never does (AI Gateway is platform-native)', async () => {
      const LlmInterceptor = vi.fn(() => ({ id: 'llm' }));
      const GitHubInterceptor = vi.fn(() => ({ id: 'gh' }));
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps: vi.fn() },
        exports: { LlmInterceptor, GitHubInterceptor, EgressController: vi.fn(() => ({ id: 'egress' })) },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv(true));
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });

      await instance.startAndWaitForPorts(8080);

      // GitHub is external internet egress -> strict:true rides its props so its
      // upstream fetch swaps to env.EGRESS (the customer's Gateway).
      expect(GitHubInterceptor).toHaveBeenCalledWith({
        props: { user: 'nikola@novoselec.ch', bucket: 'codeflare-enterprise-nikola-novoselec-ch', strict: true },
      });
      // AI Gateway is platform-native: the LLM interceptor ALWAYS egresses direct, so
      // its props are byte-identical whether or not strict is ON — never a strict field.
      expect(LlmInterceptor).toHaveBeenCalledWith({ props: { user: 'nikola@novoselec.ch', gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123', token: 'gw-token' } });
    });

    it('REQ-ENTERPRISE-016: does NOT wire the EgressController and omits strict from props when the toggle is OFF (byte-identical per-host path)', async () => {
      const LlmInterceptor = vi.fn(() => ({ id: 'llm' }));
      const GitHubInterceptor = vi.fn(() => ({ id: 'gh' }));
      const EgressController = vi.fn(() => ({ id: 'egress' }));
      const interceptOutboundHttps = vi.fn();
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor, GitHubInterceptor, EgressController },
      };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'userEmail') return 'nikola@novoselec.ch';
        if (key === 'bucketName') return 'codeflare-enterprise-nikola-novoselec-ch';
        return null;
      });
      const instance = new ContainerClass(ctx as any, enterpriseEnv(false));
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('userEmail');
      });

      await instance.startAndWaitForPorts(8080);

      // No catch-all controller is constructed or registered.
      expect(EgressController).not.toHaveBeenCalled();
      expect(interceptOutboundHttps).not.toHaveBeenCalledWith('*', expect.anything());
      // Per-host props are byte-identical to a non-strict deploy: no `strict` field.
      expect(LlmInterceptor).toHaveBeenCalledWith({ props: { user: 'nikola@novoselec.ch', gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw123', token: 'gw-token' } });
      expect(GitHubInterceptor).toHaveBeenCalledWith({
        props: { user: 'nikola@novoselec.ch', bucket: 'codeflare-enterprise-nikola-novoselec-ch' },
      });
    });

    it('REQ-ENTERPRISE-016: does NOT wire the EgressController catch-all on a non-enterprise start', async () => {
      callOrder.length = 0;
      const EgressController = vi.fn(() => ({ id: 'egress' }));
      const interceptOutboundHttps = vi.fn();
      const ctx = {
        ...mockCtx,
        container: { ...mockContainerRuntime, interceptOutboundHttps },
        exports: { LlmInterceptor: vi.fn(), GitHubInterceptor: vi.fn(), EgressController },
      };
      // mockEnv has no ENTERPRISE_MODE -> enterprise interception entries are a no-op
      // and never reads the strict toggle.
      const instance = new ContainerClass(ctx as any, mockEnv);

      await instance.startAndWaitForPorts(8080);

      expect(EgressController).not.toHaveBeenCalled();
      expect(interceptOutboundHttps).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['super.startAndWaitForPorts']);
    });

    // REQ-ENTERPRISE-016: when strict Gateway egress is ON the constructor also denies the
    // container raw (non-HTTP) platform egress by setting enableInternet=false. When strict
    // is OFF / non-enterprise, enableInternet is left at the platform default (never forced
    // off), so every other mode is byte-identical.
    it('REQ-ENTERPRISE-016: forces enableInternet=false when strict egress is ON', async () => {
      // enableInternet is set in the constructor's blockConcurrencyWhile body, right after
      // the strict-egress toggle resolves; poll until that microtask chain lands.
      const instance = new ContainerClass(mockCtx as any, enterpriseEnv(true));
      await vi.waitFor(() => {
        expect(instance.enableInternet).toBe(false);
      });
    });

    it('REQ-ENTERPRISE-016: leaves enableInternet at the platform default (not false) when strict egress is OFF', async () => {
      // A bucketName forces updateEnvVars() at the END of the constructor body, so a settled
      // envVars proves the body ran PAST the enableInternet line — without that anchor the
      // assertion could pass before the line executed (and would miss an unconditional disable).
      mockStorage.get.mockImplementation(async (key: string) => (key === 'bucketName' ? 'test-bucket' : null));
      const instance = new ContainerClass(mockCtx as any, enterpriseEnv(false));
      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
      });
      expect(instance.enableInternet).not.toBe(false);
    });

    it('REQ-ENTERPRISE-016: leaves enableInternet at the platform default (not false) on a non-enterprise start', async () => {
      mockStorage.get.mockImplementation(async (key: string) => (key === 'bucketName' ? 'test-bucket' : null));
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
      });
      expect(instance.enableInternet).not.toBe(false);
    });
  });
});
