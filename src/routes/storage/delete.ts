import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url, emptyR2Bucket } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { createRateLimiter } from '../../middleware/rate-limit';
import { createLogger } from '../../lib/logger';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { validateKey } from './validation';
import { parseJsonBody } from '../../lib/request-helpers';

const logger = createLogger('storage-delete');

const storageDeleteRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: 'storage-delete',
});

const MAX_DELETE_KEYS = 1000;
const MAX_DELETE_PREFIXES = 50;

const DeleteBodySchema = z.object({
  keys: z.array(z.string().max(1024)).max(MAX_DELETE_KEYS).optional(),
  prefixes: z.array(z.string().max(1024)).max(MAX_DELETE_PREFIXES).optional(),
}).refine(
  (data) => (data.keys && data.keys.length > 0) || (data.prefixes && data.prefixes.length > 0),
  { message: 'At least one of keys or prefixes must be a non-empty array' }
);

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageDeleteRateLimiter);

app.post('/', async (c) => {
  const { keys = [], prefixes = [] } = await parseJsonBody(c, DeleteBodySchema);

  // Validate and decode all keys/prefixes
  const validatedKeys = keys.map(key => validateKey(key));
  const validatedPrefixes = prefixes.map(prefix => validateKey(prefix, 'prefix'));

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const deleted: string[] = [];
  const deletedPrefixes: { prefix: string; count: number }[] = [];
  const errors: { key: string; error: string }[] = [];

  // Handle key-based deletes
  if (validatedKeys.length === 1) {
    // Single delete
    const key = validatedKeys[0];
    const url = getR2Url(endpoint, bucketName, key);
    try {
      const response = await r2Client.fetch(url, { method: 'DELETE' });
      if (response.ok || response.status === 204) {
        deleted.push(key);
      } else {
        errors.push({ key, error: `Delete failed: ${response.status}` });
      }
    } catch (err) {
      errors.push({ key, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  } else if (validatedKeys.length > 1) {
    // Batch delete via POST /{bucket}?delete
    const objectsXml = validatedKeys
      .map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`)
      .join('');
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${objectsXml}</Delete>`;

    const url = `${getR2Url(endpoint, bucketName)}?delete`;

    try {
      const response = await r2Client.fetch(url, {
        method: 'POST',
        body: xmlBody,
        headers: { 'Content-Type': 'application/xml' },
      });

      if (response.ok) {
        const responseXml = await response.text();
        // Parse response - <Deleted><Key>...</Key></Deleted> and <Error><Key>...</Key><Message>...</Message></Error>
        const deletedMatches = responseXml.matchAll(/<Deleted>\s*<Key>([^<]+)<\/Key>/g);
        for (const match of deletedMatches) {
          deleted.push(decodeXmlEntities(match[1]));
        }
        const errorMatches = responseXml.matchAll(/<Error>\s*<Key>([^<]+)<\/Key>\s*(?:<Code>[^<]*<\/Code>\s*)?<Message>([^<]+)<\/Message>/g);
        for (const match of errorMatches) {
          errors.push({ key: decodeXmlEntities(match[1]), error: decodeXmlEntities(match[2]) });
        }
        // If we didn't parse any results, assume all succeeded
        if (deleted.length === 0 && errors.length === 0) {
          deleted.push(...keys);
        }
      } else {
        // Batch failed, try individual deletes
        for (const key of keys) {
          try {
            const singleUrl = getR2Url(endpoint, bucketName, key);
            const singleResponse = await r2Client.fetch(singleUrl, { method: 'DELETE' });
            if (singleResponse.ok || singleResponse.status === 204) {
              deleted.push(key);
            } else {
              errors.push({ key, error: `Delete failed: ${singleResponse.status}` });
            }
          } catch (err) {
            errors.push({ key, error: err instanceof Error ? err.message : 'Unknown error' });
          }
        }
      }
    } catch {
      // Batch request failed entirely
      for (const key of keys) {
        errors.push({ key, error: 'Batch delete failed' });
      }
    }
  }

  // Handle prefix-based deletes (server-side list+delete)
  for (const prefix of validatedPrefixes) {
    try {
      const count = await emptyR2Bucket(r2Client, endpoint, bucketName, prefix);
      deletedPrefixes.push({ prefix, count });
    } catch (err) {
      errors.push({ key: prefix, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  logger.info('Delete operation completed', {
    deleted: deleted.length,
    deletedPrefixes: deletedPrefixes.length,
    errors: errors.length,
  });

  // Invalidate storage-stats cache so next poll/fetch gets fresh data
  const totalDeleted = deleted.length + deletedPrefixes.reduce((sum, p) => sum + p.count, 0);
  if (totalDeleted > 0) {
    await c.env.KV.delete(`storage-stats:${bucketName}`);
  }

  return c.json({ deleted, deletedPrefixes, errors });
});

export default app;
