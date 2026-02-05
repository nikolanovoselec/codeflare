import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { validateKey } from './validation';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.get('/', async (c) => {
  const key = c.req.query('key');

  if (!key) {
    throw new ValidationError('Missing required query parameter: key');
  }

  validateKey(key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const objectUrl = getR2Url(endpoint, bucketName, key);

  // Sign the request for R2 auth and stream the response through the worker.
  // Previously this returned a 302 redirect to a presigned R2 URL, but that
  // caused CORS failures since the browser followed the redirect cross-origin.
  const signedRequest = await r2Client.sign(objectUrl, { method: 'GET' });
  const r2Response = await fetch(signedRequest);

  if (!r2Response.ok) {
    throw new ContainerError('download', 'R2 fetch failed');
  }

  return new Response(r2Response.body, {
    headers: {
      'Content-Type': r2Response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Disposition': (() => {
        const rawFilename = key.split('/').pop() || 'download';
        const safeFilename = rawFilename.replace(/[\r\n"\\]/g, '_');
        const encodedFilename = encodeURIComponent(rawFilename).replace(/'/g, '%27');
        return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
      })(),
      'Content-Length': r2Response.headers.get('Content-Length') || '',
    },
  });
});

export default app;
