/**
 * container-router - Typed internal-route dispatch for the Container DO.
 *
 * Extracted from index.ts (CF-012) and CF-016: replaces the previous
 * stringly-typed `${method}:${pathname}` Map dispatch with a TYPED route
 * table. Each route is a discriminated-union entry keyed by a route `name`,
 * carrying its HTTP `method`, `path`, and a typed `handle()` that owns parsing
 * its request body and producing its response.
 *
 * The wire protocol is unchanged: the same three paths, methods, and JSON
 * request/response shapes the Worker fan-out and the previous Map dispatch
 * used. Only the in-process dispatch mechanism is typed.
 */
import type { TabConfig } from '../types';
import { toError } from '../lib/error-types';
import { SetSessionIdBodySchema } from '../lib/container-config-schema';
import { validateBucketNameInput, applyPrefsOnRestart } from './container-env';
import {
  setBucketName as applySetBucketName,
  updateEnvVars,
  type ContainerHost,
} from './container-config';
export type { ContainerHost } from './container-config';

const SESSION_ID_KEY = '_sessionId';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// ---------------------------------------------------------------------------
// Per-route typed request/response shapes
// ---------------------------------------------------------------------------

/** POST /_internal/setBucketName request body. */
interface SetBucketNameBody {
  bucketName: string;
  sessionId?: string;
  userEmail?: string;
  userGroups?: string[];
  routeCatalog?: string[];
  defaultRoute?: string;
  defaultReasoning?: string;
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
  // REQ-MEM-001 AC4: user's IANA timezone forwarded by the Worker from
  // preferences.userTimezone. applyBucketName persists it and buildEnvVars
  // surfaces it to the container as USER_TIMEZONE; entrypoint.sh applies the
  // three-artifact contract (export TZ, /etc/timezone, /etc/localtime symlink).
  userTimezone?: string;
  // REQ-GITHUB-004: one-shot clone directive forwarded by the Worker from the
  // session's `clone` field. applyBucketName stores it in instance memory and
  // buildEnvVars surfaces it to the container as GIT_CLONE_REPO/GIT_CLONE_REF.
  gitCloneRepo?: string;
  gitCloneRef?: string;
  sleepAfter?: string;
}

/** Successful POST /_internal/setBucketName response (200). */
interface SetBucketNameResponse {
  success: true;
  bucketName: string;
}

/** Successful PUT /_internal/setSessionId response (200). */
interface SetSessionIdResponse {
  success: true;
}

/** GET /_internal/getBucketName response (200). */
interface GetBucketNameResponse {
  bucketName: string | null;
}

// ---------------------------------------------------------------------------
// Typed route table
// ---------------------------------------------------------------------------

/**
 * One typed internal route. `name` is the discriminant; `method` + `path`
 * reproduce the wire contract that the old `${method}:${pathname}` key
 * encoded; `handle` owns body parsing and response construction.
 */
export interface InternalRoute {
  readonly name: 'setBucketName' | 'setSessionId' | 'getBucketName';
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  handle(host: ContainerHost, request: Request): Promise<Response>;
}

/**
 * The typed dispatch table. Order is irrelevant - lookup is by exact
 * (method, path) match in dispatchInternalRoute. Exported for unit testing
 * (CF-016).
 */
export const INTERNAL_ROUTES: readonly InternalRoute[] = [
  {
    name: 'setBucketName',
    method: 'POST',
    path: '/_internal/setBucketName',
    handle: handleSetBucketName,
  },
  {
    name: 'setSessionId',
    method: 'PUT',
    path: '/_internal/setSessionId',
    handle: handleSetSessionId,
  },
  {
    name: 'getBucketName',
    method: 'GET',
    path: '/_internal/getBucketName',
    handle: handleGetBucketName,
  },
];

/**
 * Look up the typed route for an inbound request and run its handler. Returns
 * null when the request is not an internal route, so the caller falls through
 * to the standard container-forward path (e.g. POST /internal/bisync-trigger,
 * WebSocket upgrades). This preserves the exact fall-through semantics the old
 * Map.get(routeKey) miss produced.
 */
export function dispatchInternalRoute(
  host: ContainerHost,
  request: Request,
): Promise<Response> | null {
  const url = new URL(request.url);
  const route = INTERNAL_ROUTES.find(
    (r) => r.method === request.method && r.path === url.pathname,
  );
  if (!route) return null;
  return route.handle(host, request);
}

// ---------------------------------------------------------------------------
// Handlers (bodies preserved verbatim from index.ts)
// ---------------------------------------------------------------------------

/** Handle POST /_internal/setBucketName. */
async function handleSetBucketName(host: ContainerHost, request: Request): Promise<Response> {
  try {
    const { bucketName, sessionId, userEmail, userGroups, routeCatalog, defaultRoute, defaultReasoning, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint, workspaceSyncEnabled, fastStartEnabled, tabConfig, openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId, encryptionKey, sessionMode, userTimezone, gitCloneRepo, gitCloneRef, sleepAfter: sleepAfterPref } =
      await request.json() as SetBucketNameBody;

    // FIX-28: Idempotency - once bucket name is set, reject subsequent calls.
    // But always store sessionId so collectMetrics/onStop can find the KV entry
    // (sessionId may be missing if the DO was created before SESSION_ID_KEY existed).
    if (host._bucketName) {
      // Update user preferences on restart even though bucket is already set.
      // Without this, preference changes made between sessions are lost.
      const prefsChanged = await applyPrefsOnRestart(host, host.ctx.storage, {
        sessionId, userEmail, userGroups, routeCatalog, defaultRoute, defaultReasoning,
        workspaceSyncEnabled, fastStartEnabled, tabConfig,
        openaiApiKey, geminiApiKey, githubToken, cloudflareApiToken, cloudflareAccountId,
        encryptionKey, sessionMode, userTimezone,
      });

      // Update idle timeout on restart. Storage key is 'sleepAfter' for
      // backwards compat; the SDK's sleepAfter property is pinned to 24h.
      if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
        host.idleTimeoutPref = sleepAfterPref;
        await host.ctx.storage.put('sleepAfter', sleepAfterPref);
      }

      if (prefsChanged) {
        updateEnvVars(host);
      }

      return new Response(JSON.stringify({ error: 'Bucket name already set' }), {
        status: 409,
        headers: JSON_HEADERS,
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
        headers: JSON_HEADERS,
      });
    }

    // Store sessionId BEFORE setBucketName - updateEnvVars() inside
    // setBucketName reads host._sessionId to populate SESSION_ID env var
    if (sessionId) {
      await host.ctx.storage.put(SESSION_ID_KEY, sessionId);
      host._sessionId = sessionId;
    }

    // Store user email for Timekeeper pings
    if (userEmail) {
      await host.ctx.storage.put('userEmail', userEmail);
      host._userEmail = userEmail;
    }

    // Store the matched Access groups for per-group gateway attribution (one
    // cf-aig-metadata tag per group). REQ-ENTERPRISE-004 (revised).
    if (userGroups && userGroups.length > 0) {
      await host.ctx.storage.put('userGroups', userGroups);
      host._userGroups = userGroups;
    }

    // Store the dynamic-route catalog + resolved default route:reasoning so
    // buildEnvVars emits them for entrypoint.sh on each container start.
    // REQ-ENTERPRISE-005 (revised).
    // The default route + reasoning travel as a unit with the catalog (they are only
    // ever sent alongside a non-empty catalog — see buildSetBucketNameBody), so the
    // writes are nested under catalog presence. This self-guards the non-enterprise
    // path: with no catalog on the wire, a stray empty-string default cannot write
    // enterprise route state into a non-enterprise container.
    if (routeCatalog && routeCatalog.length > 0) {
      await host.ctx.storage.put('routeCatalog', routeCatalog);
      host._routeCatalog = routeCatalog;
      // `!== undefined`, not truthiness: an empty-string default route/reasoning is the
      // meaningful "admin cleared / default drifted out of catalog" reset (reasoning-off or
      // first-route fallback) and must be stored as such — matching applyPrefsOnRestart's
      // documented empty-reset contract. buildEnvVars omits the env var when state holds '',
      // so an empty value surfaces downstream as "reasoning off" / first route.
      if (defaultRoute !== undefined) {
        await host.ctx.storage.put('defaultRoute', defaultRoute);
        host._defaultRoute = defaultRoute;
      }
      if (defaultReasoning !== undefined) {
        await host.ctx.storage.put('defaultReasoning', defaultReasoning);
        host._defaultReasoning = defaultReasoning;
      }
    }

    await applySetBucketName(host, bucketName, {
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
      // REQ-GITHUB-004: one-shot clone directive. Only on the first (create→start)
      // call — the restart path (409 idempotent branch above) does not re-apply it.
      gitCloneRepo,
      gitCloneRef,
    });

    // Apply user-configurable idle timeout (validated values: 5m, 15m, 30m, 1h, 2h).
    // Storage key is 'sleepAfter' for backwards compat with existing sessions.
    if (sleepAfterPref && /^(5m|15m|30m|1h|2h)$/.test(sleepAfterPref)) {
      host.idleTimeoutPref = sleepAfterPref;
      await host.ctx.storage.put('sleepAfter', sleepAfterPref);
      host.logger.info('idle timeout set from user preference', { idleTimeout: sleepAfterPref });
    }

    const body: SetBucketNameResponse = { success: true, bucketName };
    return new Response(JSON.stringify(body), {
      headers: JSON_HEADERS,
    });
  } catch (err) {
    host.logger.error('setBucketName failed', toError(err));
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}

/** Handle PUT /_internal/setSessionId (idempotent). */
async function handleSetSessionId(host: ContainerHost, request: Request): Promise<Response> {
  try {
    const parsed = SetSessionIdBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const { sessionId } = parsed.data;
    if (sessionId) {
      await host.ctx.storage.put(SESSION_ID_KEY, sessionId);
      host._sessionId = sessionId;
    }
    const body: SetSessionIdResponse = { success: true };
    return new Response(JSON.stringify(body), {
      headers: JSON_HEADERS,
    });
  } catch (err) {
    host.logger.error('setSessionId failed', toError(err));
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}

/** Handle GET /_internal/getBucketName. */
function handleGetBucketName(host: ContainerHost): Promise<Response> {
  const body: GetBucketNameResponse = { bucketName: host._bucketName };
  return Promise.resolve(new Response(JSON.stringify(body), {
    headers: JSON_HEADERS,
  }));
}
