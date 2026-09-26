import { historyRead, type HistoryReadRequest, type HistoryReadResult } from './conductor-capability';
import { readBoundedResponse } from '../lib/bounded-stream';
import { Inflate } from 'fflate';

const API = 'https://api.github.com';
const ZIP_LIMIT = 96 * 1024;
const FILE_LIMIT = 72 * 1024;
const COLLECTION_LIMIT = 256 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const failure = (): HistoryReadResult => ({ complete: false });

/** Accept exactly one bounded, safe ZIP member; never extract paths to disk. */
function extract(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  if (zip.length < 98 || u32(zip.length - 22) !== 0x06054b50 || u16(zip.length - 2) !== 0
    || u16(zip.length - 12) !== 1 || u16(zip.length - 14) !== 1
    || u16(zip.length - 18) !== 0 || u16(zip.length - 16) !== 0) throw Error('Invalid archive directory');
  const offset = u32(zip.length - 6), size = u32(zip.length - 10);
  if (offset < 30 || offset + size !== zip.length - 22 || offset + 46 > zip.length
    || u32(offset) !== 0x02014b50 || u32(0) !== 0x04034b50) throw Error('Invalid archive');
  const flags = u16(offset + 8), method = u16(offset + 10);
  const length = u32(offset + 24), compressed = u32(offset + 20);
  const nameLength = u16(offset + 28);
  if (flags & ~(0x08 | 0x800) || ![0, 8].includes(method) || length > FILE_LIMIT
    || compressed > ZIP_LIMIT || method === 0 && compressed !== length
    || u16(offset + 30) !== 0 || u16(offset + 32) !== 0 || u16(offset + 34) !== 0
    || u32(offset + 42) !== 0 || offset + 46 + nameLength !== zip.length - 22
    || u16(6) !== flags || u16(8) !== method || u16(26) !== nameLength) throw Error('Invalid archive member');
  const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
  if (name !== 'review.json' || decoder.decode(zip.subarray(30, 30 + nameLength)) !== name)
    throw Error('Invalid archive path');
  const start = 30 + nameLength, end = start + compressed;
  if (end > offset) throw Error('Invalid archive length');
  if (flags & 0x08) {
    const descriptor = end + (u32(end) === 0x08074b50 ? 4 : 0);
    if (descriptor + 12 !== offset || u32(descriptor) !== u32(offset + 16)
      || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== length
      || ![0, u32(offset + 16)].includes(u32(14)) || ![0, compressed].includes(u32(18))
      || ![0, length].includes(u32(22))) throw Error('Invalid archive descriptor');
  } else if (end !== offset || u32(14) !== u32(offset + 16)
    || u32(18) !== compressed || u32(22) !== length) throw Error('Invalid archive header');
  let bytes: Uint8Array;
  if (method === 0) bytes = zip.subarray(start, end);
  else {
    const chunks: Uint8Array[] = []; let count = 0; let done = false;
    const inflater = new Inflate((chunk, final) => {
      count += chunk.length;
      if (count > FILE_LIMIT || count > length) throw Error('Archive inflated beyond bound');
      chunks.push(chunk); done = final;
    });
    for (let at = start; at < end; at += 128) {
      inflater.push(zip.subarray(at, Math.min(end, at + 128)), at + 128 >= end);
    }
    if (!done || count !== length) throw Error('Incomplete archive member');
    bytes = new Uint8Array(count); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  }
  if (bytes.length !== length) throw Error('Archive length mismatch');
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  if (((crc ^ 0xffffffff) >>> 0) !== u32(offset + 16)) throw Error('Archive checksum mismatch');
  return bytes;
}

export function createAuthenticatedHistoryTransport(input: {
  repository: string; repositoryId: number; pullRequest: number; head: string; base?: string;
  token: string; current(): Promise<void>; fetch(request: Request): Promise<Response>;
}) {
  if (!REPOSITORY.test(input.repository) || input.repository.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
    || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1 || !SHA.test(input.head)
    || input.base !== undefined && !SHA.test(input.base)) throw Error('Invalid history scope');
  let spent = 0;
  const deadline = Date.now() + 25_000;
  const root = `/repos/${input.repository}`;
  const current = async () => { await input.current(); if (Date.now() >= deadline) throw Error('History deadline'); };
  const get = async (path: string, max = COLLECTION_LIMIT): Promise<unknown> => {
    await current();
    const request = new Request(`${API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28' } });
    const response = await input.fetch(request);
    if (!response.ok || response.redirected || response.url && response.url !== request.url)
      throw Error('History unavailable');
    const bytes = await readBoundedResponse(response, Math.min(max, COLLECTION_LIMIT - spent), 'History', request.signal);
    await current(); spent += bytes.length;
    return JSON.parse(decoder.decode(bytes));
  };
  const bound = async () => {
    const repo = await get(root) as { id?: number };
    const pr = await get(`${root}/pulls/${input.pullRequest}`) as { number?: number; head?: { sha?: string; repo?: { id?: number } };
      base?: { sha?: string; repo?: { id?: number } } };
    if (repo.id !== input.repositoryId || pr.number !== input.pullRequest
      || pr.head?.sha !== input.head || pr.head.repo?.id !== input.repositoryId
      || pr.base?.repo?.id !== input.repositoryId || input.base && pr.base?.sha !== input.base) throw Error('PR changed');
    return { repo, pr };
  };
  const associated = async (head: string) => {
    if (!SHA.test(head)) throw Error('Invalid head');
    const pulls = await get(`${root}/commits/${head}/pulls`) as Array<{ number?: number; head?: { sha?: string } }>;
    if (!Array.isArray(pulls) || !pulls.some(pr => pr.number === input.pullRequest && pr.head?.sha === head))
      throw Error('Foreign head');
  };
  const run = async (id: number) => {
    const value = await get(`${root}/actions/runs/${id}`) as { id?: number; repository?: { id?: number };
      pull_requests?: Array<{ number?: number }>; head_sha?: string; event?: string };
    if (value.id !== id || value.repository?.id !== input.repositoryId
      || value.event !== 'pull_request_target' || !SHA.test(value.head_sha ?? '')
      || !value.pull_requests?.some(pr => pr.number === input.pullRequest)) throw Error('Foreign run');
    // pull_request_target runs on the protected base commit, not on the PR head.
    return value;
  };
  const read = async (raw: unknown): Promise<HistoryReadResult> => {
    try {
      const request = historyRead.parse(raw) as HistoryReadRequest;
      await current();
      const { repo, pr } = await bound();
      let value: unknown;
      switch (request.operation) {
        case 'repository': value = repo; break;
        case 'pr-context':
          if (request.pullRequest && request.pullRequest !== input.pullRequest || request.head && request.head !== input.head
            || request.base && request.base !== pr.base?.sha) throw Error('PR scope mismatch');
          value = pr; break;
        case 'head-association': await associated(request.head); value = { head: request.head, pullRequest: input.pullRequest }; break;
        case 'merge-base': {
          if (request.base !== pr.base?.sha) throw Error('Base changed');
          await associated(request.head);
          value = await get(`${root}/compare/${request.base}...${request.head}`); break;
        }
        case 'comments-page': value = await get(`${root}/issues/${input.pullRequest}/comments?per_page=100&page=${request.page}`); break;
        case 'comment': value = await get(`${root}/issues/comments/${request.id}`); break;
        case 'artifact-list': value = await get(`${root}/actions/artifacts?per_page=100&page=${request.page}${request.name
          ? `&name=${request.name}` : ''}`); break;
        case 'checks-page': {
          const head = request.head ?? input.head;
          if (head !== input.head) await associated(head);
          value = await get(`${root}/commits/${head}/check-runs?per_page=100&page=${request.page}`); break;
        }
        case 'check': value = await get(`${root}/check-runs/${request.id}`); break;
        case 'run': value = await run(request.id); break;
        case 'artifact': {
          const artifact = await get(`${root}/actions/artifacts/${request.id}`) as { id?: number; expired?: boolean;
            workflow_run?: { id?: number; repository_id?: number; head_sha?: string } };
          if (artifact.id !== request.id || artifact.expired || artifact.workflow_run?.repository_id !== input.repositoryId
            || !artifact.workflow_run.id || !artifact.workflow_run.head_sha) throw Error('Foreign artifact');
          const observedRun = await run(artifact.workflow_run.id);
          if (observedRun.head_sha !== artifact.workflow_run.head_sha) throw Error('Artifact run changed');
          await current();
          const redirect = await input.fetch(new Request(`${API}${root}/actions/artifacts/${request.id}/zip`, {
            redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: {
              authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json' } }));
          const location = redirect.headers.get('location');
          if (redirect.status !== 302 || !location) throw Error('Missing signed archive');
          const signed = new URL(location);
          if (signed.protocol !== 'https:' || signed.username || signed.password
            || !/^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/.test(signed.hostname))
            throw Error('Invalid signed archive origin');
          await current();
          const signedRequest = new Request(signed.href, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
          const response = await input.fetch(signedRequest);
          if (!response.ok || response.redirected || response.url && response.url !== signed.href)
            throw Error('Archive unavailable');
          const zip = await readBoundedResponse(response, Math.min(ZIP_LIMIT, COLLECTION_LIMIT - spent),
            'History archive', signedRequest.signal);
          spent += zip.length;
          const bytes = extract(zip);
          value = { id: request.id, runId: artifact.workflow_run.id,
            bytes: btoa(String.fromCharCode(...bytes)) };
          break;
        }
      }
      if (request.operation === 'comment' || request.operation === 'check') {
        const item = value as { id?: number; pull_request_url?: string; head_sha?: string };
        if (item.id !== request.id || request.operation === 'comment'
          && item.pull_request_url !== `${API}${root}/pulls/${input.pullRequest}`
          || request.operation === 'check' && !SHA.test(item.head_sha ?? '')) throw Error('Foreign item');
        if (request.operation === 'check' && item.head_sha !== input.head) await associated(item.head_sha!);
      }
      if ((request.operation === 'comments-page' || request.operation === 'checks-page') && (!Array.isArray(value)
        && !(request.operation === 'checks-page' && Array.isArray((value as { check_runs?: unknown })?.check_runs))))
        throw Error('Incomplete page');
      await current();
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (spent + bytes.length > COLLECTION_LIMIT) throw Error('History budget');
      spent += bytes.length;
      return { complete: true, value };
    } catch { return failure(); }
  };
  return { read };
}
