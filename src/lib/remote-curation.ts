import { z } from 'zod';
import {
  MANAGED_RELEASE_CONTENT_TYPES,
  MANAGED_RELEASE_LIMITS,
  isExactManagedExtensionVersion,
  validateManagedReleasePath,
  validateManagedRetiredPath,
} from '../../scripts/agent-seed-release-limits.mjs';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from './agent-seed.generated';
import type { Env } from '../types';
import { readBoundedResponse, readBoundedStream } from './bounded-stream';
import { ValidationError } from './error-types';
import { decryptFromKV, getOrImportKey, encryptAndStore } from './kv-crypto';
import {
  getManagedEnvironmentPatKey,
  getManagedEnvironmentStateKey,
  SETUP_KEYS,
} from './kv-keys';
import { createBucketIfNotExists } from './r2-admin';
import {
  activateCachedManagedRelease,
  activateManagedRelease,
  createR2ManagedReleaseCache,
  getManagedReleaseCacheBucketName,
  type ActiveManagedRelease,
  type ManagedReleaseCache,
} from './remote-curation-cache';

const RELEASE_ASSET_REDIRECT_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const GITHUB_API_ORIGIN = 'https://api.github.com';
const FRESHNESS_MS = 5 * 60 * 1000;
const MAX_SAFE_ERROR_BYTES = 512;
const MAX_GITHUB_METADATA_BYTES = 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

const Hex40 = z.string().regex(/^[0-9a-f]{40}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const ModeSchema = z.enum(['default', 'advanced']);

const DocumentSchema = z.object({
  key: z.string().min(1).max(MANAGED_RELEASE_LIMITS.pathBytes),
  contentType: z.string().min(1).max(256).refine(
    (value) => MANAGED_RELEASE_CONTENT_TYPES.includes(value),
    'Unsupported managed document content type',
  ),
  content: z.string(),
  modes: z.array(ModeSchema).min(1).max(2),
}).strict();

const ExtensionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/).max(256);
const ExtensionSchema = z.object({
  id: ExtensionIdSchema,
  publisher: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/).max(128),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/).max(128),
  version: z.string().max(128).refine(isExactManagedExtensionVersion, 'Extension version must be exact semantic version'),
  targetPlatform: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64),
  engine: z.string().min(1).max(128),
  entrypoint: z.string().min(1).max(512),
  extensionPack: z.array(ExtensionIdSchema).max(MANAGED_RELEASE_LIMITS.extensionCount),
  extensionDependencies: z.array(ExtensionIdSchema).max(MANAGED_RELEASE_LIMITS.extensionCount),
  size: z.number().int().positive().max(MANAGED_RELEASE_LIMITS.extensionBytes),
  sha256: Hex64,
  downloadUrl: z.string().url().max(2_048),
}).strict();

const ManagedReleaseSchema = z.object({
  seedAbi: z.literal(1),
  sequence: z.number().int().positive().max(2 ** 32),
  source: z.object({
    repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    commitSha: Hex40,
    releaseTag: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
    compilerCommit: Hex40,
  }).strict(),
  runtimeDependencyHash: Hex64,
  documents: z.array(DocumentSchema).max(MANAGED_RELEASE_LIMITS.documentCount),
  retiredPaths: z.array(z.string().min(1).max(MANAGED_RELEASE_LIMITS.pathBytes)).max(MANAGED_RELEASE_LIMITS.retiredPathCount),
  managedExtensions: z.array(ExtensionSchema).max(MANAGED_RELEASE_LIMITS.extensionCount),
}).strict();

export type ManagedRelease = z.infer<typeof ManagedReleaseSchema>;

const ActivePointerSchema = z.object({
  schemaVersion: z.literal(1),
  seedAbi: z.literal(1),
  sequence: z.number().int().positive().max(2 ** 32),
  digest: Hex64,
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  releaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  releaseTag: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  sourceCommit: Hex40,
  runtimeDependencyHash: Hex64,
  activatedAt: z.string().datetime(),
}).strict();

const FreshnessStateSchema = z.object({
  schemaVersion: z.literal(1),
  etag: z.string().max(512).optional(),
  active: ActivePointerSchema.optional(),
  lastCheckedAt: z.string().datetime().optional(),
  patExpiresAt: z.string().datetime().optional(),
  lastError: z.string().max(MAX_SAFE_ERROR_BYTES).optional(),
}).strict();

export interface ManagedEnvironmentFreshnessState {
  schemaVersion: 1;
  etag?: string;
  active?: ActiveManagedRelease;
  lastCheckedAt?: string;
  patExpiresAt?: string;
  lastError?: string;
}

const ManagedEnvironmentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  repositoryId: z.number().int().positive(),
  publicKeyHex: Hex64,
  publicKeyFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  configFingerprint: Hex64,
  cacheBucketName: z.string().min(1).max(63),
}).strict();

export type ManagedEnvironmentConfig = z.infer<typeof ManagedEnvironmentConfigSchema>;
export type ManagedEnvironmentFreshness = 'unconfigured' | 'disabled' | 'fresh' | 'stale' | 'degraded';
type ManagedEnvironmentPatExpiryState = 'unknown' | 'valid' | 'expiring' | 'expired';

export interface ManagedEnvironmentPrefill {
  enabled: boolean;
  configured: boolean;
  repository: string;
  personalAccessTokenSet: boolean;
  publicKeyFingerprint: string;
  activeReleaseTag?: string;
  activeSequence?: number;
  activeDigestPrefix?: string;
  freshness: ManagedEnvironmentFreshness;
  lastCheckedAt?: string;
  patExpiryState: ManagedEnvironmentPatExpiryState;
  lastError?: string;
}

export interface ConfigureManagedEnvironmentRequest {
  enabled: boolean;
  repository?: string;
  personalAccessToken?: string;
  publicKey?: string;
}

interface DeferredManagedReleaseActivation {
  pointer: ActiveManagedRelease;
  currentActiveIsCached: boolean;
  checkedAt: string;
  etag?: string;
  patExpiresAt?: string;
}

function bytesFromHex(value: string, expectedBytes: number, label: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`).test(value)) {
    throw new Error(`${label} must be ${expectedBytes * 2} lowercase hex characters`);
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function getManagedEnvironmentKeyFingerprint(publicKeyHex: string): Promise<string> {
  return (await sha256Hex(bytesFromHex(publicKeyHex, 32, 'Ed25519 public key'))).slice(0, 16);
}

export async function getManagedEnvironmentConfigFingerprint(
  repositoryId: number,
  publicKeyHex: string,
): Promise<string> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('Managed environment repository ID must be a positive safe integer');
  }
  bytesFromHex(publicKeyHex, 32, 'Ed25519 public key');
  return sha256Hex(new TextEncoder().encode(`managed-environment-v1\0${repositoryId}\0${publicKeyHex}`));
}

function validateBoundedString(value: string, label: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is outside the allowed string bounds`);
  }
}

function assertManagedPath(key: string): void {
  validateManagedReleasePath(key, 'Managed path');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSorted(values: string[], label: string): void {
  const sorted = [...values].sort(compareStrings);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${label} must be deterministically sorted`);
  }
}

function assertReleaseSemantics(release: ManagedRelease): void {
  const pairs = new Set<string>();
  let priorDocumentIdentity = '';
  let totalDocumentBytes = 0;
  const livePaths = new Set<string>();
  for (const document of release.documents) {
    assertManagedPath(document.key);
    validateBoundedString(document.contentType, 'Managed document content type', 256);
    assertSorted(document.modes, `Modes for ${document.key}`);
    const uniqueModes = new Set(document.modes);
    if (uniqueModes.size !== document.modes.length) throw new Error(`Duplicate mode for managed path: ${document.key}`);
    const identity = `${document.key}\0${document.modes.join(',')}`;
    if (priorDocumentIdentity && compareStrings(priorDocumentIdentity, identity) > 0) {
      throw new Error('Managed release documents must be deterministically sorted');
    }
    priorDocumentIdentity = identity;
    livePaths.add(document.key);
    for (const mode of document.modes) {
      const pair = `${document.key}\0${mode}`;
      if (pairs.has(pair)) throw new Error(`Duplicate managed key and mode: ${document.key} (${mode})`);
      pairs.add(pair);
    }
    const bytes = new TextEncoder().encode(document.content).byteLength;
    if (bytes > MANAGED_RELEASE_LIMITS.documentBytes) throw new Error(`Managed document exceeds byte limit: ${document.key}`);
    totalDocumentBytes += bytes;
  }
  if (totalDocumentBytes > MANAGED_RELEASE_LIMITS.totalDocumentBytes) throw new Error('Managed release total document bytes exceed limit');

  assertSorted(release.retiredPaths, 'Managed retired paths');
  for (const key of release.retiredPaths) {
    validateManagedRetiredPath(key, 'Managed retired path');
    if (livePaths.has(key)) throw new Error(`Managed path is both live and retired: ${key}`);
  }
  if (new Set(release.retiredPaths).size !== release.retiredPaths.length) throw new Error('Managed release contains duplicate retired paths');

  const extensionIdentities = release.managedExtensions.map((extension) => `${extension.id}\0${extension.version}\0${extension.targetPlatform}`);
  assertSorted(extensionIdentities, 'Managed extensions');
  const platformIdentities = release.managedExtensions.map((extension) => `${extension.id}\0${extension.targetPlatform}`);
  if (new Set(platformIdentities).size !== platformIdentities.length) throw new Error('Managed release contains duplicate extension identities');
  const extensionSet = new Set(release.managedExtensions.map((extension) => extension.id));
  let aggregateExtensionBytes = 0;
  for (const extension of release.managedExtensions) {
    validateBoundedString(extension.engine, 'Managed extension engine', 128);
    validateBoundedString(extension.entrypoint, 'Managed extension entrypoint', 512);
    if (extension.id !== `${extension.publisher}.${extension.name}`.toLowerCase()) {
      throw new Error(`Managed extension identity does not match measured publisher and name: ${extension.id}`);
    }
    assertSorted(extension.extensionPack, `Extension pack for ${extension.id}`);
    assertSorted(extension.extensionDependencies, `Extension dependencies for ${extension.id}`);
    if (new Set(extension.extensionPack).size !== extension.extensionPack.length
      || new Set(extension.extensionDependencies).size !== extension.extensionDependencies.length) {
      throw new Error(`Managed extension contains duplicate dependencies: ${extension.id}`);
    }
    aggregateExtensionBytes += extension.size;
    for (const required of [...extension.extensionPack, ...extension.extensionDependencies]) {
      if (!extensionSet.has(required)) throw new Error(`Managed extension dependency closure is incomplete: ${required}`);
    }
    const url = new URL(extension.downloadUrl);
    const expectedPrefix = `/api/${encodeURIComponent(extension.publisher)}/${encodeURIComponent(extension.name)}/${encodeURIComponent(extension.version)}/file/`;
    if (url.protocol !== 'https:' || url.hostname !== 'open-vsx.org' || !url.pathname.startsWith(expectedPrefix)) {
      throw new Error('Managed extension download URL does not match its measured Open VSX identity');
    }
  }
  if (aggregateExtensionBytes > MANAGED_RELEASE_LIMITS.aggregateExtensionBytes) throw new Error('Managed release aggregate extension bytes exceed limit');
}

async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  let input: ReadableStream<Uint8Array>;
  try {
    input = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  } catch {
    throw new Error('Managed release gzip is invalid');
  }
  try {
    return await readBoundedStream(input, MANAGED_RELEASE_LIMITS.expandedBytes, 'Managed release');
  } catch (error) {
    if (error instanceof Error && /exceeds/.test(error.message)) throw error;
    throw new Error('Managed release gzip is invalid');
  }
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const output = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return readBoundedStream(output, MANAGED_RELEASE_LIMITS.compressedBytes, 'Compressed managed release');
}

export async function parseManagedRelease(compressed: Uint8Array): Promise<ManagedRelease> {
  if (compressed.byteLength > MANAGED_RELEASE_LIMITS.compressedBytes) {
    throw new Error(`Compressed managed release exceeds ${MANAGED_RELEASE_LIMITS.compressedBytes} bytes`);
  }
  const uncompressed = await decompressGzip(compressed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(uncompressed));
  } catch {
    throw new Error('Managed release JSON is invalid');
  }
  const result = ManagedReleaseSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Managed release schema is invalid: ${result.error.issues[0]?.path.join('.') || 'root'}`);
  assertReleaseSemantics(result.data);
  return result.data;
}

export async function verifyManagedRelease(input: {
  compressed: Uint8Array;
  signature: Uint8Array;
  publicKeyHex: string;
  expectedRepositoryId: number;
  minimumSequence: number;
  expectedRuntimeHash: string;
}): Promise<{ release: ManagedRelease; digest: string }> {
  if (input.compressed.byteLength > MANAGED_RELEASE_LIMITS.compressedBytes) {
    throw new Error(`Compressed managed release exceeds ${MANAGED_RELEASE_LIMITS.compressedBytes} bytes`);
  }
  if (input.signature.byteLength !== 64) throw new Error('Managed release signature must be exactly 64 bytes');
  const publicKey = await crypto.subtle.importKey(
    'raw',
    bytesFromHex(input.publicKeyHex, 32, 'Ed25519 public key'),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const signatureValid = await crypto.subtle.verify('Ed25519', publicKey, input.signature, input.compressed);
  if (!signatureValid) throw new Error('Managed release signature is invalid');

  const release = await parseManagedRelease(input.compressed);
  if (release.source.repositoryId !== input.expectedRepositoryId) throw new Error('Managed release repository identity does not match');
  if (release.sequence < input.minimumSequence) throw new Error('Managed release sequence is older than active state');
  if (release.runtimeDependencyHash !== input.expectedRuntimeHash) throw new Error('Managed release runtime dependency hash does not match');
  return { release, digest: await sha256Hex(input.compressed) };
}

export async function downloadManagedAsset(input: {
  url: string;
  token: string;
  fetcher?: typeof fetch;
  maxBytes?: number;
}): Promise<Uint8Array> {
  const fetcher = input.fetcher ?? fetch;
  const initialUrl = new URL(input.url);
  if (initialUrl.protocol !== 'https:' || initialUrl.origin !== GITHUB_API_ORIGIN) {
    throw new Error('Managed asset URL must use the GitHub API host');
  }
  let response = await fetchGithub(fetcher, initialUrl, {
    headers: githubHeaders(input.token, 'application/octet-stream'),
    redirect: 'manual',
  });
  let redirects = 0;
  while (response.status >= 300 && response.status < 400) {
    if (redirects >= MANAGED_RELEASE_LIMITS.redirectCount) throw new Error('Managed asset exceeded the redirect limit');
    const location = response.headers.get('location');
    if (!location) throw new Error('Managed asset redirect has no location');
    const redirected = new URL(location);
    if (redirected.protocol !== 'https:' || !RELEASE_ASSET_REDIRECT_HOSTS.has(redirected.hostname)) {
      throw new Error(`Managed asset redirect host is not allowed: ${redirected.hostname}`);
    }
    redirects += 1;
    response = await fetchGithub(fetcher, redirected, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Codeflare' },
      redirect: 'manual',
    });
  }
  if (!response.ok) throw new Error(`Managed asset download failed with HTTP ${response.status}`);
  return readResponseBounded(response, input.maxBytes ?? MANAGED_RELEASE_LIMITS.compressedBytes, 'Managed asset');
}

async function readResponseBounded(response: Response, limit: number, label: string): Promise<Uint8Array> {
  return readBoundedResponse(response, limit, label);
}

async function readJsonResponseBounded(response: Response, label: string): Promise<unknown> {
  const bytes = await readResponseBounded(response, MAX_GITHUB_METADATA_BYTES, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

async function fetchGithub(fetcher: typeof fetch, url: string | URL, init: RequestInit): Promise<Response> {
  return fetcher(new Request(url, {
    ...init,
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  }));
}

function githubHeaders(token: string, accept = 'application/vnd.github+json'): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'Codeflare',
  };
}

const GithubAssetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  url: z.string().url(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).passthrough();
const GithubReleaseSchema = z.object({
  id: z.number().int().positive(),
  tag_name: z.string().min(1).max(256),
  immutable: z.literal(true),
  assets: z.array(GithubAssetSchema),
}).passthrough();

function exactReleaseAssets(release: z.infer<typeof GithubReleaseSchema>): {
  bundle: z.infer<typeof GithubAssetSchema>;
  signature: z.infer<typeof GithubAssetSchema>;
} {
  if (release.assets.length !== 2) throw new Error('Managed release must contain exactly two immutable assets');
  const bundle = release.assets.find((asset) => asset.name === 'seed-v1.json.gz');
  const signature = release.assets.find((asset) => asset.name === 'seed-v1.sig');
  if (!bundle || !signature) throw new Error('Managed release immutable assets are incomplete');
  return { bundle, signature };
}

function responseEtag(response: Response): string | undefined {
  const value = response.headers.get('etag');
  if (!value) return undefined;
  if (value.length > 512 || /[\r\n]/.test(value)) throw new Error('GitHub release ETag is invalid');
  return value;
}

function parsePatExpiration(response: Response): string | undefined {
  const value = response.headers.get('github-authentication-token-expiration');
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : 'Managed release resolution failed';
  const redacted = token ? raw.split(token).join('[redacted]') : raw;
  const decoder = new TextDecoder();
  let bounded = decoder.decode(new TextEncoder().encode(redacted).slice(0, MAX_SAFE_ERROR_BYTES));
  while (new TextEncoder().encode(bounded).byteLength > MAX_SAFE_ERROR_BYTES) bounded = bounded.slice(0, -1);
  return bounded;
}

async function readFreshnessState(kv: KVNamespace, stateKey: string): Promise<ManagedEnvironmentFreshnessState> {
  try {
    const value = await kv.get(stateKey, 'json');
    const parsed = FreshnessStateSchema.safeParse(value);
    return parsed.success ? parsed.data : { schemaVersion: 1 };
  } catch {
    return { schemaVersion: 1 };
  }
}

async function writeFreshnessState(
  kv: KVNamespace,
  stateKey: string,
  state: ManagedEnvironmentFreshnessState,
): Promise<void> {
  await kv.put(stateKey, JSON.stringify(state));
}

async function readActiveWithFallback(
  cache: ManagedReleaseCache,
  fallback: ActiveManagedRelease | undefined,
): Promise<ActiveManagedRelease | undefined> {
  try {
    return (await cache.readActive())?.pointer ?? fallback;
  } catch {
    return fallback;
  }
}

async function hasCachedRelease(cache: ManagedReleaseCache, active: ActiveManagedRelease): Promise<boolean> {
  try {
    return cache.hasRelease ? await cache.hasRelease(active.digest) : true;
  } catch {
    return false;
  }
}

export async function resolveManagedEnvironmentRelease(input: {
  kv: KVNamespace;
  stateKey: string;
  cache: ManagedReleaseCache;
  repository: string;
  repositoryId: number;
  token: string;
  publicKeyHex: string;
  expectedRuntimeHash?: string;
  fetcher?: typeof fetch;
  now?: Date;
  requireFresh?: boolean;
  deferActivation?: boolean;
}): Promise<{
  active?: ActiveManagedRelease;
  deferred?: DeferredManagedReleaseActivation;
  freshness: 'fresh' | 'degraded';
  lastCheckedAt?: string;
  lastError?: string;
}> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  const state = await readFreshnessState(input.kv, input.stateKey);
  const lastChecked = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  const freshnessAge = now.getTime() - lastChecked;
  if (!input.requireFresh && state.active && Number.isFinite(lastChecked) && freshnessAge >= 0 && freshnessAge < FRESHNESS_MS) {
    const cachedActive = await readActiveWithFallback(input.cache, undefined);
    if (cachedActive?.digest === state.active.digest && await hasCachedRelease(input.cache, cachedActive)) {
      return { active: cachedActive, freshness: state.lastError ? 'degraded' : 'fresh', lastCheckedAt: state.lastCheckedAt, lastError: state.lastError };
    }
  }

  try {
    const latestUrl = `${GITHUB_API_ORIGIN}/repos/${input.repository}/releases/latest`;
    const headers = new Headers(githubHeaders(input.token));
    if (state.etag) headers.set('If-None-Match', state.etag);
    let response = await fetchGithub(fetcher, latestUrl, { headers, redirect: 'manual' });
    const checkedAt = now.toISOString();
    let patExpiresAt = parsePatExpiration(response) ?? state.patExpiresAt;

    if (response.status === 304) {
      const active = await readActiveWithFallback(input.cache, undefined);
      if (active && await hasCachedRelease(input.cache, active)) {
        await writeFreshnessState(input.kv, input.stateKey, {
          schemaVersion: 1,
          ...(state.etag ? { etag: state.etag } : {}),
          active,
          lastCheckedAt: checkedAt,
          ...(patExpiresAt ? { patExpiresAt } : {}),
        });
        return { active, freshness: 'fresh', lastCheckedAt: checkedAt };
      }
      // KV metadata cannot substitute for missing verified cache bytes. Repeat the
      // metadata read once without the validator so the immutable assets rebuild it.
      response = await fetchGithub(fetcher, latestUrl, {
        headers: githubHeaders(input.token),
        redirect: 'manual',
      });
      patExpiresAt = parsePatExpiration(response) ?? patExpiresAt;
    }
    if (!response.ok) throw new Error(`GitHub latest release request failed with HTTP ${response.status}`);

    const decoded = GithubReleaseSchema.safeParse(await readJsonResponseBounded(response, 'GitHub latest release metadata'));
    if (!decoded.success) throw new Error(`GitHub latest release is not immutable or has invalid metadata: ${decoded.error.issues[0]?.path.join('.') || 'root'}`);
    const releaseMetadata = decoded.data;
    const assets = exactReleaseAssets(releaseMetadata);
    const cachedActive = await readActiveWithFallback(input.cache, undefined);
    const observedActive = cachedActive ?? state.active;
    if (cachedActive?.releaseId === releaseMetadata.id
      && cachedActive.releaseTag === releaseMetadata.tag_name
      && await hasCachedRelease(input.cache, cachedActive)) {
      await writeFreshnessState(input.kv, input.stateKey, {
        schemaVersion: 1,
        ...(responseEtag(response) ? { etag: responseEtag(response)! } : {}),
        active: observedActive,
        lastCheckedAt: checkedAt,
        ...(patExpiresAt ? { patExpiresAt } : {}),
      });
      return { active: observedActive, freshness: 'fresh', lastCheckedAt: checkedAt };
    }

    const [compressed, signature] = await Promise.all([
      downloadManagedAsset({ url: assets.bundle.url, token: input.token, fetcher, maxBytes: MANAGED_RELEASE_LIMITS.compressedBytes }),
      downloadManagedAsset({ url: assets.signature.url, token: input.token, fetcher, maxBytes: 64 }),
    ]);
    if (signature.byteLength !== 64) throw new Error('Managed release signature must be exactly 64 bytes');
    const [bundleDigest, signatureDigest] = await Promise.all([sha256Hex(compressed), sha256Hex(signature)]);
    if (`sha256:${bundleDigest}` !== assets.bundle.digest) throw new Error('Managed release bundle immutable asset digest does not match');
    if (`sha256:${signatureDigest}` !== assets.signature.digest) throw new Error('Managed release signature immutable asset digest does not match');

    const verified = await verifyManagedRelease({
      compressed,
      signature,
      publicKeyHex: input.publicKeyHex,
      expectedRepositoryId: input.repositoryId,
      minimumSequence: observedActive?.sequence ?? 1,
      expectedRuntimeHash: input.expectedRuntimeHash ?? PRESEED_RUNTIME_DEPENDENCY_HASH,
    });
    if (verified.release.source.releaseTag !== releaseMetadata.tag_name) throw new Error('Managed release tag does not match signed source metadata');
    const candidate: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: verified.release.seedAbi,
      sequence: verified.release.sequence,
      digest: verified.digest,
      repositoryId: verified.release.source.repositoryId,
      releaseId: releaseMetadata.id,
      releaseTag: releaseMetadata.tag_name,
      sourceCommit: verified.release.source.commitSha,
      runtimeDependencyHash: verified.release.runtimeDependencyHash,
      activatedAt: checkedAt,
    };
    const etag = responseEtag(response);
    if (input.deferActivation) {
      const releasePrefix = `releases/${candidate.digest}`;
      await Promise.all([
        input.cache.putImmutable(`${releasePrefix}/seed-v1.json.gz`, compressed),
        input.cache.putImmutable(`${releasePrefix}/seed-v1.sig`, signature),
      ]);
      return {
        active: observedActive,
        deferred: {
          pointer: candidate,
          currentActiveIsCached: cachedActive !== undefined,
          checkedAt,
          ...(etag ? { etag } : {}),
          ...(patExpiresAt ? { patExpiresAt } : {}),
        },
        freshness: 'fresh',
        lastCheckedAt: checkedAt,
      };
    }

    const active = await activateManagedRelease({ cache: input.cache, candidate, bundle: compressed, signature });
    await writeFreshnessState(input.kv, input.stateKey, {
      schemaVersion: 1,
      ...(etag ? { etag } : {}),
      active,
      lastCheckedAt: checkedAt,
      ...(patExpiresAt ? { patExpiresAt } : {}),
    });
    return { active, freshness: 'fresh', lastCheckedAt: checkedAt };
  } catch (error) {
    const message = safeError(error, input.token);
    const active = await readActiveWithFallback(input.cache, state.active);
    const failedState: ManagedEnvironmentFreshnessState = {
      schemaVersion: 1,
      ...(state.etag ? { etag: state.etag } : {}),
      ...(active ? { active } : {}),
      ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
      ...(state.patExpiresAt ? { patExpiresAt: state.patExpiresAt } : {}),
      lastError: message,
    };
    await writeFreshnessState(input.kv, input.stateKey, failedState);
    if (input.requireFresh) throw new Error(message);
    return { active, freshness: 'degraded', lastCheckedAt: state.lastCheckedAt, lastError: message };
  }
}

function normalizeRepository(value: string): string {
  const repository = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
    throw new ValidationError('Managed coding environment repository must use owner/name format');
  }
  return repository;
}

async function resolveRepositoryId(repository: string, token: string, fetcher: typeof fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetchGithub(fetcher, `${GITHUB_API_ORIGIN}/repos/${repository}`, {
      headers: githubHeaders(token),
      redirect: 'manual',
    });
  } catch (error) {
    throw new Error(safeError(error, token));
  }
  if (!response.ok) throw new Error(`GitHub repository request failed with HTTP ${response.status}`);
  const parsed = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).passthrough().safeParse(
    await readJsonResponseBounded(response, 'GitHub repository metadata'),
  );
  if (!parsed.success) throw new Error('GitHub repository identity is invalid');
  return parsed.data.id;
}

async function loadManagedEnvironmentConfig(
  kv: KVNamespace,
  failClosed = false,
): Promise<ManagedEnvironmentConfig | undefined> {
  try {
    const value = await kv.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, 'json');
    if (value === null) return undefined;
    const parsed = ManagedEnvironmentConfigSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (failClosed) throw new Error('Managed coding environment configuration is invalid');
    return undefined;
  } catch (error) {
    if (failClosed) throw error;
    return undefined;
  }
}

async function readEncryptedManagedPat(
  kv: KVNamespace,
  configFingerprint: string,
  cryptoKey: CryptoKey,
): Promise<string | undefined> {
  const key = getManagedEnvironmentPatKey(configFingerprint);
  const stored = await kv.get(key, 'text');
  if (!stored) return undefined;
  if (!stored.startsWith('v1:')) throw new Error('Managed coding environment PAT is not encrypted');
  let value: unknown;
  try {
    value = JSON.parse(await decryptFromKV(stored.slice(3), cryptoKey, key));
  } catch {
    throw new Error('Managed coding environment PAT cannot be decrypted');
  }
  const parsed = z.object({ token: z.string().min(1).max(2_048) }).strict().safeParse(value);
  if (!parsed.success) throw new Error('Managed coding environment PAT payload is invalid');
  return parsed.data.token;
}

export async function configureManagedEnvironment(input: {
  env: Pick<Env, 'KV' | 'CLOUDFLARE_API_TOKEN' | 'ENCRYPTION_KEY'>;
  accountId: string;
  workerName: string;
  endpoint: string;
  r2Credentials: Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>;
  request: ConfigureManagedEnvironmentRequest;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<{ enabled: boolean; active?: ActiveManagedRelease }> {
  const existing = await loadManagedEnvironmentConfig(input.env.KV, input.request.enabled);
  if (!input.request.enabled) {
    if (existing?.enabled) {
      await input.env.KV.put(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, JSON.stringify({ ...existing, enabled: false }));
    } else if (!existing && await input.env.KV.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) !== null) {
      // Explicit disable is the recovery boundary for malformed selected state.
      // Retained PAT, status, and immutable cache history remain untouched.
      await input.env.KV.delete(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG);
    }
    return { enabled: false };
  }

  const cryptoKey = await getOrImportKey(input.env);
  if (!cryptoKey) throw new ValidationError('ENCRYPTION_KEY must be configured before storing the managed repository PAT');
  const repository = input.request.repository?.trim()
    ? normalizeRepository(input.request.repository)
    : existing?.repository;
  const publicKeyHex = input.request.publicKey?.trim() || existing?.publicKeyHex;
  if (!repository) throw new ValidationError('Managed coding environment repository is required when enabled');
  if (!publicKeyHex) throw new ValidationError('Managed coding environment Ed25519 public key is required when enabled');
  if (existing && existing.publicKeyHex !== publicKeyHex) {
    throw new ValidationError('Managed coding environment public key cannot be changed after initial configuration');
  }
  bytesFromHex(publicKeyHex, 32, 'Ed25519 public key');

  const existingPat = existing
    ? await readEncryptedManagedPat(input.env.KV, existing.configFingerprint, cryptoKey)
    : undefined;
  const token = input.request.personalAccessToken?.trim() || existingPat;
  if (!token) throw new ValidationError('Managed coding environment repository PAT is required when enabled');

  const fetcher = input.fetcher ?? fetch;
  const repositoryId = await resolveRepositoryId(repository, token, fetcher);
  const [publicKeyFingerprint, configFingerprint, cacheBucketName] = await Promise.all([
    getManagedEnvironmentKeyFingerprint(publicKeyHex),
    getManagedEnvironmentConfigFingerprint(repositoryId, publicKeyHex),
    getManagedReleaseCacheBucketName(input.accountId, input.workerName),
  ]);
  const bucket = await createBucketIfNotExists(input.accountId, input.env.CLOUDFLARE_API_TOKEN, cacheBucketName);
  if (!bucket.success) throw new Error(`Failed to create managed release cache bucket: ${bucket.error ?? 'unknown error'}`);

  const cache = createR2ManagedReleaseCache({
    env: input.r2Credentials,
    endpoint: input.endpoint,
    bucketName: cacheBucketName,
    configFingerprint,
    fetcher,
  });
  const stateKey = getManagedEnvironmentStateKey(configFingerprint);
  const resolved = await resolveManagedEnvironmentRelease({
    kv: input.env.KV,
    stateKey,
    cache,
    repository,
    repositoryId,
    token,
    publicKeyHex,
    expectedRuntimeHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
    fetcher,
    now: input.now,
    requireFresh: true,
    deferActivation: true,
  });
  const prepared = resolved.deferred?.pointer ?? resolved.active;
  if (!prepared) throw new Error('Managed coding environment has no verified active release');

  // Equality is allowed only for the exact immutable release already selected.
  // Validate a same-sequence candidate against the authoritative cache pointer
  // before any replacement PAT or selected configuration is committed.
  if (resolved.active && prepared.sequence === resolved.active.sequence) {
    await activateCachedManagedRelease(cache, prepared);
  }

  const candidate: ManagedEnvironmentConfig = {
    schemaVersion: 1,
    enabled: true,
    repository,
    repositoryId,
    publicKeyHex,
    publicKeyFingerprint,
    configFingerprint,
    cacheBucketName,
  };
  const patKey = getManagedEnvironmentPatKey(configFingerprint);
  const sameNamespace = existing?.configFingerprint === configFingerprint;
  const priorConfigRaw = await input.env.KV.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG);
  const priorPatRaw = await input.env.KV.get(patKey);

  const activatePrepared = async (): Promise<ActiveManagedRelease> => {
    if (!resolved.deferred) return prepared;
    const active = await activateCachedManagedRelease(cache, resolved.deferred.pointer);
    // active.json is the authoritative commit. Freshness metadata is advisory and
    // can be reconstructed on the next resolver pass if this status write fails.
    await writeFreshnessState(input.env.KV, stateKey, {
      schemaVersion: 1,
      ...(resolved.deferred.etag ? { etag: resolved.deferred.etag } : {}),
      active,
      lastCheckedAt: resolved.deferred.checkedAt,
      ...(resolved.deferred.patExpiresAt ? { patExpiresAt: resolved.deferred.patExpiresAt } : {}),
    }).catch(() => undefined);
    return active;
  };

  if (!sameNamespace) {
    // A replacement trust boundary is isolated in its fingerprinted namespace,
    // so activation cannot alter the selected prior configuration. Select it last,
    // and remove any candidate credential if that final selection fails.
    try {
      const active = await activatePrepared();
      await encryptAndStore(input.env.KV, patKey, { token }, cryptoKey);
      await input.env.KV.put(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, JSON.stringify(candidate));
      return { enabled: true, active };
    } catch (error) {
      try {
        if (priorPatRaw === null) await input.env.KV.delete(patKey);
        else await input.env.KV.put(patKey, priorPatRaw);
        if (priorConfigRaw === null) await input.env.KV.delete(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG);
        else await input.env.KV.put(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, priorConfigRaw);
      } catch {
        throw new Error('Managed coding environment reconfiguration failed and prior KV state could not be restored');
      }
      throw error;
    }
  }

  // PAT-only and same-trust refreshes share the selected namespace. Update the
  // recoverable KV values first, advance active.json last, and restore both if
  // any pre-activation or activation step fails.
  try {
    await encryptAndStore(input.env.KV, patKey, { token }, cryptoKey);
    await input.env.KV.put(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, JSON.stringify(candidate));
    // A selected namespace with an LKG does not advance during Setup. The newly
    // verified candidate is already cached and the normal resolver activates it
    // after the configuration transaction has succeeded.
    if (resolved.active && resolved.deferred?.currentActiveIsCached !== false) {
      return { enabled: true, active: resolved.active };
    }
    const active = await activatePrepared();
    return { enabled: true, active };
  } catch (error) {
    try {
      if (priorPatRaw === null) await input.env.KV.delete(patKey);
      else await input.env.KV.put(patKey, priorPatRaw);
      if (priorConfigRaw === null) await input.env.KV.delete(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG);
      else await input.env.KV.put(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, priorConfigRaw);
    } catch {
      throw new Error('Managed coding environment reconfiguration failed and prior KV state could not be restored');
    }
    throw error;
  }
}

export async function resolveManagedEnvironment(input: {
  env: Pick<Env, 'KV' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'ENCRYPTION_KEY'>;
  fetcher?: typeof fetch;
  now?: Date;
  requireFresh?: boolean;
}): Promise<{
  configured: boolean;
  enabled: boolean;
  config?: ManagedEnvironmentConfig;
  active?: ActiveManagedRelease;
  freshness: ManagedEnvironmentFreshness;
  lastCheckedAt?: string;
  lastError?: string;
}> {
  const config = await loadManagedEnvironmentConfig(input.env.KV, true);
  if (!config) return { configured: false, enabled: false, freshness: 'unconfigured' };
  if (!config.enabled) return { configured: true, enabled: false, config, freshness: 'disabled' };

  const stateKey = getManagedEnvironmentStateKey(config.configFingerprint);
  const state = await readFreshnessState(input.env.KV, stateKey);
  try {
    const cryptoKey = await getOrImportKey(input.env);
    if (!cryptoKey) throw new Error('Managed coding environment encryption key is unavailable');
    const storedPat = await readEncryptedManagedPat(input.env.KV, config.configFingerprint, cryptoKey);
    if (!storedPat) throw new Error('Managed coding environment repository PAT is unavailable');
    const endpoint = await input.env.KV.get(SETUP_KEYS.R2_ENDPOINT);
    if (!endpoint) throw new Error('Managed coding environment R2 endpoint is unavailable');
    const cache = createR2ManagedReleaseCache({
      env: input.env,
      endpoint,
      bucketName: config.cacheBucketName,
      configFingerprint: config.configFingerprint,
      fetcher: input.fetcher,
    });
    const resolved = await resolveManagedEnvironmentRelease({
      kv: input.env.KV,
      stateKey,
      cache,
      repository: config.repository,
      repositoryId: config.repositoryId,
      token: storedPat,
      publicKeyHex: config.publicKeyHex,
      expectedRuntimeHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      fetcher: input.fetcher,
      now: input.now,
      requireFresh: input.requireFresh,
    });
    return {
      configured: true,
      enabled: true,
      config,
      active: resolved.active,
      freshness: resolved.freshness,
      ...(resolved.lastCheckedAt ? { lastCheckedAt: resolved.lastCheckedAt } : {}),
      ...(resolved.lastError ? { lastError: resolved.lastError } : {}),
    };
  } catch (error) {
    const message = safeError(error, '');
    await writeFreshnessState(input.env.KV, stateKey, {
      ...state,
      schemaVersion: 1,
      lastError: message,
    });
    if (input.requireFresh) throw new Error(message);
    return {
      configured: true,
      enabled: true,
      config,
      ...(state.active ? { active: state.active } : {}),
      freshness: 'degraded',
      ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
      lastError: message,
    };
  }
}

function patExpiryState(value: string | undefined, now: Date): ManagedEnvironmentPatExpiryState {
  if (!value) return 'unknown';
  const expiry = Date.parse(value);
  if (!Number.isFinite(expiry)) return 'unknown';
  if (expiry <= now.getTime()) return 'expired';
  if (expiry - now.getTime() <= 7 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'valid';
}

export async function getManagedEnvironmentPrefill(
  env: Pick<Env, 'KV'>,
  now = new Date(),
): Promise<ManagedEnvironmentPrefill> {
  const config = await loadManagedEnvironmentConfig(env.KV);
  if (!config) {
    return {
      enabled: false,
      configured: false,
      repository: '',
      personalAccessTokenSet: false,
      publicKeyFingerprint: '',
      freshness: 'unconfigured',
      patExpiryState: 'unknown',
    };
  }
  const [pat, state] = await Promise.all([
    env.KV.get(getManagedEnvironmentPatKey(config.configFingerprint)),
    readFreshnessState(env.KV, getManagedEnvironmentStateKey(config.configFingerprint)),
  ]);
  const checked = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  const freshness: ManagedEnvironmentFreshness = !config.enabled
    ? 'disabled'
    : state.lastError
      ? 'degraded'
      : Number.isFinite(checked) && now.getTime() - checked >= 0 && now.getTime() - checked < FRESHNESS_MS
        ? 'fresh'
        : 'stale';
  return {
    enabled: config.enabled,
    configured: true,
    repository: config.repository,
    personalAccessTokenSet: typeof pat === 'string' && pat.startsWith('v1:'),
    publicKeyFingerprint: config.publicKeyFingerprint,
    ...(state.active ? {
      activeReleaseTag: state.active.releaseTag,
      activeSequence: state.active.sequence,
      activeDigestPrefix: state.active.digest.slice(0, 12),
    } : {}),
    freshness,
    ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
    patExpiryState: patExpiryState(state.patExpiresAt, now),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}
