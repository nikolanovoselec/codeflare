import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { validateKey } from './validation';

/**
 * Build a safe Content-Disposition header value.
 * Sanitizes CRLF and other dangerous characters from the raw filename
 * BEFORE encoding, preventing header injection attacks.
 */
const storageDownloadRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: 'storage-download',
});

function buildContentDisposition(rawFilename: string): string {
  // Strip CRLF, quotes, and backslashes for the ASCII fallback filename
  const safeFilename = rawFilename.replace(/[\r\n"\\]/g, '_');
  // Strip CRLF before percent-encoding for filename* (RFC 5987)
  const sanitizedForEncoding = rawFilename.replace(/[\r\n]/g, '_');
  const encodedFilename = encodeURIComponent(sanitizedForEncoding).replace(/'/g, '%27');
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageDownloadRateLimiter);

app.get('/', async (c) => {
  const key = c.req.query('key');

  if (!key) {
    throw new ValidationError('Missing required query parameter: key');
  }

  const sanitizedKey = validateKey(key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const objectUrl = getR2Url(endpoint, bucketName, sanitizedKey);

  // Sign the request for R2 auth and stream the response through the worker.
  // Previously this returned a 302 redirect to a presigned R2 URL, but that
  // caused CORS failures since the browser followed the redirect cross-origin.
  const signedRequest = await r2Client.sign(objectUrl, { method: 'GET' });
  const r2Response = await fetch(signedRequest);

  if (!r2Response.ok) {
    throw new ContainerError('download', 'R2 fetch failed');
  }

  const filename = sanitizedKey.split('/').pop() || 'download';

  return new Response(r2Response.body, {
    headers: {
      'Content-Type': r2Response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Disposition': buildContentDisposition(filename),
      'Content-Length': r2Response.headers.get('Content-Length') || '',
    },
  });
});

export default app;
