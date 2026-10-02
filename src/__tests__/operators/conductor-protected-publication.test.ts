/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** Q22: unchanged c40527ee package producer -> real protected Action collection/publication.
 * Parent capability, webhook, ledger and GitHub/artifact I/O are external fixtures;
 * no producer policy, history reconciliation, presentation or publisher validation is mocked. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOperatorBundle } from '../../operators/distribution';
import { collectBoundaryResult, publishBoundaryResult } from '../../../scripts/operator-boundary-action.mjs';
import provenance from './fixtures/conductor-review.provenance.json';
// @ts-expect-error Workers test loader supports immutable raw artifact fixtures.
import bundleJson from './fixtures/conductor-review.generated.json?raw';
// @ts-expect-error Workers test loader supports raw wrapper modules.
import producerFixture from './fixtures/conductor-publication-producer.js?raw';

beforeEach(() => vi.stubGlobal('Buffer', Buffer));
afterEach(() => vi.unstubAllGlobals());

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finding = { id: 'code-reviewer-guard', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Authorization check missing', evidence: 'A caller reaches the write before the guard.' };
type Mode = 'clean' | 'red' | 'missing-report' | 'incomplete-report' | 'omitted-evidence' | 'unavailable-history';
type Published = { artifact?: any; comment?: any; check?: any };
async function produce(mode: Mode, previous?: Published, round = 2) {
  // Generated-artifact identity contract: digest validation precedes executing any bytes.
  // This is the existing canonical compiler artifact, not a reconstruction or a package checkout import.
  expect(provenance.sourceCommit).toBe('c40527ee21664012d326d73efcfd26889302deff');
  const bundle = await parseOperatorBundle(new TextEncoder().encode(bundleJson), provenance.bundleDigest);
  const loader = (env as unknown as { LOADER: { load(code: unknown): { getEntrypoint(): Fetcher } } }).LOADER;
  const producer = loader.load({ compatibilityDate: bundle.compatibilityDate, compatibilityFlags: bundle.compatibilityFlags,
    mainModule: 'producer-fixture.js', modules: { ...bundle.modules, 'producer-fixture.js': { js: producerFixture } },
    env: {}, globalOutbound: null }).getEntrypoint();
  const response = await producer.fetch(new Request('https://producer.internal/', { method: 'POST',
    body: JSON.stringify({ mode, previous, round }) }));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

async function transport(produced: any) {
  const result = produced.update.result, activityGeneration = result.activityGeneration;
  // Only real producer terminal bytes enter the protected transport. No contradictory
  // zero-report "complete/clear/success" result is fabricated for this suite.
  const collected = await collectBoundaryResult({ origin: 'https://enterprise.example.test',
    activityId: result.activityId, startCapability: 's'.repeat(43) }, {
    fetch: async (request: Request) => {
      const operation = new URL(request.url).pathname.split('/').at(-1);
      if (operation === 'start') {
        expect(request.headers.get('authorization')).toBe(`Bearer ${'s'.repeat(43)}`);
        return Response.json({ ok: true, phase: 'queued', readCapability: 'r'.repeat(43) });
      }
      expect(request.headers.get('authorization')).toBe(`Bearer ${'r'.repeat(43)}`);
      if (operation === 'status') return Response.json({ ok: true, terminal: true,
        status: produced.update.status, generation: activityGeneration });
      if (operation === 'result') return Response.json({ ok: true, terminal: true,
        status: produced.update.status, generation: activityGeneration, result });
      throw Error('Unexpected protected webhook operation');
    }, now: () => 0,
  });
  expect(collected).toMatchObject({ status: 'collected', activityId: result.activityId, activityGeneration, result });
  if (collected.status !== 'collected') throw Error('Producer terminal bytes were not collected');
  const rows: { artifacts: any[]; comments: any[]; checks: any[] } = { artifacts: [], comments: [], checks: [] };
  const published: Published = {};
  const journal = new Map<string, any>();
  const { commentAuthorId: _commentAuthorId, checkAppId: _checkAppId, ...admission } = produced.boundary;
  const binding = { admission: { repositoryId: 138, pullRequest: 34, ...admission, acknowledgedHead: null },
    context: { ...produced.context, headPullRequests: [34], mergeQueue: false },
    packetDigest: produced.packetDigest, activityGeneration, runId: admission.runId, runAttempt: admission.runAttempt };
  const outcome = await publishBoundaryResult(collected, { activityId: result.activityId, generation: activityGeneration,
    repositoryId: result.repositoryId, pullRequest: result.pullRequest, head: result.head,
    packageDigest: result.packageDigest, resultDigest: hash(result) }, {
    activityGeneration, binding, runId: admission.runId, runAttempt: admission.runAttempt,
    ledger: {
      current: async () => ({ activityId: result.activityId, generation: activityGeneration,
        repositoryId: result.repositoryId, pullRequest: result.pullRequest, ...produced.context }),
      effect: async (request: any) => {
        const key = `${request.effect}:${request.digest}`;
        if (request.operation === 'begin') {
          if (journal.has(key)) return journal.get(key);
          journal.set(key, { status: 'pending' }); return { status: 'new' };
        }
        const receipt = { status: 'published', externalId: request.externalId };
        journal.set(key, receipt); return receipt;
      },
    },
    artifact: {
      list: async () => rows.artifacts,
      read: async (id: number) => rows.artifacts.find(row => row.id === id),
      upload: async (body: any) => {
        const row = { id: 701, name: `boundary-review-${body.digest}`, body };
        published.artifact = row; rows.artifacts.push(row); return row;
      },
    },
    github: { origin: 'https://api.github.com', repository: 'owner/repo', token: 'independent-protected-github-token',
      commentAuthorId: 777, checkAppId: 888,
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        expect(url.origin).toBe('https://api.github.com');
        expect(request.headers.get('authorization')).toBe('Bearer independent-protected-github-token');
        expect(request.headers.has('cookie')).toBe(false);
        expect(request.headers.has('cf-access-jwt-assertion')).toBe(false);
        if (request.method === 'POST') {
          const body = await request.json() as any;
          if (url.pathname.endsWith('/comments')) {
            const row = { id: 501, user: { id: 777 }, issue_url: 'https://api.github.com/repos/owner/repo/issues/34', ...body };
            published.comment = row; rows.comments.push(row); return Response.json(row);
          }
          if (url.pathname.endsWith('/check-runs')) {
            const row = { id: 601, app: { id: 888 }, ...body };
            published.check = row; rows.checks.push(row); return Response.json(row);
          }
          throw Error('Unexpected external mutation');
        }
        if (url.pathname.endsWith('/comments')) return Response.json(rows.comments);
        if (url.pathname.endsWith('/check-runs')) return Response.json({ total_count: rows.checks.length, check_runs: rows.checks });
        const row = [...rows.comments, ...rows.checks].find(row => url.pathname.endsWith(`/${row.id}`));
        return row ? Response.json(row) : new Response(null, { status: 404 });
      },
    },
  });
  expect(JSON.stringify(published)).not.toContain('independent-protected-github-token');
  expect(JSON.stringify(collected)).not.toContain('independent-protected-github-token');
  return { outcome, published, rows };
}

describe('REQ-OPERATOR-056 AC3/4/6 / Q22: immutable producer-to-protected-publication adversarial seam', () => {
  it('publishes green only for complete three-lane producer evidence and authenticated clear history', async () => {
    const produced = await produce('clean');
    expect(produced.update).toMatchObject({ status: 'completed', result: { status: 'complete', cleanup: 'stopped',
      history: { clear: true, coverageAdvanced: true, findings: [] }, presentation: { check: { conclusion: 'success' } } } });
    expect(produced.update.result.originalReports.map((report: any) => report.lane)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    const { outcome, published } = await transport(produced);
    expect(outcome).toMatchObject({ status: 'published' });
    expect(published.check).toMatchObject({ head_sha: produced.context.head, conclusion: 'success' });
    expect(published.artifact.body.result).toEqual(produced.update.result);
  });
  it('publishes failure for real current findings even though all reports are complete', async () => {
    const produced = await produce('red', undefined, 1);
    expect(produced.update).toMatchObject({ status: 'completed', result: { status: 'complete',
      history: { clear: false, coverageAdvanced: true, findings: [{ ...finding, lane: 'code-reviewer' }] },
      presentation: { check: { conclusion: 'failure' } } } });
    const { outcome, published } = await transport(produced);
    expect(outcome).toMatchObject({ status: 'published' });
    expect(published.check).toMatchObject({ head_sha: produced.context.head, conclusion: 'failure' });
    expect(published.artifact.body.result.originalReports[0].findings).toEqual([finding]);
  });
  it('retains an actually produced and published prior red finding when the next complete reports are empty', async () => {
    const prior = await transport(await produce('red', undefined, 1));
    expect(prior.outcome).toMatchObject({ status: 'published' });
    const produced = await produce('clean', prior.published, 2);
    expect(produced.update.result.originalReports.every((report: any) => report.findings.length === 0)).toBe(true);
    expect(produced.update).toMatchObject({ status: 'completed', result: { status: 'complete', history: {
      clear: false, coverageAdvanced: true, findings: [{ ...finding, lane: 'code-reviewer' }] },
      presentation: { check: { conclusion: 'failure' } } } });
    const { outcome, published } = await transport(produced);
    expect(outcome).toMatchObject({ status: 'published' });
    expect(published.check).toMatchObject({ head_sha: produced.context.head, conclusion: 'failure' });
    expect(published.artifact.body.result.history.findings).toEqual([{ ...finding, lane: 'code-reviewer' }]);
  });
  it.each(['missing-report', 'incomplete-report', 'omitted-evidence'] as const)(
    'rejects %s at the actual producer and cannot publish a green projection', async mode => {
      const produced = await produce(mode);
      expect(produced.update).toMatchObject({ status: 'failed', result: { status: 'incomplete',
        code: 'CONDUCTOR_REVIEW_FAILED', cleanup: 'stopped', history: { clear: false, coverageAdvanced: false },
        presentation: { check: { conclusion: 'failure' } } } });
      // The first two reports really passed the producer; the bad third lane cannot advance coverage.
      expect(produced.update.result.originalReports.map((report: any) => report.lane)).toEqual(['code-reviewer', 'spec-reviewer']);
      const { outcome, rows } = await transport(produced);
      expect(outcome).toEqual({ status: 'denied' });
      expect(rows).toEqual({ artifacts: [], comments: [], checks: [] });
    },
  );
  it('publishes only failure when all three reports are complete but authenticated history is unavailable', async () => {
    const produced = await produce('unavailable-history');
    expect(produced.update).toMatchObject({ status: 'failed', result: { status: 'incomplete', cleanup: 'stopped',
      history: { clear: false, coverageAdvanced: false }, presentation: { check: { conclusion: 'failure' } } } });
    expect(produced.update.result.originalReports).toHaveLength(3);
    const { outcome, published } = await transport(produced);
    expect(outcome).toMatchObject({ status: 'published' });
    expect(published.check).toMatchObject({ head_sha: produced.context.head, conclusion: 'failure' });
    expect(published.artifact.body.result).toEqual(produced.update.result);
  });
});
