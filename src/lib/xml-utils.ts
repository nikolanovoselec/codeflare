/**
 * Escape XML special characters.
 *
 * Sanitization audit (FIX-39): All XML interpolation sites use this function:
 * - storage/upload.ts: escapeXml(p.etag) in CompleteMultipartUpload
 * - storage/delete.ts: escapeXml(key) in DeleteObjects
 * - public/index.ts: escapeXml(email), escapeXml(ip) in notification HTML
 * - r2-client.ts: decodeXmlEntities() applied to extractTag output (FIX-18)
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

/** Decode standard XML entities (&amp; &lt; &gt; &quot; &apos;). */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
