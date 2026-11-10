import { AwsClient } from 'aws4fetch';
import type { Env, StorageListResult } from '../types';
import { ValidationError } from './error-types';
import { decodeXmlEntities, escapeXml } from './xml-utils';

/**
 * Create an AwsClient configured for Cloudflare R2 (S3-compatible).
 * Throws ValidationError if R2 credentials are not configured.
 */
export function createR2Client(env: Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new ValidationError(
      'R2 credentials not configured. Please refresh the page. Secrets may still be propagating after setup.'
    );
  }
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}

/**
 * Construct an S3-compatible URL for an R2 object.
 */
export function getR2Url(endpoint: string, bucketName: string, key?: string): string {
  const base = endpoint.replace(/\/+$/, '');
  // Inputs are object names, not URL syntax. Encode once at this owner so %2E,
  // query/fragment characters and Unicode remain literal signed object bytes.
  if (!bucketName || /[/\\]/.test(bucketName) || bucketName === '.' || bucketName === '..') {
    throw new ValidationError('Invalid R2 bucket name');
  }
  const path = `/${encodeURIComponent(bucketName)}`
    + (key ? `/${key.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` : '');
  const url = new URL(`${base}${path}`);
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  if (url.pathname !== `${basePath}${path}` || url.search || url.hash) {
    throw new ValidationError('R2 URL changes object identity');
  }
  return `${base}${path}`;
}

/**
 * Parse an S3 ListObjectsV2 XML response into a StorageListResult.
 * Uses regex extraction since Workers runtime lacks DOMParser.
 */
export function parseListObjectsXml(xml: string): StorageListResult {
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);

  const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
  const nextContinuationToken = tokenMatch ? decodeXmlEntities(tokenMatch[1]) : undefined;

  const objects: StorageListResult['objects'] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1];
    const key = extractTag(block, 'Key');
    const size = extractTag(block, 'Size');
    const lastModified = extractTag(block, 'LastModified');
    const etag = extractTag(block, 'ETag');

    if (key && size !== undefined && lastModified) {
      objects.push({
        key,
        size: Number(size),
        lastModified,
        ...(etag ? { etag } : {}),
      });
    }
  }

  const prefixes: string[] = [];
  const prefixRegex = /<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g;
  let prefixMatch;
  while ((prefixMatch = prefixRegex.exec(xml)) !== null) {
    prefixes.push(decodeXmlEntities(prefixMatch[1]));
  }

  return { objects, prefixes, isTruncated, nextContinuationToken };
}

/**
 * Parse an S3 InitiateMultipartUpload XML response and return the UploadId.
 * Throws if UploadId is not found.
 */
export function parseInitiateMultipartUploadXml(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match) {
    throw new Error('Failed to parse UploadId from InitiateMultipartUpload response');
  }
  return match[1];
}

/** Parse S3 DeleteObjects outcomes without treating HTTP success as object success. */
export function parseDeleteObjectsXml(xml: string): {
  deleted: string[];
  errors: { key: string; error: string }[];
} {
  const result = xml.match(/^\s*(?:<\?xml(?:\s+[A-Za-z_][\w:.-]*=(?:"[^"]*"|'[^']*'))*\s*\?>\s*)?<DeleteResult(?:\s+[A-Za-z_][\w:.-]*=(?:"[^"]*"|'[^']*'))*\s*(?:\/>|>([\s\S]*)<\/DeleteResult>)\s*$/);
  const malformed = () => new Error('Malformed DeleteObjects response');
  if (!result) throw malformed();
  const body = result[1] ?? '';
  const deleted: string[] = [];
  const errors: { key: string; error: string }[] = [];
  const seen = new Set<string>();
  const blocks = /<(Deleted|Error)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  for (const match of body.matchAll(blocks)) {
    if (body.slice(cursor, match.index).trim()) throw malformed();
    cursor = match.index + match[0].length;
    const fields = [...match[2].matchAll(/<([A-Za-z_][\w:.-]*)>([^<]*)<\/\1>/g)];
    let fieldCursor = 0;
    const allowed = match[1] === 'Deleted'
      ? ['Key', 'VersionId', 'DeleteMarker', 'DeleteMarkerVersionId']
      : ['Key', 'Code', 'Message', 'VersionId'];
    for (const field of fields) {
      if (match[2].slice(fieldCursor, field.index).trim() || !allowed.includes(field[1])) throw malformed();
      fieldCursor = field.index + field[0].length;
    }
    if (match[2].slice(fieldCursor).trim() || fields.filter(field => field[1] === 'Key').length !== 1) throw malformed();
    const key = extractTag(match[2], 'Key');
    if (!key || seen.has(key)) throw malformed();
    seen.add(key);
    if (match[1] === 'Deleted') deleted.push(key);
    else errors.push({ key, error: extractTag(match[2], 'Message') || extractTag(match[2], 'Code') || 'Delete failed' });
  }
  if (body.slice(cursor).trim()) throw malformed();
  return { deleted, errors };
}

/** Maximum number of pagination iterations to prevent infinite loops */
const MAX_EMPTY_ITERATIONS = 100;

/**
 * Empty an R2 bucket by paginating through all objects and deleting them in batches.
 * Uses S3-compatible ListObjectsV2 + DeleteObjects (multi-delete) via aws4fetch.
 * Returns the total number of deleted objects.
 */
export async function emptyR2Bucket(
  client: AwsClient,
  endpoint: string,
  bucketName: string,
  prefix?: string,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  let totalDeleted = 0;
  let continuationToken: string | undefined;
  let iterations = 0;

  do {
    const listUrl = new URL(getR2Url(endpoint, bucketName));
    listUrl.searchParams.set('list-type', '2');
    listUrl.searchParams.set('max-keys', '1000');
    if (prefix) {
      listUrl.searchParams.set('prefix', prefix);
    }
    if (continuationToken) {
      listUrl.searchParams.set('continuation-token', continuationToken);
    }

    const signed = await client.sign(listUrl.toString());
    const listRes = await fetcher(signed);
    if (!listRes.ok) {
      throw new Error(`ListObjectsV2 failed: HTTP ${listRes.status}`);
    }

    const xml = await listRes.text();
    const parsed = parseListObjectsXml(xml);
    if (parsed.isTruncated && !parsed.nextContinuationToken) {
      throw new Error('Incomplete ListObjectsV2 response: missing continuation token');
    }

    if (parsed.objects.length > 0) {
      // Build S3 DeleteObjects XML body
      const deleteXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Delete><Quiet>true</Quiet>',
        ...parsed.objects.map((obj) => `<Object><Key>${escapeXml(obj.key)}</Key></Object>`),
        '</Delete>',
      ].join('');

      const deleteUrl = `${getR2Url(endpoint, bucketName)}?delete`;
      const deleteSigned = await client.sign(deleteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: deleteXml,
      });
      const deleteRes = await fetcher(deleteSigned);
      if (!deleteRes.ok) {
        throw new Error(`DeleteObjects failed: HTTP ${deleteRes.status}`);
      }

      const outcomes = parseDeleteObjectsXml(await deleteRes.text());
      if (outcomes.errors.length > 0) {
        throw new Error('DeleteObjects reported per-object failures');
      }
      // Quiet success omits successful keys. If keys are returned, require the complete set.
      const expected = new Set(parsed.objects.map(object => object.key));
      if (outcomes.deleted.length > 0 && (outcomes.deleted.length !== expected.size
        || outcomes.deleted.some(key => !expected.has(key)))) {
        throw new Error('Incomplete DeleteObjects response');
      }
      totalDeleted += parsed.objects.length;
    }

    continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    iterations++;
  } while (continuationToken && iterations < MAX_EMPTY_ITERATIONS);

  if (continuationToken) throw new Error('Bucket deletion incomplete: pagination limit reached');
  return totalDeleted;
}

/** Extract the text content of an XML tag, decoding XML entities. */
function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}
