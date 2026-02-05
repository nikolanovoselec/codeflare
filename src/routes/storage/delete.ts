import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { validateKey } from './validation';

const logger = createLogger('storage-delete');

const MAX_DELETE_KEYS = 1000;

const DeleteBodySchema = z.object({
  keys: z.array(z.string().max(1024)).min(1, 'keys must be a non-empty array').max(MAX_DELETE_KEYS),
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = DeleteBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const { keys } = parsed.data;

  // Validate all keys first
  for (const key of keys) {
    validateKey(key);
  }

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const deleted: string[] = [];
  const errors: { key: string; error: string }[] = [];

  if (keys.length === 1) {
    // Single delete
    const key = keys[0];
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
  } else {
    // Batch delete via POST /{bucket}?delete
    const objectsXml = keys
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

  logger.info('Delete operation completed', { deleted: deleted.length, errors: errors.length });

  return c.json({ deleted, errors });
});

export default app;
