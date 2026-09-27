// Trusted protected-base Action transport. Operator code and Review policy run only in Codeflare.
import { createHash } from 'node:crypto';
import { mkdtemp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const origin = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
  catch { return false; }
};

async function boundedJson(response, limit = 65 * 1024) {
  if (!response?.ok || response.redirected || !response.body
    || Number(response.headers.get('content-length') ?? 0) > limit) throw Error('Trusted response unavailable');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Trusted response exceeds bound');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

/** Start exactly once. A lost start response has no safe automatic recovery. */
export async function collectBoundaryResult(handoff, services, options = {}) {
  if (!origin(handoff?.origin) || !ID.test(handoff?.activityId) || !CAPABILITY.test(handoff?.startCapability)
    || typeof services?.fetch !== 'function') return { status: 'unknown' };
  const wait = services.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = services.now ?? Date.now;
  const duration = options.observationMs ?? 15 * 60_000;
  const maxContinuations = options.maxContinuations ?? 4;
  if (typeof wait !== 'function' || typeof now !== 'function' || !positive(duration) || duration > 30 * 60_000
    || !Number.isSafeInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > 16) return { status: 'unknown' };
  const deadline = now() + duration;
  const request = async (operation, method, capability, generation) => {
    const url = `${handoff.origin}/operator-webhook/v1/activities/${encodeURIComponent(handoff.activityId)}/${operation}`;
    const response = await services.fetch(new Request(url, { method, redirect: 'error',
      headers: { authorization: `Bearer ${capability}`,
        ...(generation !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(generation !== undefined ? { body: JSON.stringify({ generation }) } : {}),
      signal: AbortSignal.timeout(Math.min(30_000, Math.max(1, deadline - now()))) }));
    if (response.url && response.url !== url) throw Error('Webhook origin moved');
    return boundedJson(response);
  };
  let readCapability;
  try {
    const start = await request('start', 'POST', handoff.startCapability);
    if (start?.ok !== true || start.phase !== 'queued' || !CAPABILITY.test(start.readCapability)) return { status: 'unknown' };
    readCapability = start.readCapability;
  } catch { return { status: 'unknown' }; }
  let continued = 0, continuations = 0;
  while (now() < deadline) {
    try {
      const state = await request('status', 'GET', readCapability);
      if (state?.ok !== true || typeof state.terminal !== 'boolean' || 'result' in state) return { status: 'unknown' };
      if (state.terminal) {
        if (!['completed', 'failed'].includes(state.status) || !positive(state.generation)) return { status: 'unknown' };
        // Only an observed terminal result can be retried; the same read capability
        // rereads immutable bytes, never a new claim or start.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const final = await request('result', 'POST', readCapability);
            if (final?.ok !== true || final.terminal !== true || final.status !== state.status
              || final.generation !== state.generation || !final.result || bytes(final.result) > 64 * 1024) {
              return { status: 'unknown' };
            }
            return { status: 'collected', activityId: handoff.activityId,
              activityGeneration: state.generation, result: final.result };
          } catch { if (attempt) return { status: 'unknown' }; }
        }
      }
      if (state.status === 'waiting' && positive(state.generation) && state.generation !== continued) {
        if (continuations === maxContinuations) return { status: 'pending' };
        const result = await request('continue', 'POST', readCapability, state.generation);
        if (result?.ok !== true) return { status: 'unknown' };
        continued = state.generation; continuations++;
      } else if (state.status !== 'queued' && state.status !== 'running' && state.status !== 'waiting') {
        return { status: 'unknown' };
      }
      await wait(Math.min(5000, Math.max(1, deadline - now())));
    } catch { return { status: 'unknown' }; }
  }
  return { status: 'pending' };
}

function githubClient(config) {
  if (!config || config.origin !== 'https://api.github.com'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? '')
    || typeof config.token !== 'string' || !config.token || typeof config.fetch !== 'function'
    || !positive(config.commentAuthorId) || !positive(config.checkAppId)) throw Error('Publisher unavailable');
  return {
    ...config,
    async request(method, suffix, body) {
      const url = `${config.origin}/repos/${config.repository}${suffix}`;
      const response = await config.fetch(new Request(url, { method, redirect: 'error',
        headers: { authorization: `Bearer ${config.token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) }));
      if (response.url && response.url !== url) throw Error('Publisher origin moved');
      return boundedJson(response, 1024 * 1024);
    },
  };
}

async function comments(client, pullRequest) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const next = await client.request('GET', `/issues/${pullRequest}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(next) || next.length > 100) throw Error('Incomplete comment list');
    rows.push(...next);
    if (next.length < 100) return rows;
  }
  throw Error('Comment list exceeds bound');
}
async function checks(client, head) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const next = await client.request('GET', `/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(next?.total_count) || next.total_count < 0 || next.total_count > 2000
      || !Array.isArray(next.check_runs) || next.check_runs.length > 100) throw Error('Incomplete check list');
    rows.push(...next.check_runs);
    if (rows.length === next.total_count) return rows;
    if (next.check_runs.length < 100) throw Error('Incomplete check list');
  }
  throw Error('Check list exceeds bound');
}
function exact(rows, matches) {
  if (!Array.isArray(rows)) throw Error('External identity unavailable');
  const found = rows.filter(matches);
  if (found.length > 1 || found.some(row => !positive(row.id))) throw Error('Ambiguous external identity');
  return found[0]?.id ?? null;
}

/** Transport the package-owned terminal bytes; only the parent may authorize a destination/effect. */
export async function publishBoundaryResult(collected, projection, ports) {
  try {
    const result = collected?.result;
    if (collected?.status !== 'collected' || !result || bytes(result) > 64 * 1024
      || !ID.test(collected.activityId) || !positive(collected.activityGeneration)
      || result.activityId !== collected.activityId || result.activityGeneration !== collected.activityGeneration
      || !positive(result.generation) || !positive(result.repositoryId) || !positive(result.pullRequest)
      || !SHA.test(result.head) || !DIGEST.test(result.packageDigest)
      || !DIGEST.test(result.manifestDigest)
      || !['complete', 'incomplete'].includes(result.status) || !['stopped', 'unknown'].includes(result.cleanup)
      || !Array.isArray(result.originalReports) || result.originalReports.length > 3
      || !result.history || typeof result.history.clear !== 'boolean'
      || typeof result.history.coverageAdvanced !== 'boolean'
      || typeof result.presentation?.commentBody !== 'string'
      || typeof result.presentation.check?.name !== 'string'
      || typeof result.presentation.check?.summary !== 'string'
      || !['success', 'failure'].includes(result.presentation.check.conclusion)
      || (result.presentation.check.conclusion === 'success'
        && (result.status !== 'complete' || result.cleanup !== 'stopped'
          || !result.history.coverageAdvanced || !result.history.clear))
      || projection?.activityId !== result.activityId || projection.generation !== collected.activityGeneration
      || projection.repositoryId !== result.repositoryId || projection.pullRequest !== result.pullRequest
      || projection.head !== result.head || projection.packageDigest !== result.packageDigest
      || projection.resultDigest !== hash(result) || !positive(ports?.activityGeneration)
      || ports.activityGeneration !== collected.activityGeneration
      || typeof ports.ledger?.current !== 'function' || typeof ports.ledger?.effect !== 'function'
      || typeof ports.artifact?.upload !== 'function' || typeof ports.artifact?.list !== 'function'
      || typeof ports.artifact?.read !== 'function') return { status: 'denied' };
    const client = githubClient(ports.github);
    const identity = { activityId: result.activityId, generation: collected.activityGeneration,
      repositoryId: result.repositoryId, pullRequest: result.pullRequest, head: result.head };
    const frozen = await ports.ledger.current();
    if (!frozen || !SHA.test(frozen.base) || !SHA.test(frozen.mergeBase)
      || !Object.entries(identity).every(([key, value]) => frozen[key] === value)) return { status: 'stale' };
    const current = async () => {
      const observed = await ports.ledger.current();
      return !!observed && observed.base === frozen.base && observed.mergeBase === frozen.mergeBase
        && Object.entries(identity).every(([key, value]) => observed[key] === value);
    };
    if (ports.binding && (ports.binding.admission?.activityId !== result.activityId
      || ports.binding.admission?.generation !== result.generation
      || ports.binding.admission?.packageDigest !== result.packageDigest
      || ports.binding.context?.head !== result.head
      || ports.binding.context?.base !== frozen.base
      || ports.binding.context?.mergeBase !== frozen.mergeBase
      || ports.binding.activityGeneration !== collected.activityGeneration
      || !DIGEST.test(ports.binding.packetDigest))) return { status: 'denied' };
    const binding = { ...identity, base: frozen.base, mergeBase: frozen.mergeBase,
      packageDigest: result.packageDigest,
      ...(positive(ports.runId) && positive(ports.runAttempt)
        ? { runId: ports.runId, runAttempt: ports.runAttempt } : {}),
      ...(ports.binding ?? {}) };
    const digest = hash({ binding, result });
    const marker = `review-${result.repositoryId}-${result.pullRequest}-${result.activityId}-generation-${result.generation}:${digest}`;
    const artifact = { marker, digest, binding, result };
    const comment = { body: `<!-- codeflare-review:${marker} -->\n${result.presentation.commentBody}\n`
      + JSON.stringify({ head: result.head, artifactDigest: digest }) };
    if (Buffer.byteLength(comment.body) > 64 * 1024 || Buffer.byteLength(result.presentation.check.summary) > 64 * 1024) {
      return { status: 'denied' };
    }
    const check = { name: result.presentation.check.name, head_sha: result.head, external_id: marker,
      status: 'completed', conclusion: result.presentation.check.conclusion,
      output: { title: result.presentation.check.name, summary: result.presentation.check.summary } };
    const effect = async (name, expected, list, read, create, matches, verify) => {
      if (!await current()) return { status: 'stale' };
      const request = { operation: 'begin', effect: name, digest: hash(expected) };
      const begin = await ports.ledger.effect(request);
      if (!['new', 'pending', 'published'].includes(begin?.status)) return { status: 'unknown' };
      const find = async () => {
        const id = exact(await list(), matches);
        if (!id) return null;
        const row = await read(id);
        if (!row || row.id !== id || !verify(row)) throw Error('Exact-ID readback mismatch');
        return id;
      };
      let id = await find();
      if (begin.status === 'published') {
        return positive(begin.externalId) && begin.externalId === id ? { status: 'published', id } : { status: 'unknown' };
      }
      if (begin.status === 'pending' && !id) return { status: 'unknown' };
      if (begin.status === 'new' && !id) {
        if (!await current()) return { status: 'stale' };
        const created = await create();
        if (!positive(created?.id)) return { status: 'unknown' };
        id = await find();
        if (created.id !== id) return { status: 'unknown' };
      }
      const done = await ports.ledger.effect({ ...request, operation: 'complete', externalId: id });
      return done?.status === 'published' && done.externalId === id && await current()
        ? { status: 'published', id } : { status: 'unknown' };
    };
    const uploaded = await effect('artifact', artifact, () => ports.artifact.list(),
      id => ports.artifact.read(id), () => ports.artifact.upload(artifact),
      row => row?.name === `boundary-review-${digest}`,
      row => equal(row.body, artifact));
    if (uploaded.status !== 'published') return uploaded;
    const commented = await effect('comment', comment, () => comments(client, result.pullRequest),
      id => client.request('GET', `/issues/comments/${id}`),
      () => client.request('POST', `/issues/${result.pullRequest}/comments`, comment),
      row => typeof row?.body === 'string' && row.body.includes(`<!-- codeflare-review:${marker} -->`),
      row => row.user?.id === client.commentAuthorId && row.body === comment.body);
    if (commented.status !== 'published') return commented;
    const checked = await effect('check', check, () => checks(client, result.head),
      id => client.request('GET', `/check-runs/${id}`), () => client.request('POST', '/check-runs', check),
      row => row?.external_id === marker,
      row => row.app?.id === client.checkAppId && row.head_sha === check.head_sha
        && row.name === check.name && row.status === check.status && row.conclusion === check.conclusion
        && row.output?.title === check.output.title && row.output?.summary === check.output.summary);
    if (checked.status !== 'published') return checked;
    return { status: 'published', artifactId: uploaded.id, commentId: commented.id, checkId: checked.id };
  } catch { return { status: 'unknown' }; }
}

// The CLI is run only from the checked-out protected Codeflare base commit.
const required = name => {
  const value = process.env[name];
  if (!value) throw Error(`${name} unavailable`);
  return value;
};
const api = 'https://api.github.com';
async function runProtectedJob(phase) {
  const repository = required('GITHUB_REPOSITORY');
  const repositoryId = Number(required('GITHUB_REPOSITORY_ID'));
  const runId = Number(required('GITHUB_RUN_ID'));
  const runAttempt = Number(required('GITHUB_RUN_ATTEMPT'));
  const workflowSha = required('GITHUB_WORKFLOW_SHA');
  const codeflare = required('CODEFLARE_ORIGIN');
  const githubToken = required('GITHUB_TOKEN');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || ![repositoryId, runId, runAttempt].every(positive) || !SHA.test(workflowSha)
    || !origin(codeflare) || !githubToken || !['collect', 'publish'].includes(phase)) {
    throw Error('Protected Action identity unavailable');
  }
  const root = `${api}/repos/${repository}`;
  const github = async suffix => {
    if (typeof suffix !== 'string' || !suffix.startsWith('/') || suffix.includes('..')) throw Error('GitHub endpoint denied');
    const url = `${root}${suffix}`;
    const response = await fetch(new Request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28' } }));
    if (response.url && response.url !== url) throw Error('GitHub evidence origin moved');
    return boundedJson(response, 1024 * 1024);
  };
  const current = async (pullRequest, expectedBase) => {
    if (!positive(pullRequest)) return null;
    const pr = await github(`/pulls/${pullRequest}`);
    if (pr?.number !== pullRequest || pr.state !== 'open'
      || pr.head?.repo?.id !== repositoryId || pr.base?.repo?.id !== repositoryId
      || !SHA.test(pr.head.sha) || !SHA.test(pr.base.sha)
      || pr.base.ref !== expectedBase) return null;
    const [compare, pulls] = await Promise.all([
      github(`/compare/${pr.base.sha}...${pr.head.sha}`),
      github(`/commits/${pr.head.sha}/pulls?per_page=100`),
    ]);
    if (!Array.isArray(pulls) || pulls.length !== 1 || pulls[0]?.number !== pullRequest
      || pulls[0]?.state !== 'open' || pulls[0].head?.sha !== pr.head.sha
      || !SHA.test(compare?.merge_base_commit?.sha)) return null;
    return { repositoryId, pullRequest, head: pr.head.sha, base: pr.base.sha,
      mergeBase: compare.merge_base_commit.sha };
  };
  const oidc = async audience => {
    const url = new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
    url.searchParams.set('audience', audience);
    const response = await fetch(new Request(url, { redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}` } }));
    if (response.url && response.url !== url.toString()) throw Error('OIDC origin moved');
    const value = await boundedJson(response, 8192);
    if (typeof value?.value !== 'string' || value.value.length > 8192
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.value)) {
      throw Error('OIDC identity unavailable');
    }
    return value.value;
  };
  const post = async (endpoint, body) => {
    const url = `${codeflare}${endpoint}`;
    const token = await oidc(url);
    const response = await fetch(new Request(url, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) }));
    if (response.url && response.url !== url) throw Error('Claim origin moved');
    return boundedJson(response);
  };
  if (phase === 'collect') {
    const eventBytes = await readFile(required('GITHUB_EVENT_PATH'));
    if (eventBytes.length > 256 * 1024) throw Error('Protected event exceeds bound');
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(eventBytes));
    const pullRequest = event?.pull_request?.number;
    const baseRef = event?.pull_request?.base?.ref;
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request_target' || event?.repository?.id !== repositoryId
      || !positive(pullRequest) || !['main', 'master', 'develop'].includes(baseRef)) {
      throw Error('Protected PR event unavailable');
    }
    const revision = await current(pullRequest, baseRef);
    if (!revision || revision.head !== event.pull_request.head.sha
      || revision.base !== event.pull_request.base.sha) throw Error('Protected PR revision moved');
    const workflow = await github('/actions/workflows/boundary-reviews.yml');
    if (!positive(workflow?.id) || workflow?.state !== 'active') throw Error('Protected workflow unavailable');
    const claim = await post('/operator-webhook/v1/activities/claims/boundary', {
      ...revision, runId, runAttempt,
    });
    if (!claim || claim.status || claim.origin !== codeflare || claim.workflowId !== workflow.id
      || !ID.test(claim.activityId) || !CAPABILITY.test(claim.startCapability)
      || !positive(claim.generation) || !DIGEST.test(claim.contextDigest)
      || !['repositoryId', 'pullRequest', 'head', 'base', 'mergeBase', 'runId', 'runAttempt']
        .every(field => claim[field] === ({ ...revision, runId, runAttempt })[field])) {
      throw Error('Protected claim unavailable');
    }
    const observed = await current(pullRequest, baseRef);
    if (!observed || !equal(observed, revision)) throw Error('Protected PR changed after claim');
    const collected = await collectBoundaryResult(claim, { fetch });
    if (collected.status !== 'collected') throw Error(`Boundary collection ${collected.status}`);
    const output = required('REVIEW_TRANSFER_FILE');
    if (!path.isAbsolute(output)) throw Error('Collector transfer path unavailable');
    const { startCapability: _consumedStart, ...frozenClaim } = claim;
    const transfer = { claim: frozenClaim, activityGeneration: collected.activityGeneration,
      result: collected.result };
    if (bytes(transfer) > 72 * 1024) throw Error('Collector transfer exceeds bound');
    await writeFile(output, JSON.stringify(transfer), { flag: 'wx', mode: 0o600 });
    return;
  }
  const transferFile = required('REVIEW_TRANSFER_FILE');
  if (!path.isAbsolute(transferFile)) throw Error('Publisher transfer path unavailable');
  const transferBytes = await readFile(transferFile);
  if (transferBytes.length > 72 * 1024) throw Error('Publisher transfer exceeds bound');
  const transfer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(transferBytes));
  const claim = transfer?.claim;
  if (!claim || claim.repositoryId !== repositoryId || claim.runId !== runId || claim.runAttempt !== runAttempt
    || !positive(transfer.activityGeneration) || !DIGEST.test(claim.contextDigest)
    || !ID.test(claim.activityId) || ![claim.head, claim.base, claim.mergeBase].every(value => SHA.test(value))) {
    throw Error('Foreign collector transfer');
  }
  const expectedBase = process.env.GITHUB_BASE_REF;
  if (!['main', 'master', 'develop'].includes(expectedBase)) throw Error('Protected base unavailable');
  const resultDigest = hash(transfer.result);
  const identity = { repositoryId, pullRequest: claim.pullRequest, head: claim.head, base: claim.base,
    mergeBase: claim.mergeBase, workflowId: claim.workflowId, runId, runAttempt, activityId: claim.activityId,
    contextDigest: claim.contextDigest, sessionGeneration: claim.generation };
  const preparation = await post('/operator-webhook/v1/activities/claims/publication-preparation', {
    ...identity, activityGeneration: transfer.activityGeneration, resultDigest,
  });
  const owner = preparation?.projection;
  const admission = owner?.admission, context = owner?.context;
  if (preparation?.status !== 'ready' || owner?.resultDigest !== resultDigest
    || owner.activityGeneration !== transfer.activityGeneration
    || admission?.repositoryId !== repositoryId || admission.pullRequest !== claim.pullRequest
    || admission.activityId !== claim.activityId || admission.workflowId !== claim.workflowId
    || admission.runId !== runId || admission.runAttempt !== runAttempt
    || admission.packageDigest !== transfer.result?.packageDigest
    || admission.roundGeneration !== transfer.result?.generation
    || context?.head !== claim.head || context?.base !== claim.base
    || context?.mergeBase !== claim.mergeBase || !positive(admission.roundGeneration)
    || !DIGEST.test(owner.packetDigest)) {
    throw Error('Publisher owner projection unavailable');
  }
  const projection = { activityId: claim.activityId, generation: transfer.activityGeneration,
    repositoryId, pullRequest: claim.pullRequest, head: claim.head,
    packageDigest: admission.packageDigest, resultDigest };
  const ledger = {
    async current() {
      const observed = await current(claim.pullRequest, expectedBase);
      if (!observed || !equal(observed, { repositoryId, pullRequest: claim.pullRequest,
        head: claim.head, base: claim.base, mergeBase: claim.mergeBase })) return null;
      const verified = await post('/operator-webhook/v1/activities/claims/publication-preparation', {
        ...identity, activityGeneration: transfer.activityGeneration, resultDigest,
      });
      return verified?.status === 'ready' && verified.projection?.resultDigest === resultDigest
        ? { ...observed, activityId: claim.activityId, generation: transfer.activityGeneration } : null;
    },
    async effect(effect) {
      return post('/operator-webhook/v1/activities/claims/publication', {
        ...identity, activityGeneration: transfer.activityGeneration, ...effect,
      });
    },
  };
  const artifactClient = await import('@actions/artifact');
  const tempRoot = required('RUNNER_TEMP');
  if (!path.isAbsolute(tempRoot)) throw Error('Runner temporary directory unavailable');
  const artifact = {
    async upload(value) {
      if (value?.digest !== hash({ binding: value?.binding, result: value?.result })
        || bytes(value) > 72 * 1024) throw Error('Artifact content unavailable');
      const dir = await mkdtemp(path.join(tempRoot, 'boundary-upload-'));
      try {
        const file = path.join(dir, 'review.json');
        await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        const uploaded = await artifactClient.uploadArtifact(`boundary-review-${value.digest}`, [file], dir,
          { retentionDays: 90 });
        if (!positive(uploaded?.id)) throw Error('Artifact ID unavailable');
        return { id: uploaded.id };
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
    async list() {
      const rows = [];
      for (let page = 1; page <= 20; page++) {
        const data = await github(`/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
        if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > 2000
          || !Array.isArray(data.artifacts) || data.artifacts.length > 100) throw Error('Artifact listing incomplete');
        rows.push(...data.artifacts);
        if (rows.length === data.total_count) break;
        if (data.artifacts.length < 100 || page === 20) throw Error('Artifact listing incomplete');
      }
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('Ambiguous artifact listing');
      return rows.filter(row => /^boundary-review-[a-f0-9]{64}$/.test(row.name ?? ''))
        .map(row => ({ id: row.id, name: row.name }));
    },
    async read(id) {
      if (!positive(id)) throw Error('Invalid artifact ID');
      const metadata = await github(`/actions/artifacts/${id}`);
      if (metadata?.id !== id || metadata.expired !== false
        || metadata.workflow_run?.id !== runId || metadata.workflow_run?.repository_id !== repositoryId
        || metadata.workflow_run?.head_sha !== workflowSha
        || !/^boundary-review-[a-f0-9]{64}$/.test(metadata.name ?? '')) throw Error('Foreign artifact');
      const dir = await mkdtemp(path.join(tempRoot, 'boundary-download-'));
      try {
        const downloaded = await artifactClient.downloadArtifact(id, { path: dir });
        if (downloaded?.downloadPath !== dir || !equal(await readdir(dir), ['review.json'])) {
          throw Error('Artifact extraction unavailable');
        }
        const file = path.join(dir, 'review.json');
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size < 1 || stat.size > 72 * 1024) throw Error('Artifact content bound');
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)));
        if (metadata.name !== `boundary-review-${body?.digest}`
          || body.digest !== hash({ binding: body.binding, result: body.result })
          || body.binding?.repositoryId !== repositoryId || body.binding?.runId !== runId
          || body.binding?.runAttempt !== runAttempt) throw Error('Artifact binding mismatch');
        return { id, body };
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
  };
  const published = await publishBoundaryResult({ status: 'collected', activityId: claim.activityId,
    activityGeneration: transfer.activityGeneration, result: transfer.result }, projection,
  { activityGeneration: transfer.activityGeneration, runId, runAttempt, ledger, artifact,
    binding: { admission: { ...admission, generation: admission.roundGeneration },
      context, packetDigest: owner.packetDigest, activityGeneration: transfer.activityGeneration },
    github: { origin: api, repository, token: githubToken, fetch,
      commentAuthorId: Number(required('REVIEW_COMMENT_AUTHOR_ID')),
      checkAppId: Number(required('REVIEW_CHECK_APP_ID')) } });
  if (published.status !== 'published') throw Error(`Boundary publication ${published.status}`);
  console.log(`Published shadow receipt: artifact ${published.artifactId}, comment ${published.commentId}, check ${published.checkId}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProtectedJob(process.argv[2]);
}
