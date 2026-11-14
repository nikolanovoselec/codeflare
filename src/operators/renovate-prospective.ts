import { z } from 'zod';
import type { Env } from '../types';
import type { RawCapture } from './raw-capture-storage';
import { parseOperatorPolicy } from './policy';
import type { CurrentProspectiveRegistration } from './registry';
import type { RetainedRenovateRetryTarget } from './renovate-retry-proof';
import { renovateRepositoryIdentity, type RenovateRepositoryIdentity } from './renovate-run-settings';

type ParentScanTransport = {
  env: Env; exports: Record<string, (input: { props: Record<string, unknown> }) => Fetcher>;
  repository: string; human: { email: string }; bucket: string; current: () => Promise<boolean>; capture?: RawCapture;
};
type ScanRequest = { method: string; url: string; path: string };
type ScanCapture = Pick<RawCapture, 'record' | 'flush'>;
const requestFields = ['headers', 'cache', 'credentials', 'destination', 'integrity', 'keepalive', 'mode',
  'referrer', 'referrerPolicy', 'redirect', 'bodyUsed', 'cf'] as const;
const responseFields = ['url', 'headers', 'status', 'statusText', 'ok', 'redirected', 'type', 'bodyUsed', 'cf', 'webSocket'] as const;
// Workerd exposes some fields on native instance templates and bodyUsed on an
// inherited Body prototype. Capture the entire pristine platform chain, never
// descriptors from application responses or their replacement prototypes.
function platformDescriptors(sample: Request | Response): PropertyDescriptorMap {
  const descriptors: PropertyDescriptorMap = {};
  for (let owner: object | null = sample; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))) {
      if (!Object.hasOwn(descriptors, key)) descriptors[key] = descriptor;
    }
  }
  return descriptors;
}
const requestDescriptors = platformDescriptors(new Request('https://operator.invalid/'));
const responseDescriptors = platformDescriptors(new Response(null));
/** Inspect only captured platform getters or own data; an application accessor is evidence, not executable capture. */
function transportMetadata(value: Request | Response, fields: readonly string[], native: PropertyDescriptorMap) {
  return Object.fromEntries(fields.map(key => {
    try {
      const own = Object.getOwnPropertyDescriptor(value, key);
      if (own && !('value' in own) && (!own.get || own.get !== native[key]?.get)) {
        return [key, { captureUnavailable: 'application-accessor' }];
      }
      const field: unknown = own && 'value' in own ? own.value : native[key]?.get?.call(value);
      return [key, key === 'headers' && field ? [...Headers.prototype.entries.call(field as Headers)] : field];
    } catch { return [key, { captureUnavailable: 'transport-field' }]; }
  }));
}
function record(capture: ScanCapture | undefined, stage: string, value: () => unknown): void {
  try { capture?.record(stage, value); } catch { /* Capture must never change the scan outcome. */ }
}
function scanError(capture: ScanCapture | undefined, request: ScanRequest, error: unknown): unknown {
  record(capture, 'discovery-response-error', () => ({ ...request, error }));
  return error;
}
// Each wait uses the original request signal, including time already spent waiting for headers.
async function beforeScanDeadline<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Only refused responses have an independent reader. Successful JSON consumption stays unchanged. */
async function readRefusedScanResponse(response: Response, capture: ScanCapture, request: ScanRequest, signal: AbortSignal): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let size = 0, delivered = 0, eof = false, observedError: unknown;
  try {
    // Use the pristine native Body getter, not an application-owned diagnostic accessor.
    const body = responseDescriptors.body?.get?.call(response) as ReadableStream<Uint8Array> | null | undefined;
    if (!body) throw Error('Renovate page unavailable');
    reader = body.getReader(); // A foreign lock is evidence of unavailability, never ours to release.
    for (;;) {
      const chunk = await beforeScanDeadline(signal, () => reader!.read());
      if (chunk.done) {
        eof = true;
        capture.record('discovery-response-eof', () => ({ ...request, offset: size }));
        await beforeScanDeadline(signal, () => capture.flush?.() ?? Promise.resolve());
        break;
      }
      delivered += chunk.value.byteLength;
      // Transport framing, not a payload cutoff: persist each part before expanding another.
      for (let start = 0; start < chunk.value.byteLength; start += 64 * 1024) {
        const bytes = chunk.value.subarray(start, start + 64 * 1024), offset = size;
        size += bytes.byteLength;
        capture.record('discovery-response-chunk', () => ({ ...request, offset, bytes: Array.from(bytes) }));
        await beforeScanDeadline(signal, () => capture.flush?.() ?? Promise.resolve());
      }
    }
  } catch (error) {
    observedError = error;
    scanError(capture, request, error);
    record(capture, 'discovery-response-incomplete', () => ({ ...request, offset: size, deliveredOffset: delivered, eof, error }));
  } finally {
    if (reader) {
      if (!eof) {
        const reason = signal.aborted ? signal.reason : undefined;
        record(capture, 'discovery-response-cancel', () => ({ ...request, offset: size, deliveredOffset: delivered,
          eof, action: 'reader.cancel', reason, observedError, pending: true }));
        try {
          const cancelled = reader.cancel(reason).then(() => {
            record(capture, 'discovery-response-cancel-settled', () => ({ ...request, offset: size, eof, reason, pending: false }));
          }, error => {
            scanError(capture, request, error);
            record(capture, 'discovery-response-cancel-settled', () => ({ ...request, offset: size, eof, reason, pending: false, error }));
          });
          // Release locally now; observing cancellation cannot extend the original request deadline.
          reader.releaseLock(); reader = undefined;
          await beforeScanDeadline(signal, () => cancelled);
        } catch (error) {
          scanError(capture, request, error);
          record(capture, 'discovery-response-incomplete', () => ({ ...request, offset: size, deliveredOffset: delivered,
            eof, cancellationPending: true, error }));
        }
      }
      reader?.releaseLock();
    }
  }
}

function captureRefusedScanResponse(response: Response, capture: RawCapture | undefined, request: ScanRequest, signal: AbortSignal): void {
  if (!capture) return;
  const produce = (writer: ScanCapture) => readRefusedScanResponse(response, writer, request, signal);
  try {
    if (capture.defer) capture.defer(produce);
    else {
      // Older caller-local sinks can observe bytes, but cannot promise parent-finalization ordering.
      record(capture, 'discovery-response-incomplete', () => ({ ...request, captureUnavailable: 'producer-lifecycle-unavailable' }));
      void Promise.resolve().then(() => produce(capture)).catch(error => { scanError(capture, request, error); });
    }
  } catch (error) {
    scanError(capture, request, error);
    record(capture, 'discovery-response-incomplete', () => ({ ...request, captureUnavailable: 'producer-lifecycle-failed', error }));
  }
}

async function readScanPage(response: Response, capture: RawCapture | undefined, request: ScanRequest): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder;
  try {
    if (!response.body) throw Error('Renovate page unavailable');
    reader = response.body.getReader();
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  } catch (error) { throw scanError(capture, request, error); }
  let size = 0, text = '', eof = false, observedError: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        eof = true;
        record(capture, 'discovery-response-eof', () => ({ ...request, offset: size }));
        break;
      }
      record(capture, 'discovery-response-chunk', () => ({ ...request, offset: size, bytes: Array.from(chunk.value) }));
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw Error('Renovate page exceeds byte bound');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (cause) {
    observedError = cause;
    scanError(capture, request, cause);
    throw Error('Renovate page unavailable', { cause });
  } finally {
    if (!eof) record(capture, 'discovery-response-cancel', () => ({ ...request, offset: size,
      eof, action: 'reader.cancel', reason: undefined, observedError }));
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
function scanTransport(input: ParentScanTransport) {
  if (!input.exports.GitHubInterceptor) throw Error('GitHub transport unavailable');
  const host = input.env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw Error('GitHub host invalid');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [input.repository], methods: ['GET'] },
    storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null,
      inheritUserDefaults: false } });
  const transport = input.exports.GitHubInterceptor({ props: {
    user: input.human.email, bucket: input.bucket, strict: true, operatorPolicy: policy,
  } });
  const root = `https://${host}/repos/${input.repository}`;
  return { root, get: async (path: string) => {
    const correlation = { method: 'GET', url: `${root}${path}`, path };
    let response: Response;
    try {
      if (!await input.current()) throw Error('Scan session changed');
      const request = new Request(`${root}${path}`, {
        redirect: 'manual', signal: AbortSignal.timeout(8000), headers: {
          accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Renovate',
        },
      });
      record(input.capture, 'discovery-request', () => ({ ...correlation,
        ...transportMetadata(request, requestFields, requestDescriptors),
        aborted: request.signal.aborted, abortReason: request.signal.reason }));
      response = await transport.fetch(request);
      record(input.capture, 'discovery-response', () => {
        const { url: responseUrl, ...metadata } = transportMetadata(response, responseFields, responseDescriptors);
        return { ...correlation, responseUrl, ...metadata };
      });
      if (response.status !== 200 || response.redirected) {
        captureRefusedScanResponse(response, input.capture, correlation, request.signal);
        throw Error('Incomplete Renovate scan');
      }
    } catch (error) { throw scanError(input.capture, correlation, error); }
    const value = await readScanPage(response, input.capture, correlation);
    try {
      if (!await input.current()) throw Error('Scan session changed');
      return { value, link: response.headers.get('link') };
    } catch (error) { throw scanError(input.capture, correlation, error); }
  } };
}
const metadata = z.object({ id: z.number().int().positive().safe(), full_name: z.string(),
  default_branch: z.string().min(1).max(128) });
function repositoryMetadata(value: unknown, repository: string, capture: RawCapture | undefined, url: string): RenovateRepositoryIdentity {
  const parsed = metadata.safeParse(value);
  if (!parsed.success || parsed.data.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw scanError(capture, { method: 'GET', url, path: '' }, Error('Renovate repository identity changed'));
  }
  return { repository, repositoryId: parsed.data.id, baseBranch: parsed.data.default_branch };
}
/** Typed parent configuration supplies the path; browsers never supply a numeric identity or URL. */
export async function resolveProspectiveRenovateRepository(input: ParentScanTransport): Promise<RenovateRepositoryIdentity> {
  const { root, get } = scanTransport(input);
  return repositoryMetadata((await get('')).value, input.repository, input.capture, root);
}
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const pr = z.object({ number: z.number().int().positive().safe(), state: z.literal('open'), draft: z.boolean(),
  created_at: z.string().datetime({ offset: true }), user: z.object({ id: z.number().int().safe(),
    login: z.string(), type: z.string() }), head: z.object({ sha: commit }),
  base: z.object({ ref: z.string().min(1).max(128), sha: commit,
    repo: z.object({ id: z.number().int().positive().safe(), full_name: z.string() }) }) });
export async function listProspectiveRenovatePrs(input: {
  env: Env; exports: ParentScanTransport['exports']; registration: CurrentProspectiveRegistration;
  current: () => Promise<boolean>; retainedRetryTargets?: readonly RetainedRenovateRetryTarget[]; capture?: RawCapture;
}): Promise<Array<RenovateRepositoryIdentity & { pullRequest: number; head: string; createdAt: string }>> {
  const { registration } = input;
  const identity = renovateRepositoryIdentity.safeParse({ repository: registration.repository,
    repositoryId: registration.repositoryId, baseBranch: registration.baseBranch });
  if (!identity.success) throw Error('Renovate registration unavailable');
  const { root, get } = scanTransport({ ...input, ...registration });
  const observed = repositoryMetadata((await get('')).value, identity.data.repository, input.capture, root);
  if (observed.repositoryId !== identity.data.repositoryId || observed.baseBranch !== identity.data.baseBranch) {
    throw scanError(input.capture, { method: 'GET', url: root, path: '' }, Error('Renovate repository identity changed'));
  }
  const found: Array<RenovateRepositoryIdentity & { pullRequest: number; head: string; createdAt: string }> = [];
  let complete = false, path = '';
  for (let page = 1; page <= 10; page++) {
    path = `/pulls?state=open&per_page=100&page=${page}`;
    const result = await get(path);
    try {
      const parsed = z.array(pr).max(100).safeParse(result.value);
      if (!parsed.success) throw Error('Incomplete Renovate scan');
      const rows = parsed.data;
      if (result.link) {
        if (result.link.length > 8192) throw Error('Incomplete Renovate scan');
        const links = result.link.split(',').map(value => value.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/));
        if (links.some(value => !value)) throw Error('Incomplete Renovate scan');
        const nextLinks = links.filter(value => value![2].split(/\s+/).includes('next'));
        if (nextLinks.length > 1 || nextLinks.length && rows.length < 100) throw Error('Incomplete Renovate scan');
        if (nextLinks[0]) {
          const next = new URL(nextLinks[0][1]);
          const expected = new URL(`${root}/pulls?state=open&per_page=100&page=${page + 1}`);
          if (next.origin !== expected.origin || next.pathname !== expected.pathname || next.username || next.password || next.hash
            || [...next.searchParams].length !== 3
            || ['state', 'per_page', 'page'].some(key => next.searchParams.get(key) !== expected.searchParams.get(key))) {
            throw Error('Incomplete Renovate scan');
          }
        }
      }
      for (const row of rows) {
        if (row.draft || row.base.ref !== identity.data.baseBranch || row.base.repo.id !== identity.data.repositoryId
          || row.base.repo.full_name.toLowerCase() !== identity.data.repository.toLowerCase()
          || row.user.id !== 29139614 || row.user.login !== 'renovate[bot]' || row.user.type !== 'Bot') continue;
        const createdAt = new Date(row.created_at).toISOString();
        if (createdAt > registration.activatedAt) found.push({ ...identity.data,
          pullRequest: row.number, head: row.head.sha, createdAt });
      }
      if (rows.length < 100) { complete = true; break; }
    } catch (error) { throw scanError(input.capture, { method: 'GET', url: `${root}${path}`, path }, error); }
  }
  try {
    if (!complete) throw Error('Renovate scan exceeds page bound');
    if (!await input.current()) throw Error('Scan session changed');
  } catch (error) { throw scanError(input.capture, { method: 'GET', url: `${root}${path}`, path }, error); }
  return found;
}
