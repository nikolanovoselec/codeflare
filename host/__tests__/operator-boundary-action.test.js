import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBoundaryResult, publishBoundaryResult } from '../../scripts/operator-boundary-action.mjs';

const activityId = 'activity-one';
const startCapability = 's'.repeat(43);
const readCapability = 'r'.repeat(43);
const handoff = { origin: 'https://enterprise.example', activityId, startCapability };
const result = { schemaVersion: 1, activityId, activityGeneration: 1, generation: 1, repositoryId: 138,
  pullRequest: 34, head: 'a'.repeat(40), packageDigest: 'b'.repeat(64), status: 'complete',
  cleanup: 'stopped', manifestDigest: 'c'.repeat(64), originalReports: [],
  history: { sourceDigest: 'd'.repeat(64), coverageAdvanced: true, clear: true,
    findings: [], rebuttals: [] }, presentation: { commentBody: 'Review complete',
    check: { name: 'Boundary Reviews (shadow)', conclusion: 'success', summary: 'Complete' } } };

function endpoint(request) { return new URL(request.url).pathname.split('/').at(-1); }

test('REQ-OPERATOR-053: lost result delivery rereads the identical terminal bytes without another start', async () => {
  const actions = [];
  let lost = true;
  const fetch = async request => {
    const action = endpoint(request);
    actions.push({ action, authorization: request.headers.get('authorization') });
    if (action === 'start') return Response.json({ ok: true, phase: 'queued', readCapability });
    if (action === 'status') return Response.json({ ok: true, terminal: true, status: 'completed', generation: 1 });
    if (action === 'result' && lost) { lost = false; throw Error('Response lost after terminal commit'); }
    if (action === 'result') return Response.json({ ok: true, terminal: true, status: 'completed', generation: 1, result });
    throw Error('Unexpected request');
  };
  const receipt = await collectBoundaryResult(handoff, { fetch, wait: async () => {}, now: () => 0 });
  assert.deepEqual(receipt, { status: 'collected', activityId, activityGeneration: 1, result });
  assert.deepEqual(actions.map(({ action }) => action), ['start', 'status', 'result', 'result']);
  assert.deepEqual(actions.map(({ authorization }) => authorization), [
    `Bearer ${startCapability}`, `Bearer ${readCapability}`, `Bearer ${readCapability}`, `Bearer ${readCapability}`,
  ]);
  assert.equal(JSON.stringify(receipt).includes(startCapability), false);
  assert.equal(JSON.stringify(receipt).includes(readCapability), false);
});

test('REQ-OPERATOR-054: uncertain start response never reclaims or starts another operator', async () => {
  const actions = [];
  const receipt = await collectBoundaryResult(handoff, { fetch: async request => {
    actions.push(endpoint(request)); throw Error('Accepted start response lost');
  }, wait: async () => {}, now: () => 0 });
  assert.deepEqual(receipt, { status: 'unknown' });
  assert.deepEqual(actions, ['start']);
});

async function publicationFixture() {
  const collected = { status: 'collected', activityId, activityGeneration: 1, result };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result)));
  const projection = { activityId, generation: 1, repositoryId: 138, pullRequest: 34,
    head: result.head, packageDigest: result.packageDigest, resultDigest: Buffer.from(digest).toString('hex') };
  const effects = new Map();
  const artifactRows = new Map();
  const comments = new Map();
  const checks = new Map();
  let loseArtifactResponse = false, loseCommentResponse = false;
  let observedHead = result.head;
  let nextArtifactId = 99, nextCommentId = 100, nextCheckId = 101;
  const ports = {
    activityGeneration: 1,
    ledger: {
      current: async () => ({ activityId, generation: 1, repositoryId: 138, pullRequest: 34,
        head: observedHead, base: 'e'.repeat(40), mergeBase: 'f'.repeat(40) }),
      effect: async ({ operation, effect, digest: contentDigest, externalId }) => {
        const saved = effects.get(effect);
        if (saved && saved.digest !== contentDigest) return { status: 'conflict' };
        if (operation === 'begin') {
          if (saved?.externalId) return { status: 'published', externalId: saved.externalId };
          if (saved) return { status: 'pending' };
          effects.set(effect, { digest: contentDigest });
          return { status: 'new' };
        }
        if (operation === 'complete' && saved) {
          effects.set(effect, { digest: contentDigest, externalId });
          return { status: 'published', externalId };
        }
        return saved?.externalId ? { status: 'published', externalId: saved.externalId } : { status: 'pending' };
      },
    },
    artifact: {
      upload: async value => {
        const id = ++nextArtifactId;
        artifactRows.set(id, { id, name: `boundary-review-${value.digest}`, body: value });
        if (loseArtifactResponse) { loseArtifactResponse = false; throw Error('Lost artifact acknowledgement'); }
        return { id };
      },
      list: async () => [...artifactRows.values()].map(({ id, name }) => ({ id, name })),
      read: async id => artifactRows.get(id) ?? null,
    },
    github: { origin: 'https://api.github.com', repository: 'owner/repo', token: 'publisher-only',
      commentAuthorId: 777, checkAppId: 888, fetch: async request => {
        const url = new URL(request.url);
        if (request.headers.get('authorization') !== 'Bearer publisher-only') return Response.json({}, { status: 403 });
        if (request.method === 'GET' && url.pathname.endsWith('/issues/34/comments'))
          return Response.json([...comments.values()]);
        if (request.method === 'GET' && url.pathname.endsWith(`/commits/${result.head}/check-runs`))
          return Response.json({ total_count: checks.size, check_runs: [...checks.values()] });
        if (request.method === 'GET' && /\/issues\/comments\/\d+$/.test(url.pathname))
          return Response.json(comments.get(Number(url.pathname.split('/').at(-1))));
        if (request.method === 'GET' && /\/check-runs\/\d+$/.test(url.pathname))
          return Response.json(checks.get(Number(url.pathname.split('/').at(-1))));
        if (request.method === 'POST' && url.pathname.endsWith('/issues/34/comments')) {
          const body = await request.json(); const row = { id: ++nextCommentId, user: { id: 777 }, ...body };
          comments.set(row.id, row);
          if (loseCommentResponse) { loseCommentResponse = false; throw Error('Lost comment acknowledgement'); }
          return Response.json(row);
        }
        if (request.method === 'POST' && url.pathname.endsWith('/check-runs')) {
          const body = await request.json(); const row = { id: ++nextCheckId, app: { id: 888 }, ...body };
          checks.set(row.id, row); return Response.json(row);
        }
        return Response.json({}, { status: 404 });
      } },
  };
  return { collected, projection, ports, artifactRows, comments, checks,
    loseArtifactResponse: () => { loseArtifactResponse = true; },
    loseCommentResponse: () => { loseCommentResponse = true; },
    advanceHead: head => { observedHead = head; } };
}

test('REQ-OPERATOR-056: exact projection and journal allow one authenticated artifact, comment and shadow check', async () => {
  const f = await publicationFixture();
  assert.deepEqual(await publishBoundaryResult(f.collected, f.projection, f.ports),
    { status: 'published', artifactId: 100, commentId: 101, checkId: 102 });
  const artifact = f.artifactRows.get(100).body;
  assert.equal(JSON.stringify(artifact).includes(JSON.stringify(result)), true);
  assert.equal(artifact.digest, Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify({ binding: artifact.binding, result: artifact.result })))).toString('hex'));
  const commentBody = f.comments.get(101).body;
  const marker = `review-138-34-${activityId}-generation-1:${artifact.digest}`;
  assert.equal(commentBody.includes('Review complete'), true);
  assert.equal(commentBody.includes(`<!-- codeflare-review:${marker} -->`), true);
  assert.deepEqual(JSON.parse(commentBody.slice(commentBody.lastIndexOf('\n') + 1)),
    { head: result.head, artifactDigest: artifact.digest });
  assert.equal(f.checks.get(102).conclusion, 'success');
  assert.equal(f.checks.get(102).head_sha, result.head);
  assert.equal(f.checks.get(102).external_id, marker);
  assert.equal(f.checks.get(102).app.id, 888);
  assert.deepEqual(await publishBoundaryResult(f.collected, f.projection, f.ports),
    { status: 'published', artifactId: 100, commentId: 101, checkId: 102 });
  assert.equal(f.artifactRows.size, 1);
  assert.equal(f.comments.size, 1);
  assert.equal(f.checks.size, 1);
  assert.deepEqual(await publishBoundaryResult(f.collected, { ...f.projection, head: 'f'.repeat(40) }, f.ports),
    { status: 'denied' });
});

test('REQ-OPERATOR-056: a completed review with unresolved findings publishes only a failing check', async () => {
  const f = await publicationFixture();
  const finding = { id: 'unresolved', lane: 'code-reviewer', message: 'Still open' };
  f.collected.result = { ...result, originalReports: [{ lane: 'code-reviewer', findings: [finding] }],
    history: { ...result.history, clear: false, findings: [finding] },
    presentation: { ...result.presentation, commentBody: 'Review findings: 1 unresolved',
      check: { ...result.presentation.check, conclusion: 'failure' } } };
  f.projection.resultDigest = Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(f.collected.result)))).toString('hex');
  assert.equal((await publishBoundaryResult(f.collected, f.projection, f.ports)).status, 'published');
  assert.equal(f.checks.get(102).conclusion, 'failure');
  const artifact = f.artifactRows.get(100).body;
  assert.deepEqual(artifact.result.originalReports[0].findings, [finding]);
  const comment = f.comments.get(101).body;
  assert.equal(comment.includes('Review findings: 1 unresolved'), true);
  assert.deepEqual(JSON.parse(comment.slice(comment.lastIndexOf('\n') + 1)),
    { head: result.head, artifactDigest: artifact.digest });
});

test('REQ-OPERATOR-055/056: lost comment response reconciles the exact actor and ID without duplicate publication', async () => {
  const f = await publicationFixture(); f.loseCommentResponse();
  assert.notEqual((await publishBoundaryResult(f.collected, f.projection, f.ports)).status, 'published');
  assert.deepEqual(await publishBoundaryResult(f.collected, f.projection, f.ports),
    { status: 'published', artifactId: 100, commentId: 101, checkId: 102 });
  assert.equal(f.comments.size, 1);
  assert.equal(f.checks.size, 1);
});

test('REQ-OPERATOR-056: a changed PR revision after comment publication fences the old shadow check', async () => {
  const f = await publicationFixture();
  const send = f.ports.github.fetch;
  f.ports.github.fetch = async request => {
    const response = await send(request);
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/issues/34/comments')) {
      f.advanceHead('d'.repeat(40));
    }
    return response;
  };
  assert.notEqual((await publishBoundaryResult(f.collected, f.projection, f.ports)).status, 'published');
  assert.equal(f.artifactRows.size, 1);
  assert.equal(f.comments.size, 1);
  assert.equal(f.checks.size, 0);
});

test('REQ-OPERATOR-055/056: lost artifact response recovers exact ID but altered readback cannot publish', async () => {
  const f = await publicationFixture(); f.loseArtifactResponse();
  assert.notEqual((await publishBoundaryResult(f.collected, f.projection, f.ports)).status, 'published');
  assert.deepEqual(await publishBoundaryResult(f.collected, f.projection, f.ports),
    { status: 'published', artifactId: 100, commentId: 101, checkId: 102 });
  const changed = await publicationFixture(); changed.loseArtifactResponse();
  await publishBoundaryResult(changed.collected, changed.projection, changed.ports);
  changed.artifactRows.get(100).body = { ...changed.artifactRows.get(100).body, digest: '0'.repeat(64) };
  assert.notEqual((await publishBoundaryResult(changed.collected, changed.projection, changed.ports)).status, 'published');
  const foreign = await publicationFixture(); foreign.loseArtifactResponse();
  await publishBoundaryResult(foreign.collected, foreign.projection, foreign.ports);
  foreign.artifactRows.set(201, { ...foreign.artifactRows.get(100), id: 201 });
  assert.notEqual((await publishBoundaryResult(foreign.collected, foreign.projection, foreign.ports)).status,
    'published');
  const author = await publicationFixture();
  await publishBoundaryResult(author.collected, author.projection, author.ports);
  author.comments.get(101).user.id = 999;
  assert.notEqual((await publishBoundaryResult(author.collected, author.projection, author.ports)).status,
    'published');
});
