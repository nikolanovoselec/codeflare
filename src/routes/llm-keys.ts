/**
 * LLM API key management routes
 * Handles GET/PUT/DELETE for user-scoped LLM provider API keys
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, LlmKeys } from '../types';
import { getLlmKeysKey } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { ValidationError } from '../lib/error-types';

const UpdateLlmKeysBody = z.object({
  openaiApiKey: z.string().max(256).nullable().optional(),
  geminiApiKey: z.string().max(256).nullable().optional(),
}).strict();

/**
 * Mask an API key for safe display: show only last 4 characters.
 * Returns undefined if the key is not set.
 */
function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 4) return '****';
  return '****' + key.slice(-4);
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

/**
 * GET /api/llm-keys
 * Returns masked keys (never full keys)
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const key = getLlmKeysKey(bucketName);
  const stored = await c.env.KV.get<LlmKeys>(key, 'json');

  return c.json({
    openaiApiKey: maskKey(stored?.openaiApiKey),
    geminiApiKey: maskKey(stored?.geminiApiKey),
  });
});

/**
 * PUT /api/llm-keys
 * Set or clear individual keys.
 * - string value: set the key
 * - null: delete the key
 * - undefined/omitted: no change
 * Returns masked keys after update.
 */
app.put('/', async (c) => {
  const bucketName = c.get('bucketName');
  const raw = await c.req.json();
  const parsed = UpdateLlmKeysBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const kvKey = getLlmKeysKey(bucketName);
  const existing = await c.env.KV.get<LlmKeys>(kvKey, 'json') || {};
  const updated: LlmKeys = { ...existing };

  // null = delete, undefined = no change, string = set
  if (parsed.data.openaiApiKey === null) {
    delete updated.openaiApiKey;
  } else if (typeof parsed.data.openaiApiKey === 'string') {
    updated.openaiApiKey = parsed.data.openaiApiKey;
  }

  if (parsed.data.geminiApiKey === null) {
    delete updated.geminiApiKey;
  } else if (typeof parsed.data.geminiApiKey === 'string') {
    updated.geminiApiKey = parsed.data.geminiApiKey;
  }

  // If both keys are cleared, remove the KV entry entirely
  if (!updated.openaiApiKey && !updated.geminiApiKey) {
    await c.env.KV.delete(kvKey);
  } else {
    await c.env.KV.put(kvKey, JSON.stringify(updated));
  }

  return c.json({
    openaiApiKey: maskKey(updated.openaiApiKey),
    geminiApiKey: maskKey(updated.geminiApiKey),
  });
});

/**
 * DELETE /api/llm-keys
 * Remove all LLM keys from KV
 */
app.delete('/', async (c) => {
  const bucketName = c.get('bucketName');
  const kvKey = getLlmKeysKey(bucketName);
  await c.env.KV.delete(kvKey);

  return c.json({ success: true });
});

export default app;
