import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import {
  CONFIGURATION_SECTIONS,
  applicableConfigurationSections,
  buildConfigurationPreview,
  parseConfigurationRevision,
  resolveAdministrationMode,
  validateConfigurationValues,
} from '../../lib/admin-configuration';
import { ADMIN_CONFIGURATION_KEYS } from '../../lib/kv-keys';

const requestSchema = z.object({
  section: z.enum(CONFIGURATION_SECTIONS),
  baseRevision: z.number().int().nonnegative(),
  values: z.unknown(),
}).strict();

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.post('/', requireAdmin, async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON', code: 'validation_error' }, 400);
  }

  const parsedRequest = requestSchema.safeParse(payload);
  if (!parsedRequest.success) {
    return c.json({
      error: 'Invalid configuration preview request',
      code: 'validation_error',
      fields: parsedRequest.error.flatten().fieldErrors,
    }, 400);
  }

  const { section, baseRevision, values: rawValues } = parsedRequest.data;
  const mode = resolveAdministrationMode(c.env);
  if (!applicableConfigurationSections(mode).includes(section)) {
    return c.json({
      error: 'Environment area does not apply to this deployment mode',
      code: 'configuration_section_not_applicable',
      section,
      mode,
    }, 400);
  }

  const currentRevision = parseConfigurationRevision(await c.env.KV.get(ADMIN_CONFIGURATION_KEYS.REVISION));
  if (baseRevision !== currentRevision) {
    return c.json({
      error: 'Environment settings changed after this form was loaded',
      code: 'configuration_revision_conflict',
      currentRevision,
    }, 409);
  }

  const validation = await validateConfigurationValues(c.env, section, mode, rawValues, c.get('user')?.email);
  if (!validation.values) {
    return c.json({
      error: 'Environment values are invalid',
      code: 'validation_error',
      fields: validation.fieldErrors ?? {},
    }, 400);
  }

  return c.json(await buildConfigurationPreview(
    c.env,
    section,
    mode,
    baseRevision,
    currentRevision,
    validation.values,
  ));
});

export default app;
