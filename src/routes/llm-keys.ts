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
import { getAndDecrypt, encryptAndStore, getOrImportKey } from '../lib/kv-crypto';
import { maskSecret, parseJsonBody, firstZodError } from '../lib/request-helpers';

const UpdateLlmKeysBody = z.object({
  openaiApiKey: z.string().min(1).max(256).nullable().optional(),
  geminiApiKey: z.string().min(1).max(256).nullable().optional(),
}).strict();

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

/**
 * GET /api/llm-keys
 * Returns masked keys (never full keys)
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const kvKey = getLlmKeysKey(bucketName);
  const cryptoKey = await getOrImportKey(c.env);
  const stored = await getAndDecrypt<LlmKeys>(c.env.KV, kvKey, cryptoKey);

  return c.json({
    openaiApiKey: maskSecret(stored?.openaiApiKey),
    geminiApiKey: maskSecret(stored?.geminiApiKey),
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
  const raw = await parseJsonBody(c);
  const parsed = UpdateLlmKeysBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  const kvKey = getLlmKeysKey(bucketName);
  const cryptoKey = await getOrImportKey(c.env);
  const existing = await getAndDecrypt<LlmKeys>(c.env.KV, kvKey, cryptoKey) || {};
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
    await encryptAndStore(c.env.KV, kvKey, updated, cryptoKey);
  }

  return c.json({
    openaiApiKey: maskSecret(updated.openaiApiKey),
    geminiApiKey: maskSecret(updated.geminiApiKey),
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
