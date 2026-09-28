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
    const request = new Request(`${API}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5_000),
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
    const pulls = await get(`${root}/commits/${head}/pulls`) as Array<{ number?: number;
      state?: string; head?: { sha?: string } }>;
    // This endpoint associates the commit with the PR, but its PR head is mutable after a later push.
    if (!Array.isArray(pulls) || !pulls.some(pr => pr.number === input.pullRequest))
      throw Error('Foreign head');
    return pulls;
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
        case 'head-association': value = await associated(request.head); break;
        case 'merge-base': {
          if (request.base !== pr.base?.sha) throw Error('Base changed');
          await associated(request.head);
          value = await get(`${root}/compare/${request.base}...${request.head}`); break;
        }
        case 'comments-page':
          if (request.pullRequest !== undefined && request.pullRequest !== input.pullRequest)
            throw Error('Foreign Review comment scope');
          value = await get(`${root}/issues/${input.pullRequest}/comments?per_page=100&page=${request.page}`); break;
        case 'comment': value = await get(`${root}/issues/comments/${request.id}`); break;
        case 'artifact-list': {
          const readPage = async (number: number) => {
            const page = await get(`${root}/actions/artifacts?per_page=100&page=${number}${request.name
              ? `&name=${request.name}` : ''}`) as { total_count?: number; artifacts?: unknown[] };
            if (!Number.isSafeInteger(page.total_count) || page.total_count! < 0
              || !Array.isArray(page.artifacts) || page.artifacts.length > 100)
              throw Error('Incomplete artifact listing');
            return page as { total_count: number; artifacts: unknown[] };
          };
          if (request.page !== undefined) { value = (await readPage(request.page)).artifacts; break; }
          if (!request.name) throw Error('Unbounded artifact listing');
          const artifacts: unknown[] = [];
          let complete = false;
          for (let number = 1; number <= 20; number++) {
            const page = await readPage(number);
            if (page.total_count > 2000 || page.total_count < artifacts.length + page.artifacts.length)
              throw Error('Incomplete artifact listing');
            artifacts.push(...page.artifacts);
            if (artifacts.length === page.total_count) { complete = true; break; }
            if (page.artifacts.length !== 100) throw Error('Incomplete artifact listing');
          }
          if (!complete) throw Error('Artifact listing exceeds bound');
          value = artifacts; break;
        }
        case 'checks-page': {
          const head = 'head' in request && typeof request.head === 'string' ? request.head : input.head;
          if (head !== input.head) await associated(head);
          value = await get(`${root}/commits/${head}/check-runs?filter=all&per_page=100&page=${request.page}`); break;
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
            || !/^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/.test(signed.hostname)
            && !['productionresultssa1.blob.core.windows.net', 'productionresultssa3.blob.core.windows.net',
              'productionresultssa8.blob.core.windows.net', 'productionresultssa16.blob.core.windows.net']
              .includes(signed.hostname)) throw Error('Invalid signed archive origin');
          await current();
          const signedRequest = new Request(signed.href, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
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
        const item = value as { id?: number; issue_url?: string; head_sha?: string };
        if (item.id !== request.id || request.operation === 'comment'
          && item.issue_url !== `${API}${root}/issues/${input.pullRequest}`
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

/** PR-wide published evidence is read under the current user's GitHub access, not
 * through another user's private Activity. It is advisory until the next round's
 * Conductor independently authenticates the same artifact. */
export async function readGithubActionsPublisherIdentity(input: {
  token: string; fetch(request: Request): Promise<Response>;
}): Promise<{ commentAuthorId: number; checkAppId: number } | null> {
  try {
    const read = async (path: string) => {
      const request = new Request(`${API}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28' } });
      const response = await input.fetch(request);
      if (!response.ok || response.redirected || response.url && response.url !== request.url)
        throw Error('Publisher identity unavailable');
      return JSON.parse(decoder.decode(await readBoundedResponse(response, 8192, 'Publisher identity', request.signal)));
    };
    const [bot, app] = await Promise.all([read('/users/github-actions%5Bbot%5D'), read('/apps/github-actions')]);
    if (bot?.login !== 'github-actions[bot]' || bot.type !== 'Bot'
      || !Number.isSafeInteger(bot.id) || bot.id <= 0 || app?.slug !== 'github-actions'
      || !Number.isSafeInteger(app.id) || app.id <= 0) return null;
    return { commentAuthorId: bot.id, checkAppId: app.id };
  } catch { return null; }
}

export async function readPublishedReview(input: {
  repository?: string; repositoryId: number; pullRequest: number; activityId: string;
  trustedWorkflowId: number; head?: string; currentHead?: string;
  publisher: { commentAuthorId: number; checkAppId: number };
  history: { read(request: HistoryReadRequest): Promise<HistoryReadResult> };
}): Promise<{ status: 'unavailable' } | { schemaVersion: 1; status: 'published'; repository?: string;
  repositoryId: number; pullRequest: number; activityId: string; head: string; round: number;
  artifactDigest: string; findings: Array<{ id: string; lane: string; severity: string;
    path: string; line: number; message: string; evidence: string }>;
  omittedFindings: number }> {
  const unavailable = { status: 'unavailable' } as const;
  const digestPattern = /^[a-f0-9]{64}$/;
  const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  if (!positive(input.repositoryId) || !positive(input.pullRequest)
    || !positive(input.trustedWorkflowId) || !idPattern.test(input.activityId)
    || input.head !== undefined && !SHA.test(input.head)
    || input.currentHead !== undefined && !SHA.test(input.currentHead)
    || !positive(input.publisher.commentAuthorId) || !positive(input.publisher.checkAppId)) return unavailable;
  const read = async (request: HistoryReadRequest): Promise<any> => {
    const result = await input.history.read(request);
    if (!result?.complete || !Object.hasOwn(result, 'value')) throw Error('Published history unavailable');
    return result.value;
  };
  try {
    const repo = await read({ schemaVersion: 1, operation: 'repository' });
    const pr = await read({ schemaVersion: 1, operation: 'pr-context', pullRequest: input.pullRequest });
    if (repo?.id !== input.repositoryId || pr?.number !== input.pullRequest || pr?.state !== 'open'
      || pr?.head?.repo?.id !== input.repositoryId || pr?.base?.repo?.id !== input.repositoryId
      || !SHA.test(pr?.head?.sha ?? '') || input.currentHead && pr.head.sha !== input.currentHead
      || repo.permissions?.pull !== true) throw Error('Published PR unavailable');
    const prefix = `review-${input.repositoryId}-${input.pullRequest}-${input.activityId}-generation-`;
    const matches: Array<{ id: number; marker: string; head: string; digest: string; round: number }> = [];
    for (let page = 1; page <= 20; page++) {
      const comments = await read({ schemaVersion: 1, operation: 'comments-page', page });
      if (!Array.isArray(comments) || comments.length > 100) throw Error('Published comments unavailable');
      for (const item of comments) {
        if (!positive(item?.id) || typeof item?.body !== 'string'
          || !item.body.startsWith(`<!-- codeflare-review:${prefix}`)) continue;
        const marker = item.body.match(/^<!-- codeflare-review:(review-[0-9]+-[0-9]+-[A-Za-z0-9_-]+-generation-([1-9][0-9]*):([a-f0-9]{64})) -->\n/);
        if (!marker || !marker[1].startsWith(prefix) || !positive(Number(marker[2]))
          || !digestPattern.test(marker[3])) throw Error('Published marker altered');
        const trailer = item.body.slice(item.body.lastIndexOf('\n') + 1);
        const metadata = JSON.parse(trailer) as { head?: unknown; artifactDigest?: unknown };
        if (!SHA.test(String(metadata.head ?? '')) || metadata.artifactDigest !== marker[3])
          throw Error('Published comment altered');
        if (input.head && metadata.head !== input.head) continue;
        matches.push({ id: item.id, marker: marker[1], head: metadata.head as string,
          digest: marker[3], round: Number(marker[2]) });
      }
      if (comments.length < 100) break;
      if (page === 20) throw Error('Published comment pagination incomplete');
    }
    if (matches.length !== 1) throw Error('Published round ambiguous');
    const selected = matches[0];
    if (selected.head !== pr.head.sha) await read({ schemaVersion: 1, operation: 'head-association', head: selected.head });
    const comment = await read({ schemaVersion: 1, operation: 'comment', id: selected.id });
    if (comment?.id !== selected.id || comment?.user?.id !== input.publisher.commentAuthorId)
      throw Error('Published comment identity changed');
    const artifacts: Array<{ id: number; name: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await read({ schemaVersion: 1, operation: 'artifact-list', page,
        name: `boundary-review-${selected.digest}` });
      if (!Array.isArray(rows) || rows.length > 100) throw Error('Published artifact list unavailable');
      artifacts.push(...rows.filter((row: any) => row?.name === `boundary-review-${selected.digest}`));
      if (rows.length < 100) break;
      if (page === 20) throw Error('Published artifact pagination incomplete');
    }
    if (artifacts.length !== 1 || !positive(artifacts[0].id)) throw Error('Published artifact ambiguous');
    const stored = await read({ schemaVersion: 1, operation: 'artifact', id: artifacts[0].id });
    if (stored?.id !== artifacts[0].id || !positive(stored?.runId)
      || typeof stored?.bytes !== 'string' || stored.bytes.length > 100_000
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(stored.bytes)) throw Error('Published artifact unavailable');
    const bytes = Uint8Array.from(atob(stored.bytes), char => char.charCodeAt(0));
    if (bytes.length > 72 * 1024) throw Error('Published artifact too large');
    const artifact = JSON.parse(decoder.decode(bytes)) as Record<string, any>;
    const { binding, result } = artifact;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify({ binding, result })))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const admission = binding?.admission, context = binding?.context;
    if (artifact.marker !== selected.marker || artifact.digest !== selected.digest || hash !== selected.digest
      || admission?.repositoryId !== input.repositoryId || admission.pullRequest !== input.pullRequest
      || admission.activityId !== input.activityId || admission.generation !== selected.round
      || admission.workflowId !== input.trustedWorkflowId
      || context?.head !== selected.head || context.repositoryId !== input.repositoryId
      || context.pullRequest !== input.pullRequest || result?.head !== selected.head
      || result.activityId !== input.activityId || result.generation !== selected.round
      || result.repositoryId !== input.repositoryId || result.pullRequest !== input.pullRequest
      || result.packageDigest !== admission.packageDigest || result.activityGeneration !== binding.activityGeneration
      || result.status !== 'complete' || result.cleanup !== 'stopped'
      || result.history?.coverageAdvanced !== true || !Array.isArray(result.originalReports)
      || result.originalReports.length !== 3 || stored.runId !== admission.runId) {
      throw Error('Published result altered');
    }
    const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
    const originals = result.originalReports.flatMap((report: any, index: number) => {
      if (report?.lane !== lanes[index] || report.head !== selected.head || report.generation !== selected.round
        || report.packetDigest !== binding.packetDigest || report.complete !== true
        || !Array.isArray(report.omissions) || report.omissions.length || !Array.isArray(report.findings)
        || report.findings.length > 100) throw Error('Published original report altered');
      return report.findings.map((finding: any) => {
        if (!idPattern.test(finding?.id ?? '') || !['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(finding.severity)
          || typeof finding.path !== 'string' || !finding.path || finding.path.length > 1024
          || !positive(finding.line) || typeof finding.message !== 'string' || !finding.message
          || typeof finding.evidence !== 'string' || !finding.evidence) throw Error('Published finding altered');
        const bounded = (text: string) => text.length <= 512 ? text : `${text.slice(0, 498)}… [truncated]`;
        return { id: finding.id, lane: report.lane, severity: finding.severity,
          path: finding.path, line: finding.line, message: bounded(finding.message),
          evidence: bounded(finding.evidence) };
      });
    });
    if (new Set(originals.map((finding: { id: string }) => finding.id)).size !== originals.length)
      throw Error('Published finding identity collision');
    const run = await read({ schemaVersion: 1, operation: 'run', id: admission.runId });
    if (run?.id !== admission.runId || run.run_attempt !== admission.runAttempt
      || run.workflow_id !== input.trustedWorkflowId || run.repository?.id !== input.repositoryId
      || run.event !== 'pull_request_target' || !run.pull_requests?.some((pull: any) => pull.number === input.pullRequest)
      || binding.runId && binding.runId !== admission.runId
      || binding.runAttempt && binding.runAttempt !== admission.runAttempt) throw Error('Published run altered');
    const checks = await read({ schemaVersion: 1, operation: 'checks-page', head: selected.head, page: 1 });
    const matching = checks?.check_runs?.filter((check: any) => check?.external_id === selected.marker);
    if (!Array.isArray(matching) || matching.length !== 1 || !positive(matching[0].id))
      throw Error('Published check unavailable');
    const check = await read({ schemaVersion: 1, operation: 'check', id: matching[0].id });
    const expected = result.presentation?.check;
    if (check?.id !== matching[0].id || check.app?.id !== input.publisher.checkAppId
      || check.external_id !== selected.marker || check.head_sha !== selected.head
      || check.name !== expected?.name || check.status !== 'completed'
      || check.conclusion !== expected.conclusion || check.output?.title !== expected.name
      || check.output?.summary !== expected.summary || !['failure', 'success'].includes(check.conclusion)
      || check.conclusion === 'success' && (!result.history.clear || originals.length))
      throw Error('Published check altered');
    const exactBody = `<!-- codeflare-review:${selected.marker} -->\n${result.presentation.commentBody}\n`
      + JSON.stringify({ head: selected.head, artifactDigest: selected.digest });
    if (comment.body !== exactBody) throw Error('Published comment content changed');
    const findings = originals.slice(0, 20);
    return { schemaVersion: 1, status: 'published', ...(input.repository ? { repository: input.repository } : {}),
      repositoryId: input.repositoryId, pullRequest: input.pullRequest, activityId: input.activityId,
      head: selected.head, round: selected.round, artifactDigest: selected.digest,
      findings, omittedFindings: originals.length - findings.length };
  } catch { return unavailable; }
}
