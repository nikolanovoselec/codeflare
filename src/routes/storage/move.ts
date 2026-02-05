import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { validateKey, MAX_KEY_LENGTH } from './validation';

const logger = createLogger('storage-move');

const MoveBodySchema = z.object({
  source: z.string({ error: 'source is required' }).min(1, 'source is required').max(MAX_KEY_LENGTH, `source must be at most ${MAX_KEY_LENGTH} characters`),
  destination: z.string({ error: 'destination is required' }).min(1, 'destination is required').max(MAX_KEY_LENGTH, `destination must be at most ${MAX_KEY_LENGTH} characters`),
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = MoveBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;

  validateKey(body.source, 'source');
  validateKey(body.destination, 'destination');

  if (body.source === body.destination) {
    throw new ValidationError('source and destination must be different');
  }

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  // Step 1: CopyObject
  const destUrl = getR2Url(endpoint, bucketName, body.destination);
  const copyResponse = await r2Client.fetch(destUrl, {
    method: 'PUT',
    headers: {
      'x-amz-copy-source': `/${encodeURIComponent(bucketName)}/${body.source.split('/').map(encodeURIComponent).join('/')}`,
    },
  });

  if (!copyResponse.ok) {
    logger.error('R2 CopyObject failed', undefined, { status: copyResponse.status, source: body.source, destination: body.destination });
    throw new ContainerError('move', `R2 CopyObject failed: ${copyResponse.status}`);
  }

  // Step 2: DeleteObject (original)
  const sourceUrl = getR2Url(endpoint, bucketName, body.source);
  let warning: string | undefined;

  try {
    const deleteResponse = await r2Client.fetch(sourceUrl, { method: 'DELETE' });
    if (!deleteResponse.ok && deleteResponse.status !== 204) {
      warning = 'File copied successfully but original could not be deleted';
      logger.warn('R2 DeleteObject failed after copy', { status: deleteResponse.status, source: body.source });
    }
  } catch (err) {
    warning = 'File copied successfully but original could not be deleted';
    logger.warn('R2 DeleteObject error after copy', { source: body.source, error: err });
  }

  const result: { source: string; destination: string; warning?: string } = {
    source: body.source,
    destination: body.destination,
  };
  if (warning) result.warning = warning;

  return c.json(result);
});

export default app;
