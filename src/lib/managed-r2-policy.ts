import { z } from 'zod';
import type { ManagedResourcePolicy } from '../types';
import type { ManagedReleaseIndex } from './remote-curation';
import { readBoundedResponse, readBoundedStream } from './bounded-stream';
import { decodeXmlEntities } from './xml-utils';

export const MANAGED_R2_POLICY_KEY = '.codeflare/managed-paths.json';
const MANAGED_EXTENSIONS_KEY = '.codeflare/managed-extensions.json';
const MAX_POLICY_BYTES = 8 * 1024 * 1024;
const MAX_POLICY_PATHS = 10_002;
const MAX_POLICY_ROOTS = 10_000;
const MAX_PATH_BYTES = 512;
const RESOURCE_CATEGORIES = new Set([
  'skills',
  'extensions',
  'rules',
  'hooks',
  'scripts',
  'plugins',
  'prompts',
  'commands',
  'agents',
  'exceptions',
]);
const MANAGED_HOMES = [
  '.claude/',
  '.codex/',
  '.gemini/',
  '.copilot/',
  '.config/opencode/',
  '.pi/agent/',
] as const;

export interface ManagedR2Policy {
  schemaVersion: 1;
  releaseDigest: string;
  resourcePolicy: Exclude<ManagedResourcePolicy, 'mutable'>;
  paths: string[];
  resourceRoots: string[];
}

export interface BuiltManagedR2Policy {
  value: ManagedR2Policy;
  bytes: Uint8Array;
  digest: string;
}

export interface VerifiedManagedR2Policy extends ManagedR2Policy {
  pathsDigest: string;
}

interface ReadVerifiedManagedR2PolicyInput {
  fetchPolicyObject: () => Promise<Response>;
  releaseDigest: string;
  pathsDigest: string;
  expectedPolicy: Exclude<ManagedResourcePolicy, 'mutable'>;
  bypassMemoryCache: boolean;
}

const PolicySchema = z.object({
  schemaVersion: z.literal(1),
  releaseDigest: z.string().regex(/^[0-9a-f]{64}$/),
  resourcePolicy: z.enum(['immutable', 'exclusive']),
  paths: z.array(z.string()).max(MAX_POLICY_PATHS),
  resourceRoots: z.array(z.string()).max(MAX_POLICY_ROOTS),
}).strict();

const verifiedPolicyCache = new Map<string, VerifiedManagedR2Policy>();

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalPath(path: string, root: boolean): void {
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) throw new Error('Managed policy path exceeds byte limit');
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('//') || /[\0-\x1f\x7f]/.test(path)) {
    throw new Error('Managed policy path is invalid');
  }
  const normalized = root ? path.slice(0, -1) : path;
  if (root !== path.endsWith('/') || normalized.split('/').some(segment => segment === '.' || segment === '..' || !segment)) {
    throw new Error('Managed policy path is not canonical');
  }
}

function assertSortedUnique(values: string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareStrings(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function findManagedHome(path: string): string | undefined {
  return MANAGED_HOMES.find(home => path.startsWith(home));
}

/** @impl REQ-STOR-028 AC4, AC6 */
function deriveManagedResourceRoots(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const home = findManagedHome(path);
    if (!home) continue;
    const relativeSegments = path.slice(home.length).split('/');
    if (RESOURCE_CATEGORIES.has(relativeSegments[0]!)) {
      roots.add(`${home}${relativeSegments[0]}/`);
      continue;
    }
    if (relativeSegments.length > 1) {
      throw new Error(`Managed path does not contain a recognized managed resource category: ${path}`);
    }
  }
  return [...roots].sort(compareStrings);
}

/** @impl REQ-STOR-028 AC1, AC2, AC3 */
export async function buildManagedR2Policy(
  releaseDigest: string,
  release: ManagedReleaseIndex,
  resourcePolicy: Exclude<ManagedResourcePolicy, 'mutable'>,
): Promise<BuiltManagedR2Policy> {
  if (!/^[0-9a-f]{64}$/.test(releaseDigest)) throw new Error('Managed release digest is invalid');
  const paths = [...new Set([
    ...release.documents.map(document => document.key),
    ...release.retiredPaths,
    MANAGED_EXTENSIONS_KEY,
    MANAGED_R2_POLICY_KEY,
  ])].sort(compareStrings);
  if (paths.length > MAX_POLICY_PATHS) throw new Error('Managed policy path count exceeds limit');
  paths.forEach(path => assertCanonicalPath(path, false));
  const resourceRoots = resourcePolicy === 'exclusive' ? deriveManagedResourceRoots(paths) : [];
  resourceRoots.forEach(path => assertCanonicalPath(path, true));
  const value: ManagedR2Policy = { schemaVersion: 1, releaseDigest, resourcePolicy, paths, resourceRoots };
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAX_POLICY_BYTES) throw new Error('Managed policy exceeds byte limit');
  return { value, bytes, digest: await sha256Hex(bytes) };
}

function validatePolicy(value: unknown): ManagedR2Policy {
  const parsed = PolicySchema.safeParse(value);
  if (!parsed.success) throw new Error(`Managed policy schema is invalid: ${parsed.error.issues[0]?.path.join('.') || 'record'}`);
  parsed.data.paths.forEach(path => assertCanonicalPath(path, false));
  parsed.data.resourceRoots.forEach(path => assertCanonicalPath(path, true));
  assertSortedUnique(parsed.data.paths, 'Managed policy paths');
  assertSortedUnique(parsed.data.resourceRoots, 'Managed policy resource roots');
  if (parsed.data.resourcePolicy === 'immutable' && parsed.data.resourceRoots.length !== 0) {
    throw new Error('Immutable managed policy cannot contain resource roots');
  }
  return parsed.data;
}

function assertExpectedIdentity(
  policy: VerifiedManagedR2Policy,
  input: Pick<ReadVerifiedManagedR2PolicyInput, 'releaseDigest' | 'pathsDigest' | 'expectedPolicy'>,
): void {
  if (policy.pathsDigest !== input.pathsDigest) throw new Error('Managed policy digest does not match applied state');
  if (policy.releaseDigest !== input.releaseDigest) throw new Error('Managed policy release does not match applied state');
  if (policy.resourcePolicy !== input.expectedPolicy) throw new Error('Managed policy mode does not match applied state');
}

/** @impl REQ-STOR-030 AC1, AC2, AC3 */
export async function readVerifiedManagedR2Policy(input: ReadVerifiedManagedR2PolicyInput): Promise<VerifiedManagedR2Policy> {
  if (!/^[0-9a-f]{64}$/.test(input.releaseDigest)) throw new Error('Managed policy expected release digest is invalid');
  if (!/^[0-9a-f]{64}$/.test(input.pathsDigest)) throw new Error('Managed policy expected paths digest is invalid');
  if (!input.bypassMemoryCache) {
    const cached = verifiedPolicyCache.get(input.pathsDigest);
    if (cached) {
      assertExpectedIdentity(cached, input);
      return cached;
    }
  }

  const response = await input.fetchPolicyObject();
  if (!response.ok) throw new Error(`Managed policy read failed with status ${response.status}`);
  const bytes = await readBoundedResponse(response, MAX_POLICY_BYTES, 'Managed policy');
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== input.pathsDigest) throw new Error('Managed policy digest does not match applied state');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error('Managed policy is not valid UTF-8 JSON');
  }
  const value = validatePolicy(decoded);
  const canonicalBytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (canonicalBytes.byteLength !== bytes.byteLength || canonicalBytes.some((byte, index) => byte !== bytes[index])) {
    throw new Error('Managed policy bytes are not canonical');
  }
  const verified: VerifiedManagedR2Policy = Object.freeze({
    ...value,
    paths: Object.freeze([...value.paths]) as unknown as string[],
    resourceRoots: Object.freeze([...value.resourceRoots]) as unknown as string[],
    pathsDigest: actualDigest,
  });
  assertExpectedIdentity(verified, input);
  verifiedPolicyCache.set(actualDigest, verified);
  while (verifiedPolicyCache.size > 2) verifiedPolicyCache.delete(verifiedPolicyCache.keys().next().value!);
  return verified;
}

/** @impl REQ-STOR-028 AC5 */
export function isManagedMutationProtected(policy: ManagedR2Policy, key: string): boolean {
  if (policy.paths.includes(key)) return true;
  return policy.resourceRoots.some(root => key === root.slice(0, -1) || key.startsWith(root));
}

export function canPrefixIntersectManagedPolicy(policy: ManagedR2Policy, prefix: string): boolean {
  if (!prefix) return true;
  if (policy.paths.some(path => path.startsWith(prefix))) return true;
  return policy.resourceRoots.some(root => {
    const rootObject = root.slice(0, -1);
    return root.startsWith(prefix) || prefix === rootObject || prefix.startsWith(root);
  });
}

type ManagedR2RequestClassification =
  | { action: 'allow'; request: Request }
  | { action: 'deny'; status: 403 | 503; code: string; requestId: string };

function denyManagedRequest(code = 'AccessDenied'): ManagedR2RequestClassification {
  return { action: 'deny', status: 403, code, requestId: crypto.randomUUID() };
}

function rawManagedTarget(url: URL, accountId: string, boundBucket: string): { keyRaw: string } | null {
  const accountHost = `${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const rawPath = url.pathname.slice(1);
  if (host === accountHost) {
    const separator = rawPath.indexOf('/');
    const rawBucket = separator < 0 ? rawPath : rawPath.slice(0, separator);
    if (rawBucket !== boundBucket) return null;
    return { keyRaw: separator < 0 ? '' : rawPath.slice(separator + 1) };
  }
  const suffix = `.${accountHost}`;
  if (!host.endsWith(suffix) || host.slice(0, -suffix.length) !== boundBucket) return null;
  return { keyRaw: rawPath };
}

function decodeCanonicalRawKey(raw: string): string | null {
  try {
    const decodedSegments = raw.split('/').map(segment => decodeURIComponent(segment));
    if (decodedSegments.some(segment => segment.includes('\\') || segment.includes('/'))) return null;
    const canonical = decodedSegments.map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, character => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ))).join('/');
    const normalizedRaw = raw.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
    return canonical === normalizedRaw ? decodedSegments.join('/') : null;
  } catch {
    return null;
  }
}

function hasDuplicateControlQuery(url: URL): boolean {
  return ['delete', 'uploads', 'uploadId', 'partNumber', 'tagging'].some(name => url.searchParams.getAll(name).length > 1);
}

function parseDeleteKeys(xml: string): string[] | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const opening = xml.match(/^\s*(?:<\?xml[^?]*\?>\s*)?<Delete(?: xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?>/);
  if (!opening || !/<\/Delete>\s*$/.test(xml)) return null;
  const body = xml.slice(opening[0].length).replace(/<\/Delete>\s*$/, '');
  const objectMatches = [...body.matchAll(/<Object>\s*<Key>([^<]*)<\/Key>\s*<\/Object>/g)];
  if (objectMatches.length < 1 || objectMatches.length > 1_000) return null;
  const remainder = body
    .replace(/<Object>\s*<Key>[^<]*<\/Key>\s*<\/Object>/g, '')
    .replace(/<Quiet>(?:true|false)<\/Quiet>/, '')
    .trim();
  if (remainder || (body.match(/<Quiet>/g)?.length ?? 0) > 1) return null;
  const keys: string[] = [];
  for (const match of objectMatches) {
    const raw = match[1]!;
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) return null;
    const key = decodeXmlEntities(raw);
    if (!key || key.includes('\\') || /[\0-\x1f\x7f]/.test(key)) return null;
    keys.push(key);
  }
  return keys;
}

/** @impl REQ-ENTERPRISE-028 */
export async function classifyManagedR2Request(input: {
  request: Request;
  accountId: string;
  boundBucket: string;
  policy: VerifiedManagedR2Policy;
}): Promise<ManagedR2RequestClassification> {
  const url = new URL(input.request.url);
  const target = rawManagedTarget(url, input.accountId, input.boundBucket);
  if (!target || hasDuplicateControlQuery(url)) return denyManagedRequest();
  if (input.request.method === 'GET' || input.request.method === 'HEAD') {
    return { action: 'allow', request: input.request };
  }

  if (input.request.method === 'POST' && url.searchParams.has('delete')) {
    if (target.keyRaw || url.searchParams.get('delete') !== '') return denyManagedRequest();
    if (!/^application\/xml(?:\s*;\s*charset=utf-8)?$/i.test(input.request.headers.get('content-type') ?? '')) return denyManagedRequest();
    if (input.request.headers.has('content-encoding')) return denyManagedRequest();
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedStream(input.request.body, 1024 * 1024, 'S3 multi-delete body');
    } catch {
      return denyManagedRequest();
    }
    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return denyManagedRequest();
    }
    const keys = parseDeleteKeys(xml);
    if (!keys || keys.some(key => isManagedMutationProtected(input.policy, key))) return denyManagedRequest();
    const headers = new Headers(input.request.headers);
    headers.delete('content-length');
    return { action: 'allow', request: new Request(input.request.url, { method: 'POST', headers, body: bytes }) };
  }

  const key = decodeCanonicalRawKey(target.keyRaw);
  if (!key) return denyManagedRequest();
  if (isManagedMutationProtected(input.policy, key)) return denyManagedRequest();
  return { action: 'allow', request: input.request };
}
