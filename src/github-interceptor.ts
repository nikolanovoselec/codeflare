/**
 * GitHubInterceptor — enterprise-mode outbound GitHub credential injection (REQ-GITHUB-003).
 *
 * A WorkerEntrypoint the container DO wires into container egress for the GitHub
 * hosts (github.com + api.github.com + Copilot's api.githubcopilot.com MCP) via
 * `ctx.container.interceptOutboundHttps`
 * (see the github entry in src/container/container-interception.ts). The container holds only a
 * NON-SECRET placeholder GH_TOKEN, so git / `gh` / Copilot's GitHub features run
 * in authed mode but never possess the real credential. Each intercepted request
 * is routed HERE at the platform level: the interceptor strips the placeholder
 * auth, looks up + decrypts the per-user GitHub token from the existing deploy-keys
 * KV entry, and stamps the real credential at the github.com boundary in the format
 * the target host expects (git Basic vs API Bearer).
 *
 * Security property (no cross-user spoofing): user-scoping comes SOLELY from
 * `props.bucket`, bound when the DO instantiates this entrypoint for the session.
 * The request cannot influence which user's token is injected — the placeholder
 * value and any identity the request claims are ignored — so a session can only
 * ever inject its own user's token.
 *
 * Fail closed: when no valid token exists (not connected, or an App token that
 * cannot be refreshed) the interceptor returns 401 WITHOUT making any upstream
 * request — it never substitutes a guess, so the git/`gh` op fails with a clear
 * error rather than silently acting unauthenticated.
 *
 * Dormant on non-enterprise deploys: the DO only wires interception when
 * ENTERPRISE_MODE=active, so this class is never instantiated otherwise.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { getValidGithubToken } from './lib/github-token';
import { decideOperatorGithub } from './operators/interception-policy';
import type { OperatorPolicy } from './operators/policy';
import { prepareJwtStampedRequest, type JwtStampingAuthority, type JwtStampingPolicy } from './operators/jwt-stamping';
import { requireOperatorHumanContext } from './lib/access';
import { parseBoundedBoundaryInput } from './operators/boundary-input';
import { getContainerId } from './lib/container-helpers';
import { createReviewPushObserver } from './operators/review-git-protocol';
import { readBoundedResponse } from './lib/bounded-stream';
import { prepareVerifiedBoundary, selectVerifiedBoundaryAction,
  type ReadyBoundary } from './operators/review-boundary-preparation';
import type { BoundaryInput } from './operators/boundary-input';

/** Pinned default GitHub REST API version (set only when the client didn't pin one). */
const GITHUB_API_VERSION = '2022-11-28';

/** The git web host (clone/push over Smart HTTP); env-overridable for GHES. */
function gitWebHost(env: Env): string {
  return env.GITHUB_HOST?.trim() || 'github.com';
}
/** The REST API host (`gh` / API); env-overridable for GHES. */
function gitApiHost(env: Env): string {
  return env.GITHUB_API_HOST?.trim() || 'api.github.com';
}
/**
 * Copilot's remote GitHub MCP host (`api.githubcopilot.com`, path `/mcp`). Copilot
 * CLI's built-in `github-mcp-server` dials this and authenticates with a GitHub
 * Bearer token. Without interception the connection rides the strict-egress catch-all
 * to the Gateway unauthenticated and the MCP handshake fails ("Failed to connect to
 * MCP server github-mcp-server"). Env-overridable for GHES / Copilot-Enterprise hosts.
 */
function gitCopilotMcpHost(env: Env): string {
  return env.GITHUB_COPILOT_MCP_HOST?.trim() || 'api.githubcopilot.com';
}

/** Hosts the DO intercepts for enterprise GitHub credential injection (deduped). */
export function interceptedGithubHosts(env: Env): string[] {
  return [...new Set([gitWebHost(env), gitApiHost(env), gitCopilotMcpHost(env)])];
}

/**
 * Request headers stripped before forwarding upstream. The container's auth is a
 * non-secret placeholder (`GH_TOKEN`); it must never ride upstream — the real
 * credential is stamped fresh below. host/content-length are recomputed by the
 * runtime for the rebuilt request.
 */
const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  'authorization', 'x-api-key', 'host', 'content-length',
  'cf-access-jwt-assertion', 'x-codeflare-operator-boundary-input',
  'x-codeflare-operator-boundary-select',
];

/**
 * Response headers stripped before the upstream response re-enters the container.
 * Hop-by-hop headers (RFC 7230 §6.1) are connection-scoped; set-cookie must never
 * cross the boundary into the agent's client.
 */
const RESPONSE_STRIPPED_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
];

/** Per-session props attached when the DO instantiates this entrypoint. */
interface BoundarySession {
  getReviewLifecycleGeneration(ref: { bucket: string; sessionId: string; email: string }): Promise<number>;
  openReviewHuman(ref: { bucket: string; sessionId: string; email: string }): Promise<{
    human: Awaited<ReturnType<typeof requireOperatorHumanContext>>['human']; accessJwt: string;
  }>;
  stageBoundaryInput(value: { sessionId: string; generation: number; input: BoundaryInput;
    owner?: string; repository?: string; ref?: string }): Promise<ReadyBoundary | null>;
  stagePrCreationEvidence(value: { sessionId: string; generation: number; pullRequest: number;
    repositoryId: number; repositoryNodeId: string; pullRequestNodeId: string;
    owner: string; repository: string; head: string;
    headRefName: string; baseRefName: string }): Promise<ReadyBoundary | null>;
  stagePushEvidence(value: { sessionId: string; generation: number; owner: string; repository: string; ref: string;
    head: string }): Promise<ReadyBoundary | null>;
}

interface GithubInterceptorProps {
  /** The user's email — for the per-user audit line; never used to resolve the token. */
  user: string;
  /** The per-session bucket — the ONLY identity used to resolve the user's token. */
  bucket: string;
  /**
   * Strict gateway egress (REQ-ENTERPRISE-016): when the DO sets this from the
   * enterprise toggle, the single upstream fetch rides env.EGRESS (the Workers
   * VPC Fetcher → Cloudflare Gateway) instead of the global fetch. Absent/false
   * keeps the existing direct egress; the path fails closed when strict but the
   * EGRESS binding is unbound.
   */
  strict?: boolean;
  /** Parent-bound narrowing profile. Absence preserves ordinary human behavior. */
  operatorPolicy?: OperatorPolicy;
  jwtStamping?: JwtStampingPolicy;
  jwtAuthority?: JwtStampingAuthority;
  /** Parent-bound ordinary Enterprise session reference, never human credentials. */
  sessionId?: string;
  /** Pinned at container interception wiring from the D1 lifecycle owner. */
  lifecycleGeneration?: number;
}

function observeBoundedMetadata(source: ReadableStream<Uint8Array>,
  completed: (bytes: Uint8Array | null) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let valid = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (valid) {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            completed(bytes);
          } else completed(null);
          controller.close();
          return;
        }
        if (valid) {
          size += next.value.byteLength;
          if (size > 64 * 1024) { valid = false; chunks.length = 0; }
          else chunks.push(next.value.slice());
        }
        controller.enqueue(next.value);
      } catch (error) { completed(null); controller.error(error); }
    },
    async cancel(reason) { completed(null); await reader.cancel(reason); },
  });
}

function jsonError(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class GitHubInterceptor extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const apiHost = gitApiHost(this.env);
    const mcpHost = gitCopilotMcpHost(this.env);
    if (!interceptedGithubHosts(this.env).includes(url.hostname)) {
      // An unmapped host reaching here is a wiring misconfiguration; fail closed.
      return jsonError(400, 'BAD_HOST', 'Unsupported GitHub host');
    }

    // Identity is the BOUND per-session bucket only — never read from the request.
    const props = (this.ctx as unknown as { props?: GithubInterceptorProps }).props;
    if (props?.operatorPolicy) {
      const decision = decideOperatorGithub(props.operatorPolicy, request,
        { apiHost, webHost: gitWebHost(this.env) });
      if (!decision.allowed) return jsonError(403, 'OPERATOR_GITHUB_DENIED', 'GitHub operation is not permitted');
    }
    const bucket = props?.bucket;
    if (!bucket) {
      console.error('GitHubInterceptor: per-session bucket prop absent; failing closed');
      return jsonError(401, 'GITHUB_NO_SESSION', 'GitHub credential unavailable');
    }

    // Strict gateway egress (REQ-ENTERPRISE-016): when the per-session prop opts
    // in, the single upstream fetch rides env.EGRESS (the Workers VPC Fetcher →
    // Cloudflare Gateway) instead of the global fetch. Fail closed when strict but
    // the binding is unbound — never silently fall back to direct egress.
    const strict = props?.strict === true;
    if (strict && !this.env.EGRESS) {
      return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict gateway egress unavailable');
    }
    const send = strict ? this.env.EGRESS!.fetch.bind(this.env.EGRESS) : fetch;

    let token: string | null;
    try {
      token = await getValidGithubToken(this.env, bucket);
    } catch (err) {
      console.error('GitHubInterceptor: token lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'GITHUB_TOKEN_LOOKUP_FAILED', 'GitHub credential lookup failed');
    }
    if (!token) {
      // Not connected, or an expired App token with no usable refresh. Fail closed
      // (no upstream fetch) so the op errors clearly instead of acting unauthenticated.
      console.warn(`GitHubInterceptor: no valid GitHub token for user=${props?.user ?? 'unknown'}; failing closed`);
      return jsonError(401, 'GITHUB_NOT_CONNECTED', 'GitHub not connected');
    }

    // Strip the container placeholder + hop-by-hop headers, then stamp the real
    // credential in the format the target host expects.
    const headers = new Headers(request.headers);
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

    if (url.hostname === apiHost) {
      // REST API (`gh` / API): bearer token + pinned API version (only when the
      // client did not pin its own, so a client-chosen version is honoured).
      headers.set('authorization', `Bearer ${token}`);
      if (!headers.has('x-github-api-version')) headers.set('x-github-api-version', GITHUB_API_VERSION);
    } else if (url.hostname === mcpHost) {
      // Copilot's remote GitHub MCP (api.githubcopilot.com/mcp): Bearer auth, no REST
      // API version header. Without this the MCP connection rides the strict-egress
      // catch-all to the Gateway unauthenticated and the handshake fails (REQ-GITHUB-003).
      headers.set('authorization', `Bearer ${token}`);
    } else {
      // git Smart HTTP over HTTPS: Basic x-access-token:<token> — matches the
      // container credential helper's `username=x-access-token` convention
      // (entrypoint.sh), so the username half is irrelevant and the token is the password.
      headers.set('authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
    }

    // Per-user audit line (REQ-GITHUB-003): every injected GitHub call is attributed.
    console.info(
      `GitHubInterceptor: injected credential user=${props?.user ?? 'unknown'} ${request.method} ${url.hostname}${url.pathname}`,
    );

    // Attach both observers inline; the packfile still streams with backpressure.
    // Positive status is evidence only after the forwarded response completes.
    const pushPath = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/git-receive-pack$/.exec(url.pathname);
    const prRead = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/([1-9][0-9]*)$/.exec(url.pathname);
    const submitted = request.headers.get('x-codeflare-operator-boundary-input');
    const watching = this.env.ENTERPRISE_MODE === 'active' && !props?.operatorPolicy && props?.sessionId
      && ((request.method === 'POST' && url.hostname === gitWebHost(this.env) && pushPath)
        || (request.method === 'POST' && url.hostname === apiHost && url.pathname === '/graphql')
        || (request.method === 'GET' && url.hostname === apiHost && prRead && submitted));
    const boundarySession = watching
      ? (this.env.CONTAINER.getByName(getContainerId(bucket, props.sessionId!)) as unknown as BoundarySession)
      : null;
    const pinnedGeneration = props?.lifecycleGeneration;
    const boundaryGeneration = boundarySession && Number.isSafeInteger(pinnedGeneration)
      && pinnedGeneration! > 0 && await boundarySession.getReviewLifecycleGeneration({
        bucket, sessionId: props!.sessionId!, email: props!.user,
      }).catch(() => null) === pinnedGeneration ? pinnedGeneration : null;
    const observedPush = boundaryGeneration && pushPath && request.body
      && request.method === 'POST' && url.hostname === gitWebHost(this.env)
      ? createReviewPushObserver() : null;
    const observedCreation = boundaryGeneration && url.hostname === apiHost && url.pathname === '/graphql'
      && request.method === 'POST' && request.body;
    let creationRequest: { repositoryNodeId: string; headRefName: string; baseRefName: string } | null = null;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const upload = observedPush ? observedPush.wrapUpload(request.body!)
      : observedCreation ? observeBoundedMetadata(request.body!, bytes => {
        if (!bytes) return;
        try {
          const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
            query?: unknown; variables?: { input?: { repositoryId?: unknown; headRefName?: unknown;
              baseRefName?: unknown } };
          };
          // An exact supported mutation, not comments, aliases or a self-reported result.
          const query = payload?.query;
          const input = payload?.variables?.input;
          const supported = typeof query === 'string' && /^\s*mutation\s+PullRequestCreate\s*\(\s*\$input:\s*CreatePullRequestInput!\s*\)\s*\{\s*createPullRequest\s*\(\s*input:\s*\$input\s*\)\s*\{\s*pullRequest\s*\{\s*id\s+url\s*\}\s*\}\s*\}\s*$/.test(query);
          if (supported && typeof input?.repositoryId === 'string'
            && /^[A-Za-z0-9_=-]{1,256}$/.test(input.repositoryId)
            && typeof input.headRefName === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(input.headRefName)
            && typeof input.baseRefName === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(input.baseRefName)) {
            creationRequest = { repositoryNodeId: input.repositoryId,
              headRefName: input.headRefName, baseRefName: input.baseRefName };
          }
        } catch { /* An ambiguous mutation cannot supply creation evidence. */ }
      }) : request.body;
    let forward = new Request(url.toString(), {
      method: request.method,
      headers,
      body: hasBody ? upload : undefined,
      // Do not transparently follow redirects to an arbitrary Location host;
      // surface the 3xx to the agent's client instead.
      redirect: 'manual',
    });
    if (props?.jwtStamping) {
      try { forward = prepareJwtStampedRequest(forward, props.jwtStamping, props.jwtAuthority); }
      catch { return jsonError(403, 'JWT_STAMPING_AUTHORITY_UNAVAILABLE', 'Current human Access authority is required'); }
    }
    let upstream: Response;
    try {
      upstream = await send(forward);
    } catch (err) {
      observedPush?.abort();
      console.error('GitHubInterceptor: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'GITHUB_FETCH_FAILED', 'Failed to reach GitHub');
    }

    // A bounded session-bound Pi evidence submission rides only a successful
    // matching PR metadata read. Never forward its header or treat it as authority.
    let body = upstream.body;
    if (observedPush) {
      if (upstream.status === 200 && body
        && upstream.headers.get('content-type')?.startsWith('application/x-git-receive-pack-result')) {
        body = observedPush.wrapDownload(body);
        const sessionId = props!.sessionId!;
        const owner = pushPath![1], repository = pushPath![2];
        this.ctx.waitUntil(observedPush.result.then(async update => {
          if (!update) return;
          try {
            const session = this.env.CONTAINER.getByName(getContainerId(bucket, sessionId)) as unknown as BoundarySession;
            const ready = await session.stagePushEvidence({ sessionId, generation: boundaryGeneration!,
              owner, repository, ...update });
            if (ready) await prepare(ready, session, sessionId, boundaryGeneration!);
          } catch { /* No authorization or uncertain I/O never prepares. */ }
        }));
      } else observedPush.abort();
    }
    const api = (path: string) => send(new Request(`https://${apiHost}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'x-github-api-version': GITHUB_API_VERSION },
      redirect: 'manual', signal: AbortSignal.timeout(3_000),
    }));
    const apiJson = async (path: string): Promise<unknown> => {
      const response = await api(path);
      if (response.status !== 200) throw Error('GitHub PR creation context unavailable');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        await readBoundedResponse(response, 128 * 1024, 'GitHub creation metadata'))) as unknown;
    };
    const prepare = async (ready: ReadyBoundary, session: BoundarySession, sessionId: string, generation: number) => {
      const ref = { bucket, sessionId, email: props!.user };
      if (ready.generation !== generation || await session.getReviewLifecycleGeneration(ref) !== generation) {
        throw Error('Review lifecycle changed');
      }
      const sealed = await session.openReviewHuman(ref);
      const authority = await requireOperatorHumanContext(new Request(url, {
        headers: { 'cf-access-jwt-assertion': sealed.accessJwt },
      }), this.env, props!.user);
      if (authority.human.subject !== sealed.human.subject) throw Error('Session human changed');
      await prepareVerifiedBoundary(ready, authority, this.env, api, { bucket, sessionId },
        async () => { if (await session.getReviewLifecycleGeneration(ref) !== generation) {
          throw Error('Review lifecycle changed');
        } });
    };
    if (body && observedCreation && upstream.status === 200) {
      const sessionId = props!.sessionId!;
      body = observeBoundedMetadata(body, metadataBytes => {
        if (!metadataBytes || !creationRequest) return;
        this.ctx.waitUntil((async () => {
          try {
            const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as {
              errors?: unknown; data?: { createPullRequest?: { pullRequest?: { id?: unknown; url?: unknown } } };
            };
            if (metadata.errors !== undefined) return;
            const created = metadata.data?.createPullRequest?.pullRequest;
            if (typeof created?.id !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(created.id)
              || typeof created.url !== 'string') return;
            const createdUrl = new URL(created.url);
            const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(createdUrl.pathname);
            if (!path || createdUrl.protocol !== 'https:' || createdUrl.host !== gitWebHost(this.env)
              || createdUrl.username || createdUrl.password || createdUrl.search || createdUrl.hash) return;
            const [, owner, repository, number] = path;
            const pullRequest = Number(number);
            if (!Number.isSafeInteger(pullRequest)) return;
            const root = `/repos/${owner}/${repository}`;
            const [repo, pr] = await Promise.all([
              apiJson(root) as Promise<{ id?: unknown; node_id?: unknown; full_name?: unknown }>,
              apiJson(`${root}/pulls/${pullRequest}`) as Promise<{ number?: unknown; node_id?: unknown;
                state?: unknown; head?: { sha?: unknown; ref?: unknown; repo?: { id?: unknown } };
                base?: { ref?: unknown; repo?: { id?: unknown } } }>,
            ]);
            if (!Number.isSafeInteger(repo?.id) || (repo.id as number) < 1
              || repo.node_id !== creationRequest!.repositoryNodeId
              || typeof repo.full_name !== 'string'
              || repo.full_name.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
              || pr?.number !== pullRequest || pr.node_id !== created.id || pr.state !== 'open'
              || pr.head?.ref !== creationRequest!.headRefName
              || pr.base?.ref !== creationRequest!.baseRefName
              || pr.head?.repo?.id !== repo.id || pr.base?.repo?.id !== repo.id
              || typeof pr.head?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(pr.head.sha)) return;
            const session = this.env.CONTAINER.getByName(getContainerId(bucket, sessionId)) as unknown as BoundarySession;
            const ready = await session.stagePrCreationEvidence({ sessionId, generation: boundaryGeneration!,
              pullRequest, repositoryId: repo.id as number, repositoryNodeId: creationRequest!.repositoryNodeId,
              pullRequestNodeId: created.id, owner, repository, head: pr.head.sha,
              headRefName: creationRequest!.headRefName, baseRefName: creationRequest!.baseRefName });
            if (ready) await prepare(ready, session, sessionId, boundaryGeneration!);
          } catch { /* Ambiguous PR creation never prepares work. */ }
        })());
      });
    }
    const selectionMode = request.headers.get('x-codeflare-operator-boundary-select');
    const selectionRequested = selectionMode === '1' || selectionMode === 'check';
    let selection: 'local' | 'remote' | 'unavailable' | null = selectionRequested ? 'unavailable' : null;
    let selectionConsumed = false;
    if (selectionRequested && body && upstream.status === 200 && submitted
      && submitted.length <= 16_000 && boundaryGeneration && prRead && props?.sessionId
      && request.method === 'GET' && url.hostname === apiHost && !props.operatorPolicy) {
      try {
        const input = parseBoundedBoundaryInput(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(atob(submitted), char => char.charCodeAt(0)))) as unknown);
        if (input.pullRequest !== Number(prRead[3])) throw Error('PR does not match');
        selectionConsumed = true;
        const metadataBytes = await readBoundedResponse(upstream, 128 * 1024, 'PR boundary response');
        body = new Response(metadataBytes).body;
        const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(metadataBytes)) as {
          number?: number; head?: { sha?: string; ref?: string };
          base?: { sha?: string; ref?: string; repo?: { id?: number } };
        };
        if (metadata.number !== input.pullRequest || metadata.head?.sha !== input.targetHead
          || !metadata.head.ref || !/^[A-Za-z0-9._/-]+$/.test(metadata.head.ref)
          || metadata.base?.repo?.id !== input.repositoryId
          || !/^(main|master|develop)$/.test(metadata.base?.ref ?? '')
          || !/^[a-f0-9]{40}$/i.test(metadata.base?.sha ?? '')) throw Error('PR moved');
        const sessionId = props.sessionId;
        const session = boundarySession!;
        const ref = { bucket, sessionId, email: props.user };
        if (await session.getReviewLifecycleGeneration(ref) !== boundaryGeneration) throw Error('Session moved');
        const sealed = await session.openReviewHuman(ref);
        const authority = await requireOperatorHumanContext(new Request(url, {
          headers: { 'cf-access-jwt-assertion': sealed.accessJwt },
        }), this.env, props.user);
        if (authority.human.subject !== sealed.human.subject) throw Error('Human changed');
        selection = await selectVerifiedBoundaryAction(this.env, authority.human, {
          owner: prRead[1], repository: prRead[2], repositoryId: input.repositoryId,
          baseRef: metadata.base!.ref!, baseSha: metadata.base!.sha!,
        }, api);
        if (selection === 'remote' && selectionMode === '1') {
          const ready = await session.stageBoundaryInput({ sessionId, generation: boundaryGeneration,
            input, owner: prRead[1], repository: prRead[2], ref: `refs/heads/${metadata.head.ref}` });
          if (ready) {
            try { await prepare(ready, session, sessionId, boundaryGeneration); }
            catch { /* Remote remains exclusive even when preparation is uncertain. */ }
          }
        }
      } catch {
        selection = 'unavailable';
        if (selectionConsumed && body === upstream.body) {
          return jsonError(502, 'BOUNDARY_RESPONSE_UNAVAILABLE', 'PR boundary response could not be verified');
        }
      }
    }
    if (body && !selectionRequested && submitted && submitted.length <= 16_000 && boundaryGeneration && !props?.operatorPolicy && props?.sessionId
      && this.env.ENTERPRISE_MODE === 'active' && url.hostname === apiHost && request.method === 'GET'
      && prRead && upstream.status === 200) {
      try {
        const bytes = Uint8Array.from(atob(submitted), char => char.charCodeAt(0));
        const input = parseBoundedBoundaryInput(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
        if (input.pullRequest !== Number(prRead[3])) throw Error('Wrong PR');
        const sessionId = props.sessionId;
        body = observeBoundedMetadata(body, metadataBytes => {
          if (!metadataBytes) return;
          this.ctx.waitUntil((async () => {
            try {
              const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as {
                number?: number; head?: { sha?: string; ref?: string };
              };
              if (metadata.number !== input.pullRequest || metadata.head?.sha !== input.targetHead) return;
              const session = this.env.CONTAINER.getByName(getContainerId(bucket, sessionId)) as unknown as BoundarySession;
              const sealed = await session.openReviewHuman({ bucket, sessionId, email: props.user });
              await requireOperatorHumanContext(new Request(url, { headers: { 'cf-access-jwt-assertion': sealed.accessJwt } }),
                this.env, props.user);
              const headRef = metadata.head?.ref;
              const ready = await session.stageBoundaryInput({ sessionId, generation: boundaryGeneration, input,
                owner: prRead[1], repository: prRead[2],
                ...(headRef && /^[A-Za-z0-9._/-]+$/.test(headRef)
                  ? { ref: `refs/heads/${headRef}` } : {}),
              });
              if (ready) await prepare(ready, session, sessionId, boundaryGeneration);
            } catch { /* Optional staging cannot break GitHub reads. */ }
          })());
        });
      } catch { /* Invalid evidence is never forwarded or staged. */ }
    }

    // Stream the response back without buffering; strip hop-by-hop + cookie headers.
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) responseHeaders.delete(h);
    responseHeaders.delete('x-codeflare-operator-boundary-selection');
    if (selection) responseHeaders.set('x-codeflare-operator-boundary-selection', selection);
    if (selectionConsumed) {
      responseHeaders.delete('content-length');
      responseHeaders.delete('content-encoding');
    }
    return new Response(body, { status: upstream.status, headers: responseHeaders });
  }
}
