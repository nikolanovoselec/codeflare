/**
 * GitHub integration routes (mounted at /api/github).
 *
 * Connect/disconnect, connection status, and repository listing for the GitHub
 * panel. The token never reaches the browser — `/repos` proxies GitHub
 * server-side with the stored token. Connect is provider-driven (GitHub App in
 * enterprise/EMU, OAuth App in SaaS), so it works even where the SaaS login
 * OAuth App (`OAUTH_CLIENT_ID`) is unset.
 *
 * The matching OAuth callback lives in routes/github-auth.ts
 * (GET /auth/github/connect/callback) so GitHub redirects to a stable path.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getBaseUrl } from '../lib/kv-keys';
import { signOauthState } from '../lib/oauth-state';
import { githubScopeForTier } from '../lib/oauth-scopes';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';
import { getContainerId } from '../lib/container-helpers';
import { parseJsonBody } from '../lib/request-helpers';
import {
  getGithubProvider,
  getGithubConnectionStatus,
  getValidGithubToken,
  disconnectGithub,
  connectStateSecret,
  CONNECT_CALLBACK_PATH,
} from '../lib/github-token';

const logger = createLogger('github-routes');

const REPOS_PER_PAGE = 50;

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

const connectRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'github-connect' });
const reposRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60, keyPrefix: 'github-repos' });
const cloneRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'github-clone' });

// REQ-GITHUB-004: clone-into-running-session. owner/name + optional ref; the
// sessionId targets a specific running container. Same repo shape the
// CreateSessionBody clone field uses, kept in sync intentionally.
const CloneBody = z.object({
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  // ref pattern mirrors the entrypoint.sh clone allowlist (kept in sync with crud.ts).
  ref: z.string().max(255).regex(/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/).optional(),
  sessionId: z.string(),
}).strict();

/**
 * Whether the GitHub repo-browser panel (status/repos/clone) is available for this
 * deployment. Available in every mode now (REQ-GITHUB-007); the advanced-session
 * entitlement is enforced in the frontend (sessionMode === 'advanced'), matching the
 * Vault gate. Connect/disconnect are intentionally NOT gated on this — they are
 * authMiddleware-only so the Guided Setup + Settings connect surfaces work for every
 * authenticated user, independent of the panel.
 */
function githubFeatureEnabled(_env: Env): boolean {
  return true;
}

interface GithubRepoApiResponse {
  full_name: string;
  name: string;
  owner?: { login?: string };
  private: boolean;
  visibility?: string;
  default_branch?: string;
  updated_at?: string;
}

interface RepoSummary {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  visibility: string;
  default_branch: string;
  updated_at: string;
}

function toRepoSummary(repo: GithubRepoApiResponse): RepoSummary {
  return {
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
    private: repo.private,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    default_branch: repo.default_branch ?? 'main',
    updated_at: repo.updated_at ?? '',
  };
}

// GET /api/github/status — connection state (never the token).
app.get('/status', async (c) => {
  if (!githubFeatureEnabled(c.env)) return c.json({ enabled: false, connected: false });
  const status = await getGithubConnectionStatus(c.env, c.get('bucketName'));
  const provider = await getGithubProvider(c.env);
  return c.json({ enabled: true, configured: provider !== null, ...status });
});

// GET /api/github/repos?page= — the user's accessible repos (server-side proxy).
app.get('/repos', reposRateLimiter, async (c) => {
  if (!githubFeatureEnabled(c.env)) return c.json({ error: 'GitHub integration disabled', code: 'GITHUB_DISABLED' }, 403);

  const token = await getValidGithubToken(c.env, c.get('bucketName'));
  if (!token) return c.json({ error: 'GitHub not connected', code: 'NOT_CONNECTED' }, 401);

  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const apiHost = c.env.GITHUB_API_HOST?.trim() || 'api.github.com';
  const params = new URLSearchParams({
    sort: 'updated',
    per_page: String(REPOS_PER_PAGE),
    page: String(page),
    affiliation: 'owner,collaborator,organization_member',
  });

  let upstream: Response;
  try {
    upstream = await fetch(`https://${apiHost}/user/repos?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Codeflare',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.error('GitHub repo list fetch failed', toError(err));
    return c.json({ error: 'Failed to reach GitHub', code: 'UPSTREAM_ERROR' }, 502);
  }
  if (!upstream.ok) {
    return c.json({ error: 'GitHub repo list failed', code: 'UPSTREAM_ERROR' }, 502);
  }

  const raw = (await upstream.json()) as GithubRepoApiResponse[];
  const repos = raw.map(toRepoSummary);

  return c.json({ repos, page, hasMore: raw.length === REPOS_PER_PAGE });
});

// GET /api/github/connect — start the provider authorize flow (302 to GitHub).
// Browser-navigated (the panel sets window.location), so it carries the session
// cookie through authMiddleware; the matching callback re-derives identity.
app.get('/connect', connectRateLimiter, async (c) => {
  // NOT panel-gated: any authenticated user can connect (Guided Setup + Settings).
  const provider = await getGithubProvider(c.env);
  if (!provider) return c.json({ error: 'GitHub integration not configured', code: 'GITHUB_NOT_CONFIGURED' }, 503);

  const secret = connectStateSecret(c.env);
  if (!secret) return c.json({ error: 'GitHub integration not configured', code: 'GITHUB_NOT_CONFIGURED' }, 503);

  const base = await getBaseUrl(c.env.KV, c.req.url);
  // Bind the state to the initiating user's bucket so the callback can only
  // redeem it against the same session — closes the OAuth token-fixation CSRF
  // where an attacker's code+state plants the attacker's token in a victim's
  // bucket (the callback re-derives identity from the ambient cookie).
  const state = await signOauthState(secret, c.get('bucketName'));
  const redirectUri = `${base}${CONNECT_CALLBACK_PATH}`;
  // Scope tier (minimal|recommended|advanced) from the connect URL; the OAuth-App
  // path honours it, the GitHub App path ignores it (fixed App permissions).
  const scope = githubScopeForTier(c.req.query('tier'));
  return c.redirect(provider.authorizeUrl({ state, redirectUri, scope }));
});

// POST /api/github/disconnect — revoke at GitHub (app/oauth) + clear the token.
app.post('/disconnect', connectRateLimiter, async (c) => {
  // NOT panel-gated: connect/disconnect are authMiddleware-only (see /connect).
  await disconnectGithub(c.env, c.get('bucketName'));
  return c.json({ success: true });
});

// POST /api/github/clone — clone a repo into an already-running session's
// workspace (REQ-GITHUB-004 running-session path). The new-session path is
// handled by POST /api/sessions with a `clone` field, not here. Forwards to the
// container DO's /internal/git-clone host endpoint; the DO's fetch() override
// injects the CONTAINER_AUTH_TOKEN bearer for the no-underscore /internal path.
// The upstream status (200 cloned / 409 collision / 502 failed / 504 timeout) is
// relayed verbatim so the client sees the real outcome.
app.post('/clone', cloneRateLimiter, async (c) => {
  if (!githubFeatureEnabled(c.env)) return c.json({ error: 'GitHub integration disabled', code: 'GITHUB_DISABLED' }, 403);

  const { repo, ref, sessionId } = await parseJsonBody(c, CloneBody);

  const containerId = getContainerId(c.get('bucketName'), sessionId);
  const container = getContainer(c.env.CONTAINER, containerId);

  let upstream: Response;
  try {
    upstream = await container.fetch(
      new Request('http://container/internal/git-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, ...(ref && { ref }) }),
      }),
    );
  } catch (err) {
    logger.error('git-clone container forward failed', toError(err));
    return c.json({ error: 'Failed to reach container', code: 'UPSTREAM_ERROR' }, 502);
  }

  // Relay the upstream JSON + status verbatim (409 stays 409, etc.). A non-JSON
  // upstream body (DO 503 when the container is asleep) collapses to a 503.
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return c.json({ error: 'Container not running', code: 'NOT_RUNNING' }, 503);
  }
  return c.json(payload as Record<string, unknown>, upstream.status as never);
});

export default app;
