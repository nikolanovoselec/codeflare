import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { validateKey } from './validation';
import { getSseHeaders } from '../../lib/r2-sse';

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

export function buildContentDisposition(rawFilename: string): string {
  // Strip CRLF, quotes, and backslashes for the ASCII fallback filename
  const safeFilename = rawFilename.replace(/[\r\n"\\]/g, '_');
  // Strip CRLF before percent-encoding for filename* (RFC 5987)
  const sanitizedForEncoding = rawFilename.replace(/[\r\n]/g, '_');
  const encodedFilename = encodeURIComponent(sanitizedForEncoding).replace(/'/g, '%27');
  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}

// Extension → Content-Type map for the inline (open-in-new-tab) view mode. Only
// formats that are safe to render same-origin appear here.
const INLINE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/**
 * Content-Type for inline (in-browser-tab) viewing. User-controlled objects are
 * served from the app's own origin, so HTML and SVG MUST NOT be rendered as
 * markup (a malicious `.html`/`.svg` in the user's bucket would otherwise run
 * scripts with the user's session cookie — stored XSS). Images and PDF get their
 * real type (the browser renders them sandboxed); everything else is forced to
 * `text/plain` so it shows as source, never executes. Always paired with
 * `X-Content-Type-Options: nosniff` so the browser cannot sniff text into HTML.
 */
export function safeInlineContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext in INLINE_IMAGE_TYPES) return INLINE_IMAGE_TYPES[ext];
  if (ext === 'pdf') return 'application/pdf';
  return 'text/plain; charset=utf-8';
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
  const signedRequest = await r2Client.sign(objectUrl, { method: 'GET', headers: getSseHeaders(c.env) });
  const r2Response = await fetch(signedRequest);

  if (!r2Response.ok) {
    throw new ContainerError('download', 'R2 fetch failed');
  }

  const filename = sanitizedKey.split('/').pop() || 'download';

  // `?disposition=inline` opens the object in a new browser tab (view) instead of
  // forcing a download. The Content-Type is derived from the extension via the
  // XSS-safe allowlist (never trusting R2's stored type), and nosniff prevents the
  // browser from upgrading text/plain into executable HTML.
  const inline = c.req.query('disposition') === 'inline';
  const headers: Record<string, string> = {
    'Content-Length': r2Response.headers.get('Content-Length') || '',
  };
  if (inline) {
    headers['Content-Type'] = safeInlineContentType(filename);
    headers['Content-Disposition'] = `inline; filename="${filename.replace(/[\r\n"\\]/g, '_')}"`;
    headers['X-Content-Type-Options'] = 'nosniff';
  } else {
    headers['Content-Type'] = r2Response.headers.get('Content-Type') || 'application/octet-stream';
    headers['Content-Disposition'] = buildContentDisposition(filename);
  }

  return new Response(r2Response.body, { headers });
});

export default app;
