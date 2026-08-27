/**
 * EgressController — enterprise-mode strict Gateway egress for non-LLM/non-GitHub
 * hosts (REQ-ENTERPRISE-016).
 *
 * A WorkerEntrypoint the container DO wires as a catch-all (`interceptOutboundHttps('*',
 * controller)`) when strict Gateway egress is ON; the DO passes the account, bound bucket,
 * bucket-scoped R2 credentials, and strict state via props (resolved once at wiring — no
 * per-request KV read). For most hosts it is a
 * TRANSPARENT PROXY: it stamps no identity and preserves the caller's `authorization` /
 * `cookie` / `set-cookie`, forcing genuine direct-internet traffic through the mandatory
 * `env.EGRESS` Workers VPC binding (the customer's Zero Trust Gateway) for inspection.
 *
 * The deployment's OWN-account platform destinations egress DIRECT, never cf1:network
 * ({@link isAccountScopedDestination}; account id from `ctx.props.accountId`):
 *   - own R2 ({@link isOwnAccountR2}): only the bound user bucket is accepted; the
 *     container's PLACEHOLDER `authorization` is STRIPPED and the request is RE-SIGNED with
 *     that bucket's Worker-held scoped R2 key (aws4fetch,
 *     reusing the request's `x-amz-content-sha256` so the body streams through unbuffered
 *     and SSE-C headers are preserved) — so the real R2 key never enters the container.
 *   - own account-scoped CF API: direct passthrough (dormant fallback — `api.cloudflare.com`
 *     Browser Rendering is normally claimed by the per-host CloudflareBrowserInterceptor
 *     (REQ-BROWSER-008), which strips the placeholder + injects the real token and TAKES
 *     PRECEDENCE over this catch-all, so it does not reach here).
 *
 * WebSocket upgrades are proxied by BRIDGING a fresh `WebSocketPair` to
 * the upstream socket (accept both ends, forward frames/close/error) and returning a 101
 * carrying the client end — returning the upstream response as-is does NOT propagate the
 * socket back to the container (it just stalls and is canceled).
 *
 * Fail-closed (the security point): a defense-in-depth re-check of the `strict` prop (503
 * EGRESS_NOT_CONFIGURED) and an SSRF literal-IP guard (403 EGRESS_TARGET_BLOCKED, before
 * any send) precede the forward, which itself returns 503 EGRESS_UNAVAILABLE with no
 * global-fetch fallback when the binding is unbound.
 *
 * Dormant on non-enterprise deploys / when the toggle is OFF: the DO only wires the
 * catch-all when strict is true, so this class is otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env, ManagedResourcePolicy } from './types';
import {
  controllerFetch,
  isAccountScopedDestination,
  isOwnAccountR2,
  isDisallowedEgressHost,
  jsonError,
  STRIPPED_REQUEST_HOP_BY_HOP,
  RESPONSE_HOP_BY_HOP,
} from './lib/controller-egress';
import { createR2Client, getR2Url } from './lib/r2-client';
import { getR2Config } from './lib/r2-config';
import { getSseHeaders } from './lib/r2-sse';
import {
  classifyManagedR2Request,
  MANAGED_R2_POLICY_KEY,
  readVerifiedManagedR2Policy,
} from './lib/managed-r2-policy';
import { createLogger } from './lib/logger';

const logger = createLogger('egress-controller');

/** Props the container DO passes at wiring time (resolved once, never per-request). */
interface EgressProps {
  /** This deployment's own Cloudflare account id; selects the account-scoped exemption. */
  accountId?: string;
  /** User bucket bound to this container session. */
  bucket?: string;
  /** Bucket-scoped credentials held by the DO and passed only to this Worker entrypoint. */
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  resourcePolicy?: ManagedResourcePolicy;
  releaseDigest?: string;
  pathsDigest?: string;
  r2SseDisabled?: boolean;
  /** Strict Gateway egress toggle, read once at wiring (the DO only wires when true). */
  strict?: boolean;
}

function s3PolicyError(status: 403 | 503, code: string, requestId: string): Response {
  const message = status === 403 ? 'Access Denied' : 'Managed resource policy is unavailable';
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>${requestId}</RequestId></Error>`, {
    status,
    headers: { 'Content-Type': 'application/xml', 'x-amz-request-id': requestId },
  });
}

function requestedR2Bucket(url: URL, accountId: string | undefined): string | undefined {
  const account = accountId?.trim().toLowerCase();
  if (!account) return undefined;
  const accountHost = `${account}.r2.cloudflarestorage.com`;
  const host = url.hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === accountHost) return url.pathname.split('/')[1];
  const suffix = `.${accountHost}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined;
}

async function sha256Prefix(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('');
}

function managedR2Operation(request: Request, url: URL): string {
  if (request.method === 'POST' && url.searchParams.has('delete')) return 'multi-delete';
  if (request.headers.has('x-amz-copy-source')) return 'copy-object';
  if (url.searchParams.has('tagging')) return `${request.method.toLowerCase()}-tagging`;
  if (url.searchParams.has('uploads')) return 'initiate-multipart';
  if (url.searchParams.has('uploadId')) {
    if (request.method === 'PUT') return 'upload-part';
    if (request.method === 'POST') return 'complete-multipart';
    if (request.method === 'DELETE') return 'abort-multipart';
    return 'multipart';
  }
  if (request.method === 'PUT') return 'put-object';
  if (request.method === 'DELETE') return 'delete-object';
  return request.method.toLowerCase();
}

async function managedR2AuditData(input: {
  request: Request;
  url: URL;
  accountId: string;
  bucket: string;
  pathsDigest?: string;
  requestId: string;
  reason: string;
}): Promise<Record<string, unknown>> {
  const accountHost = `${input.accountId.toLowerCase()}.r2.cloudflarestorage.com`;
  const host = input.url.hostname.toLowerCase().replace(/\.$/, '');
  const path = host === accountHost
    ? input.url.pathname.slice(`/${input.bucket}`.length).replace(/^\//, '')
    : input.url.pathname.replace(/^\//, '');
  return {
    operation: managedR2Operation(input.request, input.url),
    policyDigest: input.pathsDigest?.slice(0, 12) ?? 'missing',
    pathHash: await sha256Prefix(path),
    bucketHash: await sha256Prefix(input.bucket),
    requestId: input.requestId,
    reason: input.reason,
  };
}

export class EgressController extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props?: EgressProps }).props;

    // Defense-in-depth: the DO only wires this catch-all when strict is ON and passes
    // strict:true via props (read once at wiring — REQ-016 AC2, no per-request KV). A
    // missing/false prop means a stale or misconfigured wiring: fail closed.
    if (!props?.strict) {
      return jsonError(503, 'EGRESS_NOT_CONFIGURED', 'Strict Gateway egress is not enabled');
    }

    const url = new URL(request.url);
    if (isDisallowedEgressHost(url.hostname)) {
      // Reject SSRF targets BEFORE any upstream send.
      return jsonError(403, 'EGRESS_TARGET_BLOCKED', 'Egress target host is not permitted');
    }

    const accountId = props.accountId;
    const accountScoped = isAccountScopedDestination(url, accountId);
    const ownR2 = isOwnAccountR2(url, accountId);
    const scopedR2Credentials = props.r2AccessKeyId && props.r2SecretAccessKey
      ? { accessKeyId: props.r2AccessKeyId, secretAccessKey: props.r2SecretAccessKey }
      : null;
    let effectiveRequest = request;
    if (ownR2) {
      const requestedBucket = requestedR2Bucket(url, accountId);
      if (!props.bucket || requestedBucket !== props.bucket) {
        return jsonError(403, 'EGRESS_R2_BUCKET_FORBIDDEN', 'R2 bucket is not permitted');
      }
      const boundBucket = props.bucket;
      if (!scopedR2Credentials) {
        return jsonError(503, 'EGRESS_R2_NOT_CONFIGURED', 'Scoped R2 credentials are unavailable');
      }
      const resourcePolicy = props.resourcePolicy ?? 'mutable';
      if (resourcePolicy !== 'mutable') {
        const requestId = crypto.randomUUID();
        const auditInput = { request, url, accountId: accountId!, bucket: boundBucket, pathsDigest: props.pathsDigest, requestId };
        if (!props.releaseDigest || !props.pathsDigest) {
          logger.warn('Managed R2 policy decision', await managedR2AuditData({ ...auditInput, reason: 'policy-identity-missing' }));
          return s3PolicyError(503, 'ServiceUnavailable', requestId);
        }
        try {
          const config = await getR2Config(this.env);
          if (config.accountId !== accountId) {
            logger.warn('Managed R2 policy decision', await managedR2AuditData({ ...auditInput, reason: 'account-mismatch' }));
            return s3PolicyError(503, 'ServiceUnavailable', requestId);
          }
          const policyClient = createR2Client({
            R2_ACCESS_KEY_ID: scopedR2Credentials.accessKeyId,
            R2_SECRET_ACCESS_KEY: scopedR2Credentials.secretAccessKey,
          });
          const policy = await readVerifiedManagedR2Policy({
            fetchPolicyObject: () => policyClient.fetch(
              getR2Url(config.endpoint, boundBucket, MANAGED_R2_POLICY_KEY),
              { method: 'GET', headers: getSseHeaders(this.env, props.r2SseDisabled === true) },
            ),
            releaseDigest: props.releaseDigest,
            pathsDigest: props.pathsDigest,
            expectedPolicy: resourcePolicy,
            bypassMemoryCache: false,
          });
          const classification = await classifyManagedR2Request({
            request,
            accountId: config.accountId,
            boundBucket,
            policy,
          });
          if (classification.action === 'deny') {
            logger.warn('Managed R2 policy decision', await managedR2AuditData({
              ...auditInput,
              requestId: classification.requestId,
              reason: 'access-denied',
            }));
            return s3PolicyError(classification.status, classification.code, classification.requestId);
          }
          logger.debug('Managed R2 policy decision', await managedR2AuditData({ ...auditInput, reason: 'allowed' }));
          effectiveRequest = classification.request;
        } catch {
          logger.warn('Managed R2 policy decision', await managedR2AuditData({ ...auditInput, reason: 'policy-unavailable' }));
          return s3PolicyError(503, 'ServiceUnavailable', requestId);
        }
      }
    }

    // WebSocket upgrades through the catch-all: bridge a fresh WebSocketPair to the upstream
    // socket. Forward the original request VERBATIM (transparent proxy). Browser-run's CDP WS
    // (api.cloudflare.com /browser-rendering/devtools/...) does NOT arrive here — it is claimed
    // by the per-host CloudflareBrowserInterceptor (REQ-BROWSER-008). Returning the upstream
    // response as-is does not hand the socket back to the container, so we accept+forward both ends.
    if (effectiveRequest.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const t0 = Date.now();
      try {
        const upstream = await controllerFetch(this.env, effectiveRequest, accountId);
        const upstreamWs = (upstream as unknown as { webSocket?: WebSocket }).webSocket;
        if (!upstreamWs) {
          // Not a 101 (e.g. an error response) — surface it unchanged.
          logger.debug('egress', { h: url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', ws: true, bridged: false, fMs: Date.now() - t0 });
          return upstream;
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        upstreamWs.accept();
        server.accept();
        server.addEventListener('message', (e) => { try { upstreamWs.send(e.data); } catch { /* peer gone */ } });
        upstreamWs.addEventListener('message', (e) => { try { server.send(e.data); } catch { /* peer gone */ } });
        server.addEventListener('close', (e) => { try { upstreamWs.close(e.code, e.reason); } catch { /* already closed */ } });
        upstreamWs.addEventListener('close', (e) => { try { server.close(e.code, e.reason); } catch { /* already closed */ } });
        server.addEventListener('error', () => { try { upstreamWs.close(1011, 'client error'); } catch { /* noop */ } });
        upstreamWs.addEventListener('error', () => { try { server.close(1011, 'upstream error'); } catch { /* noop */ } });
        logger.debug('egress', { h: url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', ws: true, bridged: true, fMs: Date.now() - t0 });
        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        console.error('EgressController: WebSocket egress failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonError(502, 'EGRESS_WS_FAILED', 'Failed to establish WebSocket egress');
      }
    }

    // Rebuild the request: strip ONLY hop-by-hop headers + the recomputed
    // host/content-length. NEVER add identity headers for the transparent path.
    const headers = new Headers(effectiveRequest.headers);
    for (const h of STRIPPED_REQUEST_HOP_BY_HOP) headers.delete(h);
    headers.delete('host');
    headers.delete('content-length');

    // GET/HEAD carry no body; everything else streams through unbuffered. Do not
    // follow redirects to an arbitrary Location host — surface the 3xx to the caller.
    const hasBody = effectiveRequest.method !== 'GET' && effectiveRequest.method !== 'HEAD';
    const forward = new Request(url.toString(), {
      method: effectiveRequest.method,
      headers,
      body: hasBody ? effectiveRequest.body : undefined,
      redirect: 'manual',
    });

    let upstream: Response;
    let resigned = false;
    const t0 = Date.now();
    try {
      if (ownR2 && scopedR2Credentials) {
        // Own R2: strip the container's PLACEHOLDER signature and RE-SIGN with the bound
        // bucket's scoped key. aws4fetch reuses the request's existing x-amz-content-sha256
        // (so the body streams through unbuffered) and signs every present header (SSE-C
        // x-amz-* preserved). Account-scoped ⇒ egresses direct, never env.EGRESS.
        const signHeaders = new Headers(forward.headers);
        signHeaders.delete('authorization');
        const signed = await createR2Client({
          R2_ACCESS_KEY_ID: scopedR2Credentials.accessKeyId,
          R2_SECRET_ACCESS_KEY: scopedR2Credentials.secretAccessKey,
        }).sign(url.toString(), {
          method: forward.method,
          headers: signHeaders,
          body: hasBody ? forward.body : undefined,
          redirect: 'manual',
        });
        upstream = await fetch(signed);
        resigned = true;
      } else {
        // Transparent: account-scoped CF API → direct (caller auth preserved);
        // everything else → env.EGRESS (fail-closed 503 when the binding is unbound).
        upstream = await controllerFetch(this.env, forward, accountId);
      }
    } catch (err) {
      console.error('EgressController: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'EGRESS_FETCH_FAILED', 'Failed to reach egress target');
    }
    // Diagnostic (REQ-016) at debug level — OFF by default (minLogLevel 'info'), enable
    // LOG_LEVEL=debug to attribute the per-op routing + worker-side latency so the R2-speed
    // lever can be chosen from data (compare fMs to $workers.wallTimeMs). Temporary.
    logger.debug('egress', { h: ownR2 ? 'own-r2' : url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', rs: resigned, fMs: Date.now() - t0 });

    // Stream the response back unread; strip ONLY hop-by-hop headers (preserve
    // set-cookie — transparent proxy).
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_HOP_BY_HOP) responseHeaders.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }
}
