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

export const MANAGED_EXTENSION_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactManagedExtensionVersion(value) {
  return typeof value === 'string' && MANAGED_EXTENSION_VERSION_PATTERN.test(value);
}

export const MANAGED_RELEASE_PATH_PREFIXES = Object.freeze([
  '.claude/',
  '.codex/',
  '.gemini/',
  '.copilot/',
  '.config/opencode/',
  '.pi/agent/',
]);

const MANAGED_RETIRED_PATH_PREFIXES = Object.freeze([
  ...MANAGED_RELEASE_PATH_PREFIXES,
  '.agents/',
]);

const RETIRED_PI_EXTENSION_FILES = new Set([
  'review-job-helpers.ts',
  'review-jobs.ts',
  'review-lane-guards.ts',
]);

function validatePathStructure(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MANAGED_RELEASE_LIMITS.pathBytes
    || new TextEncoder().encode(value).byteLength > MANAGED_RELEASE_LIMITS.pathBytes
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('//')
    || /^[A-Za-z]:\//.test(value)
    || value.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    throw new Error(`${label} is an invalid release path: ${String(value)}`);
  }
  return value;
}

export function isManagedReleaseContextModePath(value) {
  return typeof value === 'string' && /(^|[/._-])context-mode([/._-]|$)/i.test(value);
}

export function validateManagedReleasePath(value, label = 'managed release path') {
  const releasePath = validatePathStructure(value, label);
  if (!MANAGED_RELEASE_PATH_PREFIXES.some((prefix) => releasePath.startsWith(prefix))) {
    throw new Error(`${label} is outside the supported managed path roots: ${releasePath}`);
  }
  if (releasePath.startsWith('.pi/agent/npm/')) {
    throw new Error(`${label} is image-owned Pi package metadata: ${releasePath}`);
  }
  if (isManagedReleaseContextModePath(releasePath)) {
    throw new Error(`${label} is an image-owned context-mode path: ${releasePath}`);
  }
  const basename = releasePath.slice(releasePath.lastIndexOf('/') + 1);
  if (RETIRED_PI_EXTENSION_FILES.has(basename)) {
    throw new Error(`${label} names a retired Pi extension: ${releasePath}`);
  }
  return releasePath;
}

export function validateManagedRetiredPath(value, label = 'managed retired path') {
  const releasePath = validatePathStructure(value, label);
  if (!MANAGED_RETIRED_PATH_PREFIXES.some((prefix) => releasePath.startsWith(prefix))) {
    throw new Error(`${label} is outside the supported managed retired path roots: ${releasePath}`);
  }
  if (releasePath.startsWith('.pi/agent/npm/')) {
    throw new Error(`${label} is image-owned Pi package metadata: ${releasePath}`);
  }
  if (isManagedReleaseContextModePath(releasePath)) {
    throw new Error(`${label} is an image-owned context-mode path: ${releasePath}`);
  }
  return releasePath;
}
