import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { createRateLimiter } from '../../middleware/rate-limit';
import { createLogger } from '../../lib/logger';
import { validateKey } from './validation';
import { getSseHeaders } from '../../lib/r2-sse';

const logger = createLogger('storage-preview');

const storagePreviewRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: 'storage-preview',
});

const MAX_TEXT_SIZE = 1_048_576; // 1MB

function isTextContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true;
  if (contentType === 'application/json') return true;
  if (contentType === 'application/xml') return true;
  if (contentType === 'application/javascript') return true;
  if (contentType === 'application/typescript') return true;
  if (contentType === 'application/x-yaml') return true;
  if (contentType === 'application/toml') return true;
  if (contentType === 'application/x-sh') return true;
  return false;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storagePreviewRateLimiter);

app.get('/', async (c) => {
  const key = c.req.query('key');

  if (!key) {
    throw new ValidationError('Missing required query parameter: key');
  }

  const validatedKey = validateKey(key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);
  const objectUrl = getR2Url(endpoint, bucketName, validatedKey);

  // HEAD request to get metadata without downloading the full object
  const headResponse = await r2Client.fetch(objectUrl, { method: 'HEAD', headers: getSseHeaders(c.env) });

  if (!headResponse.ok) {
    logger.error('R2 HEAD failed', undefined, { status: headResponse.status, bucketName, key });
    throw new ContainerError('preview', `R2 HEAD failed: ${headResponse.status}`);
  }

  const size = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
  const contentType = headResponse.headers.get('Content-Type') || 'application/octet-stream';
  const lastModified = headResponse.headers.get('Last-Modified') || '';

  // Text files under 1MB: return content inline
  if (isTextContentType(contentType) && size <= MAX_TEXT_SIZE) {
    const getResponse = await r2Client.fetch(objectUrl, { method: 'GET', headers: getSseHeaders(c.env) });
    const content = await getResponse.text();

    return c.json({
      type: 'text',
      content,
      size,
      lastModified,
    });
  }

  // Non-text files: return metadata only
  return c.json({
    type: 'binary',
    size,
    lastModified,
  });
});

export default app;
