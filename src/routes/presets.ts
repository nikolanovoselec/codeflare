/**
 * Preset routes
 * Handles CRUD operations for saved session presets (max 3 per user)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Preset } from '../types';
import { getPresetsKey } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { MAX_PRESETS, MAX_TABS } from '../lib/constants';
import { ValidationError, NotFoundError } from '../lib/error-types';
import { TabConfigSchema } from '../lib/schemas';

const CreatePresetBody = z.object({
  name: z.string().trim().min(1, 'Preset name cannot be blank').max(50),
  tabs: z.array(TabConfigSchema).min(1).max(MAX_TABS),
}).strict();

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

/**
 * GET /api/presets
 * List user's presets (max 3)
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const key = getPresetsKey(bucketName);
  const presets = await c.env.KV.get<Preset[]>(key, 'json') || [];
  return c.json({ presets });
});

/**
 * POST /api/presets
 * Save a new preset
 */
app.post('/', async (c) => {
  const bucketName = c.get('bucketName');
  const raw = await c.req.json();
  const parsed = CreatePresetBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const key = getPresetsKey(bucketName);
  const presets = await c.env.KV.get<Preset[]>(key, 'json') || [];

  if (presets.length >= MAX_PRESETS) {
    throw new ValidationError(`Maximum of ${MAX_PRESETS} presets allowed`);
  }

  const preset: Preset = {
    id: crypto.randomUUID(),
    name: parsed.data.name,
    tabs: parsed.data.tabs,
    createdAt: new Date().toISOString(),
  };

  presets.push(preset);
  await c.env.KV.put(key, JSON.stringify(presets));

  return c.json({ preset }, 201);
});

/**
 * PATCH /api/presets/:id
 * Rename a preset (atomic label update)
 */
app.patch('/:id', async (c) => {
  const bucketName = c.get('bucketName');
  const presetId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = z.object({ label: z.string().trim().min(1, 'Label cannot be blank').max(50) }).strict().safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const key = getPresetsKey(bucketName);
  const presets = await c.env.KV.get<Preset[]>(key, 'json') || [];

  const index = presets.findIndex(p => p.id === presetId);
  if (index === -1) {
    throw new NotFoundError('Preset', presetId);
  }

  presets[index].name = parsed.data.label;
  await c.env.KV.put(key, JSON.stringify(presets));

  return c.json({ preset: presets[index] });
});

/**
 * DELETE /api/presets/:id
 * Delete a preset
 */
app.delete('/:id', async (c) => {
  const bucketName = c.get('bucketName');
  const presetId = c.req.param('id');
  const key = getPresetsKey(bucketName);
  const presets = await c.env.KV.get<Preset[]>(key, 'json') || [];

  const index = presets.findIndex(p => p.id === presetId);
  if (index === -1) {
    throw new NotFoundError('Preset', presetId);
  }

  presets.splice(index, 1);
  await c.env.KV.put(key, JSON.stringify(presets));

  return c.json({ success: true, deleted: true, id: presetId });
});

export default app;
