/**
 * Session CRUD routes
 * Handles GET/POST/PATCH/DELETE operations for sessions
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getContainer } from '@cloudflare/containers';
import { AgentTypeSchema, type Env, type Session } from '../../types';
import { getSessionKey, getSessionPrefix, generateSessionId, getSessionOrThrow, listAllKvKeys, sanitizeSessionName, putSessionWithMetadata } from '../../lib/kv-keys';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { MAX_SESSION_NAME_LENGTH, MAX_TABS } from '../../lib/constants';
import { getContainerId } from '../../lib/container-helpers';
import { createLogger } from '../../lib/logger';
import { ValidationError } from '../../lib/error-types';
import { getTierConfig, getUserTier, getEffectiveTier, isEnterpriseMode } from '../../lib/subscription';
import { allowedAgents } from '../../lib/agent-allowlist';
import { isSaasModeActive } from '../../lib/onboarding';
import { parseJsonBody, validateSessionId } from '../../lib/request-helpers';
import { toApiSession } from '../../lib/session-helpers';
import { TabConfigSchema } from '../../lib/schemas';

const CreateSessionBody = z.object({
  name: z.string().trim().min(1, 'Session name cannot be blank').max(MAX_SESSION_NAME_LENGTH).optional(),
  agentType: AgentTypeSchema.optional(),
  tabConfig: z.array(TabConfigSchema).min(1).max(MAX_TABS).optional(),
}).strict();

const UpdateSessionBody = z.object({
  name: z.string().trim().min(1, 'Session name cannot be blank').max(MAX_SESSION_NAME_LENGTH).optional(),
  tabConfig: z.array(TabConfigSchema).min(1).max(MAX_TABS).optional(),
}).strict();

const logger = createLogger('session-crud');

/**
 * Rate limiter for session creation
 * Limits to 10 session creations per minute per user
 */
const sessionCreateRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10,     // 10 sessions per minute
  keyPrefix: 'session-create',
});

/**
 * Rate limiter for session deletion
 * Limits to 10 session deletions per minute per user
 */
const sessionDeleteRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'session-delete',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /api/sessions
 * List all sessions for the authenticated user
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const prefix = getSessionPrefix(bucketName);

  // List all sessions for this user from KV (with pagination for >1000 keys)
  const keys = await listAllKvKeys(c.env.KV, prefix);

  // The response body needs name/createdAt/lastAccessedAt, which list metadata
  // does NOT carry, so every key still needs its full record. Bound the
  // fan-out with a chunked concurrency limiter (batches of 20) instead of an
  // unbounded Promise.all over all keys.
  const sessions: Session[] = [];
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const results = await Promise.all(
      chunk.map(key => c.env.KV.get<Session>(key.name, 'json'))
    );
    for (const session of results) {
      if (session !== null) sessions.push(session);
    }
  }

  // Sort by lastAccessedAt (most recent first). KV status is authoritative -
  // the container writes 'stopped' on exit, so no read-side reconciliation.
  sessions.sort(
    (a, b) =>
      new Date(b.lastAccessedAt).getTime() -
      new Date(a.lastAccessedAt).getTime()
  );

  // Omit userId from API responses
  const sanitizedSessions = sessions.map(toApiSession);

  return c.json({ sessions: sanitizedSessions });
});

/**
 * POST /api/sessions
 * Create a new session
 * Rate limited to 10 requests per minute per user
 */
app.post('/', sessionCreateRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  const body = await parseJsonBody(c, CreateSessionBody);

  // Enterprise deploys restrict the selectable agent set (REQ-ENTERPRISE-003).
  // Outside enterprise mode allowedAgents() returns all 7, so this never rejects.
  if (body.agentType && !allowedAgents(c.env).includes(body.agentType)) {
    throw new ValidationError(`Agent type '${body.agentType}' is not available in this deployment`);
  }

  // Storage quota check — block session start if over quota. Enterprise users
  // are unlimited (custom tier, no storage cap), so the gate is skipped entirely.
  // No-op when ENTERPRISE_MODE is unset.
  if (isSaasModeActive(c.env.SAAS_MODE) && !isEnterpriseMode(c.env)) {
    const user = c.get('user');
    const tiers = await getTierConfig(c.env.KV);
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
    const tier = getUserTier(effectiveTier, tiers);
    if (tier.maxStorageBytes !== null && tier.maxStorageBytes !== undefined) {
      const statsCached = await c.env.KV.get(`storage-stats:${bucketName}`, 'json') as { totalSizeBytes: number } | null;
      if (statsCached && statsCached.totalSizeBytes > tier.maxStorageBytes) {
        const usedMB = Math.round(statsCached.totalSizeBytes / 1048576);
        const limitMB = Math.round(tier.maxStorageBytes / 1048576);
        throw new ValidationError(
          `Storage quota exceeded (${usedMB} MB / ${limitMB} MB). Delete files from your storage to free up space, then try again.`
        );
      }
    }
  }

  let sessionName = body.name?.trim() || 'Terminal';
  sessionName = sanitizeSessionName(sessionName);

  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  const session: Session = {
    id: sessionId,
    name: sessionName,
    userId: bucketName,
    createdAt: now,
    lastAccessedAt: now,
    ...(body.agentType && { agentType: body.agentType }),
    ...(body.tabConfig && { tabConfig: body.tabConfig }),
  };

  // Store session in KV
  const key = getSessionKey(bucketName, sessionId);
  await putSessionWithMetadata(c.env.KV, key, session);

  // Omit userId from API response
  return c.json({ session: toApiSession(session) }, 201);
});

/**
 * GET /api/sessions/:id
 * Get a specific session
 */
app.get('/:id', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  validateSessionId(sessionId);
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  // Omit userId from API response
  return c.json({ session: toApiSession(session) });
});

/**
 * PATCH /api/sessions/:id
 * Update session (e.g., rename)
 */
app.patch('/:id', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  validateSessionId(sessionId);
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  const body = await parseJsonBody(c, UpdateSessionBody);

  // Update fields (immutable)
  const updated = {
    ...session,
    ...(body.name ? { name: sanitizeSessionName(body.name) } : {}),
    ...(body.tabConfig ? { tabConfig: body.tabConfig } : {}),
    lastAccessedAt: new Date().toISOString(),
  };

  // Save updated session
  await putSessionWithMetadata(c.env.KV, key, updated);

  // Omit userId from API response
  return c.json({ session: toApiSession(updated) });
});

/**
 * DELETE /api/sessions/:id
 * Delete a session
 */
app.delete('/:id', sessionDeleteRateLimiter, async (c) => {
  const reqLogger = logger.child({ requestId: c.get('requestId') });
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  validateSessionId(sessionId);
  const key = getSessionKey(bucketName, sessionId);

  // Check if session exists
  await getSessionOrThrow(c.env.KV, key);

  const containerId = getContainerId(bucketName, sessionId);
  const container = getContainer(c.env.CONTAINER, containerId);

  // The DO's destroy() override drains a final R2 bisync while the container is
  // still alive, BEFORE signalling stop (REQ-SESSION-011); the entrypoint trap
  // is only a best-effort backstop. Destroy FIRST so a failure leaves the KV
  // entry intact for retry.
  try {
    await container.destroy();
    reqLogger.info('Destroyed container', { containerId });
  } catch (err) {
    reqLogger.warn('Could not destroy container', { containerId, error: String(err) });
  }

  // Delete from KV only after container destruction attempt
  await c.env.KV.delete(key);

  return c.json({ success: true, deleted: true, id: sessionId });
});

/**
 * POST /api/sessions/:id/touch
 * Update lastAccessedAt timestamp
 */
app.post('/:id/touch', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  validateSessionId(sessionId);
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  const updated = { ...session, lastAccessedAt: new Date().toISOString() };
  await putSessionWithMetadata(c.env.KV, key, updated);

  return c.json({ session: toApiSession(updated) });
});

export default app;
