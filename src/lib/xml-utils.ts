/**
 * Escape XML special characters.
 *
 * Sanitization audit (FIX-39): All XML interpolation sites use this function:
 * - storage/upload.ts: escapeXml(p.etag) in CompleteMultipartUpload
 * - storage/delete.ts: escapeXml(key) in DeleteObjects
 * - public/index.ts: escapeXml(email), escapeXml(ip) in notification HTML
 * - r2-client.ts: imports decodeXmlEntities() from this file, applied to extractTag output (FIX-18)
 * - r2-client.ts:127 (emptyR2Bucket DeleteObjects): escapeXml(obj.key)
 * No unescaped user input is interpolated into HTML or XML.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Decode standard XML entities (&amp; &lt; &gt; &quot; &apos;).
 * Only used on trusted XML from Cloudflare R2 S3-compatible API responses,
 * never on user-supplied input. Single-pass decode (not recursive).
 */
export function decodeXmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
  };
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (match) => entityMap[match] ?? match);
}
