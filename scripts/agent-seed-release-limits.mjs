/** Fixed seed-v1 trust-boundary limits shared by the release compiler and Worker. */
export const MANAGED_RELEASE_CONTENT_TYPES = Object.freeze([
  'text/markdown; charset=utf-8',
  'text/plain; charset=utf-8',
  'application/json; charset=utf-8',
  'text/yaml; charset=utf-8',
  'text/csv; charset=utf-8',
  'text/html; charset=utf-8',
  'image/svg+xml',
  'application/x-shellscript; charset=utf-8',
  'text/x-python; charset=utf-8',
  'text/typescript; charset=utf-8',
  'text/javascript; charset=utf-8',
]);

export const MANAGED_RELEASE_LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  documentCount: 5_000,
  documentBytes: 1024 * 1024,
  totalDocumentBytes: 24 * 1024 * 1024,
  pathBytes: 512,
  retiredPathCount: 5_000,
  extensionCount: 20,
  extensionBytes: 128 * 1024 * 1024,
  aggregateExtensionBytes: 256 * 1024 * 1024,
  redirectCount: 1,
});
