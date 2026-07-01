import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ValidationError, ContainerError, DownloadsDisabledError } from '../../lib/error-types';
import { validateKey } from './validation';
import { fetchObjectWithRegimeFallback, markMixedRecovery } from '../../lib/r2-migration';
import { hasHealthyContainer } from '../../lib/migration-containers';
import { isDownloadsDisabled } from '../../lib/downloads-policy';

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

// Extensions safe to OPEN/VIEW inline under view-only storage. Deny-by-default: any type
// NOT listed here (archives, binaries, media, unknown/extensionless) cannot be opened when
// downloads are disabled, which closes the "request a zip with disposition=inline and read
// its bytes as text/plain" exfil hole. Images + PDF render; the rest view as source text.
const TEXT_VIEWABLE_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'rst', 'html', 'htm', 'xml', 'svg', 'css',
  'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv', 'tsv', 'sql', 'sh', 'bash',
  'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php',
  'pl', 'lua', 'r', 'swift', 'dockerfile', 'gitignore', 'makefile',
]);

/**
 * True when `filename` is safe to OPEN/VIEW inline under view-only storage: an image, a
 * PDF, or a known text/source type. Used only when downloads are disabled to reject inline
 * requests for non-viewable blobs (whose bytes would otherwise leak via the text/plain
 * fallback). Distinct from {@link safeInlineContentType}, which always returns a type.
 */
export function isInlineViewable(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext in INLINE_IMAGE_TYPES || ext === 'pdf' || TEXT_VIEWABLE_EXTENSIONS.has(ext);
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageDownloadRateLimiter);

app.get('/', async (c) => {
  const key = c.req.query('key');

  if (!key) {
    throw new ValidationError('Missing required query parameter: key');
  }

  const sanitizedKey = validateKey(key);

  const filename = sanitizedKey.split('/').pop() || 'download';
  const inline = c.req.query('disposition') === 'inline';

  // View-only storage (enterprise anti-exfil): block file downloads; permit only inline
  // view of viewable types. Enforced server-side BEFORE any R2 fetch, so a blocked request
  // never streams object bytes — the frontend also hides the Download button, but that is
  // not the control. Default OFF / non-enterprise → no KV read, byte-identical to today.
  if (await isDownloadsDisabled(c.env)) {
    if (!inline) {
      throw new DownloadsDisabledError();
    }
    if (!isInlineViewable(filename)) {
      throw new DownloadsDisabledError('This file type cannot be opened in view-only storage; downloads are disabled.');
    }
  }

  const bucketName = c.get('bucketName');
  const { endpoint } = await getR2Config(c.env);
  const objectUrl = getR2Url(endpoint, bucketName, sanitizedKey);

  // REQ-ENTERPRISE-020: read in the bucket's committed regime, falling back to the opposite
  // regime once on an SSE-mismatch so a partially-migrated (or stray-outlier) bucket stays
  // readable. The helper signs + streams the response through the worker (a 302 to a presigned
  // R2 URL caused cross-origin CORS failures). A fallback hit on a ready bucket self-heals via
  // a background mixed-recovery scan.
  const { response: r2Response, stray } = await fetchObjectWithRegimeFallback(c.env, bucketName, objectUrl, { method: 'GET' });
  if (stray) {
    try { c.executionCtx.waitUntil(markMixedRecovery(c.env, bucketName, () => hasHealthyContainer(c.env, bucketName))); } catch { /* no execution context (tests) */ }
  }

  if (!r2Response.ok) {
    throw new ContainerError('download', 'R2 fetch failed');
  }

  // `?disposition=inline` opens the object in a new browser tab (view) instead of
  // forcing a download. The Content-Type is derived from the extension via the
  // XSS-safe allowlist (never trusting R2's stored type), and nosniff prevents the
  // browser from upgrading text/plain into executable HTML.
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
