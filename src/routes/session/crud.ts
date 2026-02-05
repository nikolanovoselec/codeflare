/**
 * Session CRUD routes
 * Handles GET/POST/PATCH/DELETE operations for sessions
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getContainer } from '@cloudflare/containers';
import { AgentTypeSchema, type Env, type Session, type AgentType, type TabConfig } from '../../types';
import { getSessionKey, getSessionPrefix, generateSessionId, getSessionOrThrow, listAllKvKeys, sanitizeSessionName } from '../../lib/kv-keys';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { MAX_SESSION_NAME_LENGTH, MAX_TABS, SESSION_ID_PATTERN } from '../../lib/constants';
import { getContainerId } from '../../lib/container-helpers';
import { createLogger } from '../../lib/logger';
import { ValidationError } from '../../lib/error-types';
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

  // Fetch session data for each key (parallel for better performance)
  const sessionPromises = keys.map(key => c.env.KV.get<Session>(key.name, 'json'));
  const sessionResults = await Promise.all(sessionPromises);
  const sessions: Session[] = sessionResults.filter((s): s is Session => s !== null);

  // Sort by lastAccessedAt (most recent first)
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
  const raw = await c.req.json();
  const parsed = CreateSessionBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  let sessionName = parsed.data.name?.trim() || 'Terminal';
  sessionName = sanitizeSessionName(sessionName);

  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  const session: Session = {
    id: sessionId,
    name: sessionName,
    userId: bucketName,
    createdAt: now,
    lastAccessedAt: now,
    ...(parsed.data.agentType && { agentType: parsed.data.agentType }),
    ...(parsed.data.tabConfig && { tabConfig: parsed.data.tabConfig }),
  };

  // Store session in KV
  const key = getSessionKey(bucketName, sessionId);
  await c.env.KV.put(key, JSON.stringify(session));

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
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format' }, 400);
  }
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
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format' }, 400);
  }
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  const raw = await c.req.json();
  const parsed = UpdateSessionBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  // Update fields
  if (parsed.data.name) {
    session.name = sanitizeSessionName(parsed.data.name);
  }
  if (parsed.data.tabConfig) {
    session.tabConfig = parsed.data.tabConfig;
  }
  session.lastAccessedAt = new Date().toISOString();

  // Save updated session
  await c.env.KV.put(key, JSON.stringify(session));

  // Omit userId from API response
  return c.json({ session: toApiSession(session) });
});

/**
 * DELETE /api/sessions/:id
 * Delete a session
 */
app.delete('/:id', async (c) => {
  const reqLogger = logger.child({ requestId: c.get('requestId') });
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format' }, 400);
  }
  const key = getSessionKey(bucketName, sessionId);

  // Check if session exists
  await getSessionOrThrow(c.env.KV, key);

  const containerId = getContainerId(bucketName, sessionId);
  const container = getContainer(c.env.CONTAINER, containerId);

  // Note: We don't call prepareShutdown here because destroy() follows immediately.
  // The entrypoint.sh SIGTERM handler provides the sync safety net for direct deletion.

  // Destroy container FIRST — if this fails, keep KV entry so user can retry deletion
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
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format' }, 400);
  }
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  session.lastAccessedAt = new Date().toISOString();
  await c.env.KV.put(key, JSON.stringify(session));

  return c.json({ session: toApiSession(session) });
});

export default app;
