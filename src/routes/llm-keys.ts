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

/**
 * Reject keys containing newlines or non-ASCII characters (header-injection surface).
 * Throws ValidationError if the key is not clean.
 */
function assertCleanKey(provider: string, key: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(key)) {
    throw new ValidationError(`Invalid ${provider} key - contains whitespace or non-ASCII characters`);
  }
}

/**
 * Validate an OpenAI API key by calling a lightweight endpoint.
 * Throws ValidationError if the key is invalid or the provider is unreachable.
 */
async function validateOpenAIKey(key: string): Promise<void> {
  assertCleanKey('OpenAI', key);
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ValidationError('Could not validate OpenAI key - provider unreachable');
  }
  if (!res.ok) {
    throw new ValidationError('Invalid OpenAI key - could not authenticate with OpenAI API');
  }
}

/**
 * Validate a Gemini API key by calling a lightweight endpoint.
 * Throws ValidationError if the key is invalid or the provider is unreachable.
 */
async function validateGeminiKey(key: string): Promise<void> {
  assertCleanKey('Gemini', key);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ValidationError('Could not validate Gemini key - provider unreachable');
  }
  if (!res.ok) {
    throw new ValidationError('Invalid Gemini key - could not authenticate with Gemini API');
  }
}

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

  // null = delete, undefined = no change, string = validate + set
  if (parsed.data.openaiApiKey === null) {
    delete updated.openaiApiKey;
  } else if (typeof parsed.data.openaiApiKey === 'string') {
    await validateOpenAIKey(parsed.data.openaiApiKey);
    updated.openaiApiKey = parsed.data.openaiApiKey;
  }

  if (parsed.data.geminiApiKey === null) {
    delete updated.geminiApiKey;
  } else if (typeof parsed.data.geminiApiKey === 'string') {
    await validateGeminiKey(parsed.data.geminiApiKey);
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
