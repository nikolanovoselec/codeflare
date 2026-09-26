import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { AppError, ValidationError } from '../lib/error-types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { openOperatorSecret } from './protected-secrets';
import { parseDispatcherBundle, parseOperatorBundle, parseOperatorManifest } from './distribution';
import type {
  ManagementGrant, ManagementOperatorProfile, ManagementOperatorRealm, ManagementPolicy,
  ManagementRelease, ManagementReleaseCandidate, OperatorRegistry,
} from './registry';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_BUNDLE_BYTES + 256 * 1024;
const API = 'https://api.github.com';
const CDN_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com',
  'productionresultssa1.blob.core.windows.net', 'productionresultssa3.blob.core.windows.net',
  'productionresultssa8.blob.core.windows.net', 'productionresultssa16.blob.core.windows.net']);
const FILES = ['operator-manifest.json', 'operator-bundle.json', 'operator-provenance.json'] as const;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const workflowPath = '.github/workflows/release.yml';
const provenanceSchema = z.strictObject({
  repositoryId: positive, sourceCommit: commit, compilerCommit: commit.optional(), manifestDigest: sha, bundleDigest: sha,
  workflow: z.strictObject({ id: positive, ref: z.string().min(1).max(512), runId: positive, runAttempt: positive }),
});
// GitHub adds fields to REST envelopes. Only package-authored documents are strict;
// consumed authority fields below are typed and compared to locally bound values.
const repositorySchema = z.object({ id: positive, full_name: z.string().max(256), html_url: z.string().max(2048), default_branch: z.string().min(1).max(256) });
const assetSchema = z.object({ id: positive, name: z.enum(FILES), size: positive, state: z.literal('uploaded'), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });
const releaseSchema = z.object({ id: positive, draft: z.literal(false), immutable: z.literal(true), published_at: z.string().datetime(),
  tag_name: z.string().min(1).max(256), assets: z.array(assetSchema).length(3) });
const runSchema = z.object({ id: positive, run_attempt: positive, workflow_id: positive, head_sha: commit, head_branch: z.string(),
  path: z.string(), event: z.enum(['push', 'release', 'workflow_dispatch']), status: z.literal('completed'), conclusion: z.literal('success'),
  repository: z.object({ id: positive }), head_repository: z.object({ id: positive }) });
const artifactSchema = z.object({ id: positive, name: z.literal('operator-package'), size_in_bytes: positive,
  expired: z.literal(false), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  workflow_run: z.object({ id: positive, repository_id: positive, head_repository_id: positive, head_sha: commit }) });

type GitHubContext = {
  registry: Pick<OperatorRegistry, 'registerManagement' | 'getManagementAcquisition' | 'getManagementReleases' | 'replaceManagementReleases' | 'setManagementSource'>;
  human: VerifiedHumanAccessClaims;
  controlsRevision: number;
  encryption: { ENCRYPTION_KEY?: string };
  /** Re-resolve current human eligibility, ownership and ceiling after remote I/O. */
  reauthorize: () => Promise<VerifiedHumanAccessClaims>;
};

function requireCurrentAuthority(human: VerifiedHumanAccessClaims): void {
  if (!Number.isFinite(human.expiresAt) || human.expiresAt * 1000 <= Date.now()) {
    throw new AppError('NOT_FOUND', 404, 'Operator not found');
  }
}

function canonicalRepository(repositoryUrl: string): { repositoryUrl: string; owner: string; repository: string } {
  // Validate the original string too: URL normalization must not erase traversal,
  // empty components, a port, percent escapes, or an alternate authority spelling.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(repositoryUrl);
  if (!match || match[2] === '.' || match[2] === '..') throw new ValidationError('Invalid GitHub repository URL');
  const owner = match[1].toLowerCase();
  const repository = match[2].toLowerCase().replace(/\.git$/, '');
  if (!repository || repository === '.' || repository === '..') throw new ValidationError('Invalid GitHub repository URL');
  return { repositoryUrl: `https://github.com/${owner}/${repository}`, owner, repository };
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.status !== 200 || response.redirected || !response.body) throw new Error('GitHub response unavailable');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('GitHub response too large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('GitHub request deadline');
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('GitHub request deadline');
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('GitHub response too large');
      chunks.push(chunk.value);
    }
    completed = true;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** PAT only on a locally constructed API URL. At most one uncredentialed CDN redirect. */
async function githubBytes(path: string, pat: string, limit: number, deadline: number, binary = false,
  accept = binary ? 'application/octet-stream' : 'application/vnd.github+json'): Promise<Uint8Array> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub path');
  const controller = new AbortController();
  const remaining = Math.min(10_000, deadline - Date.now());
  if (remaining <= 0) throw new Error('GitHub acquisition deadline');
  const timer = setTimeout(() => controller.abort(), remaining);
  let response: Response | undefined;
  try {
    response = await fetch(new Request(`${API}${path}`, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: {
      accept, authorization: `Bearer ${pat}`,
      'x-github-api-version': '2022-11-28', 'user-agent': 'Codeflare-Operator-Acquisition',
    } }));
    if (binary && (response.status === 302 || response.status === 307)) {
      const location = response.headers.get('location');
      if (!location || location.length > 8192) throw new Error('Invalid GitHub redirect');
      const redirect = new URL(location);
      if (redirect.protocol !== 'https:' || !CDN_HOSTS.has(redirect.hostname) || redirect.port || redirect.username || redirect.password || redirect.hash) throw new Error('Unsafe GitHub redirect');
      void response.body?.cancel().catch(() => {});
      response = await fetch(new Request(redirect.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/octet-stream' } }));
    }
    const bytes = await readBounded(response, limit, controller.signal);
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error('GitHub acquisition deadline');
    return bytes;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

async function githubJson(path: string, pat: string, deadline: number): Promise<unknown> {
  const bytes = await githubBytes(path, pat, MAX_JSON_BYTES, deadline);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Narrow Actions ZIP reader: three regular files, no paths/encryption/ZIP64 and bounded inflate. */
function packageArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  // upload-artifact produces an ordinary ZIP without an archive comment.
  const end = bytes.length - 22;
  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0
    || u16(end + 8) !== 3 || u16(end + 10) !== 3 || u16(end + 20) !== 0) throw new Error('Invalid package archive');
  const centralStart = u32(end + 16);
  if (centralStart + u32(end + 12) !== end) throw new Error('Invalid package archive directory');
  let cursor = centralStart;
  let total = 0;
  const files = new Map<string, Uint8Array>();
  const regions: Array<[number, number]> = [];
  for (let i = 0; i < 3; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw new Error('Invalid package archive entry');
    const flags = u16(cursor + 8); const method = u16(cursor + 10);
    const compressed = u32(cursor + 20); const size = u32(cursor + 24);
    const nameLength = u16(cursor + 28); const extra = u16(cursor + 30); const comment = u16(cursor + 32);
    const local = u32(cursor + 42);
    const attributes = u32(cursor + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    const crc = u32(cursor + 16);
    if ((flags & ~0x808) !== 0 || (method !== 0 && method !== 8) || u16(cursor + 34) !== 0
      || (attributes & 0x10) !== 0 || (unixType !== 0 && unixType !== 0x8000)
      || size > MAX_BUNDLE_BYTES || cursor + 46 + nameLength + extra + comment > end) throw new Error('Unsafe package archive');
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!(FILES as readonly string[]).includes(name) || files.has(name) || local + 30 > centralStart || u32(local) !== 0x04034b50
      || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) throw new Error('Unsafe package archive entry');
    const localName = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(local + 30, local + 30 + nameLength));
    const start = local + 30 + nameLength + u16(local + 28);
    const finish = start + compressed;
    if (localName !== name || finish > centralStart) throw new Error('Invalid package archive bounds');
    let entryEnd = finish;
    if (flags & 8) {
      const descriptor = finish + (finish + 4 <= centralStart && u32(finish) === 0x08074b50 ? 4 : 0);
      entryEnd = descriptor + 12;
      if (entryEnd > centralStart || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) throw new Error('Invalid package archive descriptor');
      if ((u32(local + 14) !== 0 && u32(local + 14) !== crc) || (u32(local + 18) !== 0 && u32(local + 18) !== compressed)
        || (u32(local + 22) !== 0 && u32(local + 22) !== size)) throw new Error('Invalid package archive local lengths');
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size) throw new Error('Invalid package archive local lengths');
    if (regions.some(([a, b]) => local < b && entryEnd > a)) throw new Error('Overlapping package archive');
    regions.push([local, entryEnd]);
    const limit = name === 'operator-bundle.json' ? MAX_BUNDLE_BYTES : 64 * 1024;
    if (size > limit || (total += size) > MAX_ARCHIVE_BYTES) throw new Error('Oversized package archive');
    const encoded = bytes.subarray(start, finish);
    const decoded = method === 0 ? encoded : new Uint8Array(inflateRawSync(encoded, { maxOutputLength: limit }));
    if (decoded.length !== size || crc32(decoded) !== crc) throw new Error('Invalid package archive length or CRC');
    files.set(name, decoded);
    cursor += 46 + nameLength + extra + comment;
  }
  regions.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || regions[0][0] !== 0 || regions[regions.length - 1][1] !== centralStart
    || regions.some((region, i) => i > 0 && region[0] !== regions[i - 1][1])) throw new Error('Invalid package archive entries');
  return files;
}

async function resolveSource(repositoryUrl: string, pat: string, deadline: number) {
  const repository = canonicalRepository(repositoryUrl);
  const resolved = repositorySchema.parse(await githubJson(`/repos/${repository.owner}/${repository.repository}`, pat, deadline));
  if (resolved.full_name.toLowerCase() !== `${repository.owner}/${repository.repository}`
    || resolved.html_url.toLowerCase() !== repository.repositoryUrl) throw new Error('GitHub repository mismatch');
  const workflow = z.object({ id: positive, path: z.literal(workflowPath), state: z.literal('active') }).parse(
    await githubJson(`/repositories/${resolved.id}/actions/workflows/release.yml`, pat, deadline));
  // Registration is an explicit trust decision for this repository's release workflow,
  // not first-discovery TOFU from a package-authored provenance assertion.
  return { repositoryUrl: repository.repositoryUrl, repositoryId: resolved.id,
    approvedWorkflow: { id: workflow.id, ref: `${workflowPath}@refs/heads/${resolved.default_branch}` } };
}

async function acquireRelease(value: unknown, source: { id: string; repositoryId: number; sourceRevision: number; profile: ManagementOperatorProfile; approvedWorkflow: { id: number; ref: string } }, pat: string, deadline: number,
  allowLegacyProvenance = false): Promise<ManagementReleaseCandidate> {
  const remote = releaseSchema.parse(value);
  if (new Set(remote.assets.map(asset => asset.name)).size !== 3 || new Set(remote.assets.map(asset => asset.id)).size !== 3) throw new Error('Duplicate GitHub asset');
  const files = new Map<string, Uint8Array>();
  const digests = new Map<string, string>();
  for (const asset of remote.assets) {
    const limit = asset.name === 'operator-bundle.json' ? MAX_BUNDLE_BYTES : 64 * 1024;
    if (asset.size > limit) throw new Error('Oversized GitHub asset');
    const bytes = await githubBytes(`/repositories/${source.repositoryId}/releases/assets/${asset.id}`, pat, limit, deadline, true);
    const actual = await digest(bytes);
    if (bytes.length !== asset.size || asset.digest !== `sha256:${actual}`) throw new Error('GitHub asset digest mismatch');
    files.set(asset.name, bytes); digests.set(asset.name, actual);
  }
  const manifestBytes = files.get('operator-manifest.json')!;
  const bundleBytes = files.get('operator-bundle.json')!;
  const manifestDigest = digests.get('operator-manifest.json')!;
  const bundleDigest = digests.get('operator-bundle.json')!;
  const manifestJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(manifestBytes);
  const manifest = parseOperatorManifest(manifestJson, 'https://github.com/');
  if (manifest.profile !== source.profile || manifest.interfaceVersion !== 1 || manifest.artifact.sha256 !== bundleDigest) throw new Error('GitHub manifest mismatch');
  const dispatcherBundle = source.profile === 'dispatcher'
    ? await parseDispatcherBundle(bundleBytes, bundleDigest) : null;
  if (!dispatcherBundle) await parseOperatorBundle(bundleBytes, bundleDigest);
  const provenance = provenanceSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(files.get('operator-provenance.json')!)));
  if (!provenance.compilerCommit && !allowLegacyProvenance) throw new Error('Compiler provenance is required');
  if (dispatcherBundle && dispatcherBundle.sourceCommit !== provenance.sourceCommit) throw new Error('Dispatcher source mismatch');
  if (provenance.repositoryId !== source.repositoryId || provenance.manifestDigest !== manifestDigest || provenance.bundleDigest !== bundleDigest
    || provenance.workflow.id !== source.approvedWorkflow.id || provenance.workflow.ref !== source.approvedWorkflow.ref) throw new Error('GitHub provenance mismatch');
  const run = runSchema.parse(await githubJson(`/repositories/${source.repositoryId}/actions/runs/${provenance.workflow.runId}`, pat, deadline));
  if (run.id !== provenance.workflow.runId || run.run_attempt !== provenance.workflow.runAttempt || run.workflow_id !== source.approvedWorkflow.id
    || run.head_sha !== provenance.sourceCommit || run.repository.id !== source.repositoryId || run.head_repository.id !== source.repositoryId
    || run.path !== workflowPath || `${workflowPath}@refs/heads/${run.head_branch}` !== source.approvedWorkflow.ref) throw new Error('GitHub build identity mismatch');
  // Resolve the immutable release tag to a commit (including one annotated tag),
  // never treat target_commitish/main as an immutable source identity.
  let tag = z.object({ object: z.object({ type: z.enum(['commit', 'tag']), sha: commit }) }).parse(
    await githubJson(`/repositories/${source.repositoryId}/git/ref/tags/${encodeURIComponent(remote.tag_name)}`, pat, deadline)).object;
  if (tag.type === 'tag') tag = z.object({ object: z.object({ type: z.literal('commit'), sha: commit }) }).parse(
    await githubJson(`/repositories/${source.repositoryId}/git/tags/${tag.sha}`, pat, deadline)).object;
  if (tag.type !== 'commit' || tag.sha !== provenance.sourceCommit) throw new Error('GitHub release commit mismatch');
  const artifacts = z.object({ total_count: positive, artifacts: z.array(z.unknown()).max(100) }).parse(
    await githubJson(`/repositories/${source.repositoryId}/actions/runs/${run.id}/artifacts?name=operator-package&per_page=100`, pat, deadline));
  if (artifacts.total_count !== 1 || artifacts.artifacts.length !== 1) throw new Error('Ambiguous GitHub build artifact');
  const artifact = artifactSchema.parse(artifacts.artifacts[0]);
  if (artifact.size_in_bytes > MAX_ARCHIVE_BYTES || artifact.workflow_run.id !== run.id || artifact.workflow_run.repository_id !== source.repositoryId
    || artifact.workflow_run.head_repository_id !== source.repositoryId || artifact.workflow_run.head_sha !== provenance.sourceCommit) throw new Error('GitHub build artifact mismatch');
  const archive = await githubBytes(`/repositories/${source.repositoryId}/actions/artifacts/${artifact.id}/zip`, pat, MAX_ARCHIVE_BYTES, deadline, true, 'application/vnd.github+json');
  if (archive.length !== artifact.size_in_bytes || `sha256:${await digest(archive)}` !== artifact.digest) throw new Error('GitHub build digest mismatch');
  const built = packageArchive(archive);
  for (const name of FILES) if (await digest(built.get(name)!) !== digests.get(name)) throw new Error('Release bytes differ from approved build');
  return { manifestJson: JSON.stringify(manifest), bundleBytes, release: {
    id: `${source.id}-${source.sourceRevision}-${remote.id}`, operatorId: source.id, githubReleaseId: remote.id, repositoryId: source.repositoryId,
    sourceRevision: source.sourceRevision, sourceCommit: provenance.sourceCommit, manifestDigest, bundleDigest, interfaceVersion: 1,
    coreVersion: manifest.coreVersion, intentVersion: manifest.intentVersion,
    requestedCapabilities: [...manifest.requiredCapabilities], approved: false,
    assets: FILES.map(name => { const asset = remote.assets.find(candidate => candidate.name === name)!; return { id: asset.id, name, digest: digests.get(name)! }; }),
    provenance: { ...(provenance.compilerCommit ? { compilerCommit: provenance.compilerCommit } : {}),
      workflowId: run.workflow_id, workflowRef: source.approvedWorkflow.ref, runId: run.id,
      runAttempt: run.run_attempt, artifactId: artifact.id, artifactDigest: artifact.digest.slice('sha256:'.length) },
  } };
}

function deadlineFor(human: VerifiedHumanAccessClaims): number { return Math.min(human.expiresAt * 1000, Date.now() + 30_000); }
function unavailable(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError('UNAVAILABLE', 503, 'GitHub release acquisition unavailable');
}

/** Resolve repository and approved workflow before persisting a write-only acquisition PAT. */
export async function registerGithubOperator(context: GitHubContext, input: {
  repositoryUrl: string; githubPat: string; profile: ManagementOperatorProfile; realm: ManagementOperatorRealm;
  managers: ManagementGrant; invokers: ManagementGrant; policy: ManagementPolicy;
}) {
  requireCurrentAuthority(context.human);
  canonicalRepository(input.repositoryUrl);
  try {
    const source = await resolveSource(input.repositoryUrl, input.githubPat, deadlineFor(context.human));
    const human = await context.reauthorize(); requireCurrentAuthority(human);
    return await context.registry.registerManagement({ ...input, ...source }, {
      controlsRevision: context.controlsRevision, expiresAt: Math.min(human.expiresAt, context.human.expiresAt) * 1000,
    });
  } catch (error) { unavailable(error); }
}

export async function updateGithubOperatorSource(context: GitHubContext, operatorId: string, expectedRevision: number, input: { repositoryUrl: string; githubPat: string }) {
  requireCurrentAuthority(context.human);
  canonicalRepository(input.repositoryUrl);
  const existing = await context.registry.getManagementAcquisition(operatorId);
  if (!existing.ok) throw new AppError('NOT_FOUND', 404, 'Operator not found');
  if (existing.value.revision !== expectedRevision) throw new AppError('CONFLICT', 409, 'Operator management conflict');
  try {
    const source = await resolveSource(input.repositoryUrl, input.githubPat, deadlineFor(context.human));
    const human = await context.reauthorize(); requireCurrentAuthority(human);
    return await context.registry.setManagementSource(operatorId, { ...source, githubPat: input.githubPat }, {
      operatorRevision: expectedRevision, controlsRevision: context.controlsRevision, expiresAt: Math.min(human.expiresAt, context.human.expiresAt) * 1000,
    });
  } catch (error) { unavailable(error); }
}

/** Bounded discovery, verified Actions artifact binding, then one revision-checked atomic commit. */
export async function refreshGithubReleases(context: GitHubContext, operatorId: string, expectedRevision: number): Promise<ManagementRelease[]> {
  requireCurrentAuthority(context.human);
  const acquisition = await context.registry.getManagementAcquisition(operatorId);
  if (!acquisition.ok) throw new AppError('NOT_FOUND', 404, 'Operator not found');
  if (acquisition.value.revision !== expectedRevision) throw new AppError('CONFLICT', 409, 'Operator management conflict');
  try {
    const deadline = deadlineFor(context.human);
    const source = acquisition.value;
    const pat = await openOperatorSecret(source.githubPatCiphertext, context.encryption, { purpose: 'connection', recordId: operatorId });
    // Resolve numeric identity on every acquisition; repository-name reuse never switches trust.
    const repository = repositorySchema.parse(await githubJson(`/repositories/${source.repositoryId}`, pat, deadline));
    if (repository.id !== source.repositoryId || repository.html_url.toLowerCase() !== source.repositoryUrl) throw new Error('GitHub repository identity changed');
    // One bounded page; never silently walk unbounded release history. Retained
    // releases already in the registry remain available without GitHub I/O.
    const remote = z.array(z.unknown()).max(10).parse(await githubJson(`/repositories/${source.repositoryId}/releases?per_page=10`, pat, deadline));
    const retainedLegacyIds = new Set((await context.registry.getManagementReleases(operatorId))
      .filter(release => release.provenance.compilerCommit === undefined)
      .map(release => release.githubReleaseId));
    const candidates: ManagementReleaseCandidate[] = [];
    let aggregateBytes = 0;
    for (const release of remote) {
      const releaseId = z.object({ id: positive }).parse(release).id;
      const candidate = await acquireRelease(release, source, pat, deadline, retainedLegacyIds.has(releaseId));
      aggregateBytes += candidate.bundleBytes.length;
      if (aggregateBytes > 16 * 1024 * 1024) throw new Error('Release acquisition aggregate limit');
      candidates.push(candidate);
    }
    const human = await context.reauthorize(); requireCurrentAuthority(human);
    const stored = await context.registry.replaceManagementReleases(operatorId, {
      operatorRevision: expectedRevision, controlsRevision: context.controlsRevision, expiresAt: Math.min(human.expiresAt, context.human.expiresAt) * 1000,
    }, candidates);
    if (!stored.ok) throw new AppError(stored.reason === 'not-found' || stored.reason === 'authority-expired' ? 'NOT_FOUND' : 'CONFLICT',
      stored.reason === 'not-found' || stored.reason === 'authority-expired' ? 404 : 409, 'Operator release refresh conflicted');
    return stored.value;
  } catch (error) { unavailable(error); }
}
