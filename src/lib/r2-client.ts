import { AwsClient } from 'aws4fetch';
import type { Env, StorageListResult } from '../types';
import { ValidationError } from './error-types';
import { decodeXmlEntities, escapeXml } from './xml-utils';

/**
 * Create an AwsClient configured for Cloudflare R2 (S3-compatible).
 * Throws ValidationError if R2 credentials are not configured.
 */
export function createR2Client(env: Env): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new ValidationError(
      'R2 credentials not configured. Please refresh the page — secrets may still be propagating after setup.'
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
  if (!key) {
    return `${base}/${bucketName}`;
  }
  const cleanKey = key.replace(/^\/+/, '');
  return `${base}/${bucketName}/${cleanKey}`;
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
  prefix?: string
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
    const listRes = await fetch(signed);
    if (!listRes.ok) {
      throw new Error(`ListObjectsV2 failed: HTTP ${listRes.status}`);
    }

    const xml = await listRes.text();
    const parsed = parseListObjectsXml(xml);

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
      const deleteRes = await fetch(deleteSigned);
      if (!deleteRes.ok) {
        throw new Error(`DeleteObjects failed: HTTP ${deleteRes.status}`);
      }

      totalDeleted += parsed.objects.length;
    }

    continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    iterations++;
  } while (continuationToken && iterations < MAX_EMPTY_ITERATIONS);

  return totalDeleted;
}

/** Extract the text content of an XML tag, decoding XML entities. */
function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}
