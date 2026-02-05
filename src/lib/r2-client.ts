import { AwsClient } from 'aws4fetch';
import type { Env, StorageListResult } from '../types';
import { ValidationError } from './error-types';

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
  const nextContinuationToken = tokenMatch ? tokenMatch[1] : undefined;

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
    prefixes.push(prefixMatch[1]);
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

/** Decode standard XML entities (&amp; &lt; &gt; &quot; &apos;). */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract the text content of an XML tag, decoding XML entities. */
function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}
