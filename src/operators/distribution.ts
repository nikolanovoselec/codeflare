/**
 * Untrusted distribution data boundary
 * Schemas and canonical-path rules precede manifest, endpoint and bundle parsers.
 * These functions validate bounded data and exact artifact integrity, not publisher eligibility.
 * They neither fetch nor execute code; callers own authentication, approval and loader bindings.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { z } from 'zod';
import { ValidationError } from '../lib/error-types';

const MANIFEST_BYTES = 64 * 1024;
const BUNDLE_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** Canonical module/artifact names; URL normalization must not hide traversal. */
function canonicalPath(value: string, absolute: boolean): boolean {
  if (value.length > 512 || value.startsWith('/') !== absolute) return false;
  if (!/^[A-Za-z0-9_@./~-]+$/.test(value)) return false;
  const segments = (absolute ? value.slice(1) : value).split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && segment !== '__proto__' && segment !== 'constructor' && segment !== 'prototype');
}

const relativePath = z.string().refine(value => canonicalPath(value, false));
const artifactPath = z.string().refine(value => canonicalPath(value, true));
const version = z.string().min(1).max(128);
const capability = z.enum(['session', 'pi', 'storage', 'inference', 'fetch']);

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  interfaceVersion: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(4096),
  coreVersion: version,
  intentVersion: version,
  /** Package-management releases bind this optional declaration to the registered profile. */
  profile: z.enum(['conductor', 'dispatcher']).optional(),
  inputSchema: z.record(z.string(), z.json()),
  /** Optional for legacy Gate 1 manifests; managed packages declare it when available. */
  outputSchema: z.record(z.string(), z.json()).optional(),
  requiredCapabilities: z.array(capability).max(5)
    .refine(values => new Set(values).size === values.length),
  artifact: z.strictObject({ path: artifactPath, sha256: z.string().regex(SHA256) }),
});

const moduleSchema = z.union([
  z.strictObject({ js: z.string() }),
  z.strictObject({ text: z.string() }),
]);
const modulesSchema = z.record(relativePath, moduleSchema)
  .refine(modules => Object.keys(modules).length > 0 && Object.keys(modules).length <= 128);
const packageResourcesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(z.strictObject({
    source: relativePath,
    destination: relativePath,
    sha256: z.string().regex(SHA256),
    size: z.number().int().min(0).max(1024 * 1024),
  })).max(64).refine(files => new Set(files.map(file => file.destination)).size === files.length),
});
const bundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  interfaceVersion: z.literal(1),
  compatibilityDate: z.literal('2026-02-05'),
  compatibilityFlags: z.tuple([z.literal('nodejs_compat')]),
  mainModule: relativePath,
  modules: modulesSchema,
  resources: packageResourcesSchema.optional(),
}).refine(bundle => Object.hasOwn(bundle.modules, bundle.mainModule)
  && 'js' in bundle.modules[bundle.mainModule]);

/** Exact profile-CI output accepted by the production Dispatcher facet host. */
const dispatcherBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  versions: z.strictObject({
    runtime: z.literal('2.1.0'), vitePlugin: z.literal('2.1.0'), agents: z.literal('0.20.1'),
  }),
  className: z.literal('FlueDispatcherAgent'),
  compatibilityDate: z.literal('2026-09-10'),
  compatibilityFlags: z.tuple([z.literal('nodejs_compat')]),
  mainModule: relativePath,
  modules: modulesSchema,
}).refine(bundle => Object.hasOwn(bundle.modules, bundle.mainModule)
  && 'js' in bundle.modules[bundle.mainModule]);

/** Validated discovery data; artifact URL is derived, never supplied as authority. */
export type OperatorManifest = z.infer<typeof manifestSchema> & {
  artifact: z.infer<typeof manifestSchema>['artifact'] & { url: string };
};

/** Approved code/static data only; binding and outbound configuration are parent-owned. */
export type OperatorBundle = z.infer<typeof bundleSchema>;
/** Generated Dispatcher class metadata is fixed by the pinned profile build. */
export type DispatcherBundle = z.infer<typeof dispatcherBundleSchema>;

/** Parse external JSON without exposing its contents or parser diagnostics in errors. */
function parseJson<T>(json: string, schema: z.ZodType<T>, message: string): T {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // Malformed JSON and validation failures have the same safe public outcome.
  }
  throw new ValidationError(message);
}

/**
 * REQ-OPERATOR-010: Validate bounded untrusted discovery data without executing it
 * or performing I/O. The registration service supplies the intended endpoint;
 * credentials, user eligibility and redirect rejection belong to that service.
 * Only a canonical origin-relative artifact path is resolved. Returns typed
 * metadata or a safe ValidationError, never reflecting secrets/source in errors.
 * This is not a general URL proxy and does not grant network authorization.
 */
export function parseOperatorManifest(json: string, endpoint: string): OperatorManifest {
  if (new TextEncoder().encode(json).byteLength > MANIFEST_BYTES) {
    throw new ValidationError('Operator manifest exceeds the size limit');
  }
  const url = validateOperatorEndpoint(endpoint);
  const manifest = parseJson(json, manifestSchema, 'Invalid or incompatible operator manifest');
  return {
    ...manifest,
    artifact: { ...manifest.artifact, url: new URL(manifest.artifact.path, url.origin).href },
  };
}

/** Shared lexical endpoint boundary, checked before protected I/O; not DNS authorization. */
export function validateOperatorEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError('Invalid operator distribution endpoint');
  }
  const hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !hostname.includes('.') || /^[\d.]+$/.test(hostname)
    || hostname.startsWith('[') || hostname.endsWith('.localhost')) {
    throw new ValidationError('Invalid operator distribution endpoint');
  }
  return url;
}

/**
 * REQ-OPERATOR-030: Check exact received bytes against the parent-approved SHA-256
 * before parsing the bounded v1 bundle. No module is evaluated and no loader
 * options/bindings are accepted from the artifact. Returns compatible JS/text
 * module data only. Caller must bound the network body before materializing it,
 * authenticate its source and keep approval/admission separate from integrity.
 * No side effects, business retries or credentials; invalid input throws a safe
 * ValidationError. Example: parseOperatorBundle(bytes, registration.artifactDigest).
 */
async function approvedBundleJson(bytes: Uint8Array, digest: string): Promise<string> {
  if (bytes.byteLength > BUNDLE_BYTES || !SHA256.test(digest)) {
    throw new ValidationError('Invalid operator artifact size or digest');
  }
  const approvedBytes = Uint8Array.from(bytes);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', approvedBytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== digest) throw new ValidationError('Operator artifact integrity check failed');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(approvedBytes);
  } catch {
    throw new ValidationError('Invalid operator artifact encoding');
  }
}

export async function parseOperatorBundle(bytes: Uint8Array, digest: string): Promise<OperatorBundle> {
  return parseJson(await approvedBundleJson(bytes, digest), bundleSchema, 'Invalid or incompatible operator artifact');
}

/**
 * REQ-OPERATOR-048: Validate the exact generated Flue class contract without
 * evaluating it. Child compatibility is intentionally independent of the
 * unchanged parent Worker and legacy default-entrypoint bundle contract.
 */
export async function parseDispatcherBundle(bytes: Uint8Array, digest: string): Promise<DispatcherBundle> {
  return parseJson(await approvedBundleJson(bytes, digest), dispatcherBundleSchema,
    'Invalid or incompatible Dispatcher artifact');
}
