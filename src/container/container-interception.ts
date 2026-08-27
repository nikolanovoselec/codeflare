/**
 * Container outbound-HTTPS interception registry (CF-012 companion seam).
 *
 * Every interception transport the container DO wires before start lives here
 * as one registry entry: a mode gate plus a `resolve()` that applies the
 * transport's guards and builds its Worker-side props. The shared
 * `applyInterception` does the actual `ctx.exports` -> `interceptOutboundHttps`
 * registration with the per-transport try/catch isolation, so one transport's
 * wiring failure never disables another (REQ-ENTERPRISE-016 independence).
 *
 * Ordering and precedence (AD72/AD86): per-host registrations co-exist and
 * TAKE PRECEDENCE over the strict-egress `'*'` catch-all (SDK v0.3.7
 * precedence: deniedHosts > per-host > catch-all). Registry order preserves
 * the historical wiring order: OAuth CF-API first (non-enterprise), then the
 * enterprise transports (LLM, GitHub, Browser Rendering, strict egress).
 *
 * All props are resolved once at wiring, Worker-side; no credential, gateway
 * URL, or token ever enters the container.
 */
import type { Env, ManagedResourcePolicy } from '../types';
import { toError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { isEnterpriseMode } from '../lib/subscription';
import { getAigConfig } from '../lib/aig-config';
import { INTERCEPTED_LLM_HOSTS } from '../llm-interceptor';
import { interceptedGithubHosts } from '../github-interceptor';
import { INTERCEPTED_CF_BROWSER_HOSTS, INTERCEPTED_CF_OAUTH_HOSTS } from '../cloudflare-browser-interceptor';
import { CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER } from '../lib/constants';
import { getEnterpriseBrowserCreds } from '../lib/browser-render-token';
import { getOrImportKey } from '../lib/kv-crypto';

/** The DO surface the interception registry consumes (explicit interface, not inheritance). */
export interface InterceptionHost {
  readonly env: Env;
  readonly ctx: DurableObjectState<Env>;
  readonly logger: ReturnType<typeof createLogger>;
  _bucketName: string | null;
  _userEmail: string | null;
  _userGroups: string[];
  _cloudflareApiToken: string | null;
  _r2AccountId: string | null;
  _r2AccessKeyId: string | null;
  _r2SecretAccessKey: string | null;
  _managedResourcePolicy?: ManagedResourcePolicy;
  _managedResourceReleaseDigest?: string | null;
  _managedResourcePathsDigest?: string | null;
  _r2SseDisabled?: boolean;
  /** REQ-ENTERPRISE-016 AC3: resolved once in the DO constructor — never re-read per start. */
  _strictEgress?: boolean;
}

/** One resolved outbound-interception transport, ready to register. */
interface InterceptorRegistration {
  /** `ctx.exports` entrypoint name holding the interceptor WorkerEntrypoint. */
  entrypoint: string;
  /** Worker-side props (resolved once at wiring; never enter the container). */
  props: Record<string, unknown>;
  /** Host patterns to claim (`'*'` = strict-egress catch-all). */
  hosts: readonly string[];
  /** Mandatory registrations fail startup rather than allowing provider bypass. */
  mandatory?: boolean;
  wiredLog: string;
  wiredLogData?: Record<string, unknown>;
  failLog: string;
}

interface InterceptorSpec {
  /**
   * Deploy-mode gate: 'enterprise' entries run only when ENTERPRISE_MODE=active;
   * 'non-enterprise' entries run only when it is not — so the OAuth CF-API
   * transport can never wire or collide on a host the enterprise Browser
   * Rendering interceptor owns (REQ-AGENT-078 double-guard).
   */
  mode: 'enterprise' | 'non-enterprise';
  /** Apply the transport's guards; null = skip (guards log their own reason). */
  resolve(host: InterceptionHost): InterceptorRegistration | null | Promise<InterceptorRegistration | null>;
}

/**
 * api.cloudflare.com -> CloudflareBrowserInterceptor in OAuth mode (REQ-AGENT-078).
 * NON-enterprise ONLY, and ONLY for OAuth "Connect to Cloudflare" sessions — detected by the
 * injected OAuth placeholder (`applyCloudflareOAuthToken` sets it; a PAT session keeps its real
 * long-lived token, a plain session has none). The container holds only the placeholder; the
 * interceptor stamps a fresh, refreshed token per request.
 */
const cloudflareOauthApi: InterceptorSpec = {
  mode: 'non-enterprise',
  resolve(host) {
    if (host._cloudflareApiToken !== CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER) return null;
    const bucket = host._bucketName;
    if (!bucket) return null;
    return {
      entrypoint: 'CloudflareBrowserInterceptor',
      props: { bucket },
      hosts: INTERCEPTED_CF_OAUTH_HOSTS,
      wiredLog: 'Cloudflare OAuth API interception wired',
      wiredLogData: { hostCount: INTERCEPTED_CF_OAUTH_HOSTS.length },
      failLog: 'Failed to wire Cloudflare OAuth API interception',
    };
  },
};

/**
 * LLM provider hosts -> LlmInterceptor (REQ-ENTERPRISE-004). The AI Gateway URL + token are
 * resolved wizard-first (KV) with deploy-secret (env) fallback via {@link getAigConfig}
 * (REQ-ENTERPRISE-017). The per-session `user` prop is the user's email (stamped into
 * cf-aig-metadata for per-user analytics), falling back to the bucket id; the optional
 * `groups` prop carries the user's matched Access groups for per-group gateway policies.
 */
const llm: InterceptorSpec = {
  mode: 'enterprise',
  async resolve(host) {
    const aig = await getAigConfig(host.env);
    if (!aig.gatewayUrl) {
      host.logger.warn('Enterprise mode active but AI Gateway URL unset (wizard + env); LLM requests will fail closed');
    }
    if (!aig.token) {
      // Wire interception anyway, but warn loudly: without the gateway token the
      // interceptor cannot send the `Authorization: Bearer` header, so the customer's
      // AI Gateway will reject every request unless it is configured for unauthenticated
      // access. This is almost always a config omission (wizard or deploy secret).
      host.logger.warn('Enterprise mode active and AI Gateway configured but token unset; gateway requests will be unauthenticated');
    }
    const user = host._userEmail ?? host._bucketName ?? 'unknown';
    return {
      entrypoint: 'LlmInterceptor',
      props: {
        user,
        ...(host._userGroups.length > 0 ? { groups: host._userGroups } : {}),
        gatewayUrl: aig.gatewayUrl,
        token: aig.token,
      },
      hosts: INTERCEPTED_LLM_HOSTS,
      mandatory: true,
      wiredLog: 'Enterprise LLM interception wired',
      wiredLogData: { hostCount: INTERCEPTED_LLM_HOSTS.length },
      failLog: 'Failed to wire enterprise LLM interception',
    };
  },
};

/**
 * GitHub hosts -> GitHubInterceptor (REQ-GITHUB-003). The interceptor resolves the per-user
 * token from the deploy-keys KV entry keyed by the BOUND session bucket (fixed here, never
 * read from the request), so the real token never enters the container. Skipped without a
 * bucket (no user to resolve). REQ-ENTERPRISE-016: `strict` is added only when ON so an OFF
 * deploy passes the exact same `{ user, bucket }` props as before (byte-identical).
 */
const github: InterceptorSpec = {
  mode: 'enterprise',
  resolve(host) {
    const bucket = host._bucketName;
    if (!bucket) {
      host.logger.warn('Enterprise mode active but bucket name unset; skipping GitHub interception');
      return null;
    }
    const user = host._userEmail ?? bucket;
    const hosts = interceptedGithubHosts(host.env);
    return {
      entrypoint: 'GitHubInterceptor',
      props: host._strictEgress ? { user, bucket, strict: true } : { user, bucket },
      hosts,
      wiredLog: 'Enterprise GitHub interception wired',
      wiredLogData: { hostCount: hosts.length },
      failLog: 'Failed to wire enterprise GitHub interception',
    };
  },
};

/**
 * api.cloudflare.com -> CloudflareBrowserInterceptor (REQ-BROWSER-008). The container holds
 * only the non-secret CLOUDFLARE_API_TOKEN placeholder; the interceptor strips it and injects
 * the real admin Browser Rendering token worker-side, ONLY for the wizard-configured browser
 * account's /browser-rendering/* path (REST + CDP WebSocket). Wired independent of strict so
 * browser-run works in every enterprise configuration; `strict` is passed so the interceptor
 * routes any non-browser-rendering api.cloudflare.com call to the Gateway (else 403).
 * Credential resolution failures are caught here (matching the historical whole-body guard)
 * so they log-and-skip rather than break container start.
 */
const browserRendering: InterceptorSpec = {
  mode: 'enterprise',
  async resolve(host) {
    try {
      const cryptoKey = await getOrImportKey(host.env);
      const { token, accountId } = await getEnterpriseBrowserCreds(host.env, cryptoKey);
      if (!token || !accountId) {
        host.logger.info('Enterprise Browser Rendering interception not wired (no admin token/account configured)');
        return null;
      }
      return {
        entrypoint: 'CloudflareBrowserInterceptor',
        props: { browserAccountId: accountId, browserToken: token, strict: host._strictEgress },
        hosts: INTERCEPTED_CF_BROWSER_HOSTS,
        wiredLog: 'Enterprise Browser Rendering interception wired',
        wiredLogData: { hostCount: INTERCEPTED_CF_BROWSER_HOSTS.length },
        failLog: 'Failed to wire enterprise Browser Rendering interception',
      };
    } catch (err) {
      host.logger.error('Failed to wire enterprise Browser Rendering interception', toError(err));
      return null;
    }
  },
};

/**
 * Strict Gateway egress catch-all -> EgressController (REQ-ENTERPRISE-016, AD86). Only when
 * strict is ON. The `'*'` catch-all routes every host NOT claimed by a per-host interceptor
 * through the EgressController, which forces genuine direct-internet traffic through the
 * mandatory env.EGRESS Workers VPC binding (the customer's Zero Trust Gateway). The
 * account-scoped exemption: `_r2AccountId` is resolved in the DO constructor before wiring;
 * absent => fail-secure (nothing exempt, all egress Gateway-inspected). The bound bucket and
 * its scoped credentials stay Worker-side in props so intercepted R2 cannot use deployment-wide
 * credentials or cross the per-user bucket boundary.
 */
interface StrictEgressSecurityProps {
  bucket?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  resourcePolicy: ManagedResourcePolicy;
  releaseDigest?: string;
  pathsDigest?: string;
  r2SseDisabled?: boolean;
}

function resolveStrictEgress(
  host: InterceptionHost,
  security: StrictEgressSecurityProps = {
    bucket: host._bucketName ?? undefined,
    r2AccessKeyId: host._r2AccessKeyId ?? undefined,
    r2SecretAccessKey: host._r2SecretAccessKey ?? undefined,
    resourcePolicy: host._managedResourcePolicy ?? 'mutable',
    ...(host._managedResourceReleaseDigest ? { releaseDigest: host._managedResourceReleaseDigest } : {}),
    ...(host._managedResourcePathsDigest ? { pathsDigest: host._managedResourcePathsDigest } : {}),
    ...(host._r2SseDisabled ? { r2SseDisabled: true } : {}),
  },
): InterceptorRegistration | null {
  if (!host._strictEgress) return null;
  return {
    entrypoint: 'EgressController',
    props: {
      accountId: host._r2AccountId ?? undefined,
      ...security,
      strict: true,
    },
    hosts: ['*'],
    wiredLog: 'Enterprise strict Gateway egress wired (catch-all)',
    failLog: 'Failed to wire enterprise strict Gateway egress',
  };
}

const strictEgress: InterceptorSpec = {
  mode: 'enterprise',
  resolve: resolveStrictEgress,
};

/** The registry: one entry per transport, in wiring order. */
const CONTAINER_INTERCEPTION_REGISTRY: readonly InterceptorSpec[] = [
  cloudflareOauthApi,
  llm,
  github,
  browserRendering,
  strictEgress,
];

/** Register one resolved transport; failures log and never break container start. */
async function applyInterception(
  host: InterceptionHost,
  reg: InterceptorRegistration,
  failClosed = false,
): Promise<void> {
  try {
    // interceptOutbound* + ctx.exports are on by default at this worker's
    // compatibility_date (enable_ctx_exports defaulted on 2025-11-17 — see
    // wrangler.toml); the cast isolates the runtime surface from the generated types.
    const cctx = host.ctx as unknown as {
      exports: Record<string, (opts: { props: Record<string, unknown> }) => Fetcher>;
      container?: { interceptOutboundHttps(pattern: string, worker: Fetcher): void | Promise<void> };
    };
    if (!cctx.container?.interceptOutboundHttps) {
      if (reg.mandatory || failClosed) {
        throw new Error(reg.mandatory
          ? 'Mandatory outbound HTTPS interception is unavailable'
          : 'Outbound HTTPS interception is unavailable');
      }
      return;
    }
    const interceptor = cctx.exports[reg.entrypoint]({ props: reg.props });
    for (const pattern of reg.hosts) {
      await cctx.container.interceptOutboundHttps(pattern, interceptor);
    }
    if (reg.wiredLogData) {
      host.logger.info(reg.wiredLog, reg.wiredLogData);
    } else {
      host.logger.info(reg.wiredLog);
    }
  } catch (err) {
    host.logger.error(reg.failLog, toError(err));
    if (reg.mandatory || failClosed) throw err;
  }
}

/** Replace the strict catch-all after a warm DO receives a rotated scoped R2 pair. */
export async function refreshStrictEgressInterception(
  host: InterceptionHost,
  security: StrictEgressSecurityProps,
): Promise<void> {
  const reg = resolveStrictEgress(host, security);
  if (reg) await applyInterception(host, reg, true);
}

/**
 * Wire every applicable transport for this deploy mode. Called from the DO's
 * `startAndWaitForPorts` override BEFORE `super.startAndWaitForPorts()` so the
 * platform mounts the ephemeral containers CA in time for entrypoint.sh to
 * trust it (REQ-ENTERPRISE-004 / REQ-ENTERPRISE-011 pre-start ordering).
 */
export async function wireContainerInterception(host: InterceptionHost): Promise<void> {
  const enterprise = isEnterpriseMode(host.env);
  for (const spec of CONTAINER_INTERCEPTION_REGISTRY) {
    if ((spec.mode === 'enterprise') !== enterprise) continue;
    const reg = await spec.resolve(host);
    if (reg) await applyInterception(host, reg);
  }
}
