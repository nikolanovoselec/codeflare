import { describe, expect, it } from 'vitest';
import { prepareReview, reviewDigest, REVIEW_LANES, REVIEW_PACKET_SCRIPT } from '../../operators/review-packet';
import { collectReviewReports } from '../../operators/review-results';
import { reconcileReviewHistory } from '../../operators/review-history';
import { publishReview } from '../../operators/review-publication';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const admission = { repositoryId: 12, pullRequest: 34, activityId: 'activity-one', generation: 2,
  inputDigest: '1'.repeat(64), packageDigest: '2'.repeat(64), resourceDigest: '', policyDigest: '4'.repeat(64),
  workflowId: 5, runId: 6, runAttempt: 1 };
const context = { repositoryId: 12, pullRequest: 34, head: 'a'.repeat(40), base: 'b'.repeat(40),
  mergeBase: 'c'.repeat(40), headPullRequests: [34], mergeQueue: false };
async function fixture() {
  const resources = await Promise.all(['parent', ...REVIEW_LANES].map(async role => {
    const bytes = new TextEncoder().encode(`approved ${role} instructions`);
    return { role, path: `review/${role}.md`, digest: await reviewDigest(bytes), bytes };
  }));
  const resourceDigest = await reviewDigest(encode(resources.map(({ bytes: _, ...r }) => r)));
  const trusted = { authorize: async () => {}, readContext: async () => context,
    readApprovedResources: async () => resources,
    runCanonicalPacket: async (input: { lane: string; args: readonly string[]; script: string; maxBytes: number }) => {
      // Canonical CLI wire contract: a missing evidence flag must not produce usable evidence.
      expect(REVIEW_PACKET_SCRIPT).toBe('preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs');
      if (input.script !== REVIEW_PACKET_SCRIPT || JSON.stringify(input.args) !== JSON.stringify(['--scope', 'diff', '--range', `${context.mergeBase}..${context.head}`,
          '--lane', input.lane, '--with-evidence'])) throw Error('canonical CLI wire contract required');
      return encode({ scope: 'diff', workSet: 'changed-hunks-and-direct-invalidations', lane: input.lane,
        range: `${context.mergeBase}..${context.head}`, files: ['src/a.ts'], changedInputs: [], patch: '+change',
        evidence: { lane: input.lane, adrs: [], config: 'transition: false',
          anchors: { checked: 1, unresolved: [] }, callSites: [], anchorsCitingChanged: [],
          indexIntegrity: { unindexed: [], dangling: [] }, dependencyGraph: { reqs: 1, edges: 0, cycles: [] },
          references: { checked: 1, unresolved: [] }, docsCitingChanged: [] } });
    } };
  return { admitted: { ...admission, resourceDigest }, trusted, resources };
}
async function preparedFixture() { const f = await fixture(); return { ...f, prepared: await prepareReview(f.admitted, f.trusted) }; }
const finding = { id: 'finding-one', lane: 'code-reviewer', severity: 'HIGH', path: 'src/a.ts', line: 1,
  evidence: 'authorization bypass in added route', message: 'Missing owner check' };

describe('REQ-OPERATOR-050: trusted canonical preparation', () => {
  it('derives revision and all lane packets from trusted GitHub reads and approved bytes', async () => {
    const { prepared } = await preparedFixture();
    expect(prepared.context).toEqual(context);
    expect(prepared.packets.map(p => p.lane)).toEqual(REVIEW_LANES);
    expect(prepared.evidenceComplete).toBe(true);
    expect(prepared.resources.map(r => r.role)).toEqual(['parent', ...REVIEW_LANES]);
  });
  it('admits canonical policy attachments larger than a Pi prompt without expanding the 8 MiB aggregate bound', async () => {
    const { admitted, trusted, resources } = await fixture();
    resources[2].bytes = new TextEncoder().encode('approved policy\n'.repeat(7000));
    resources[2].digest = await reviewDigest(resources[2].bytes);
    admitted.resourceDigest = await reviewDigest(encode(resources.map(({ bytes: _, ...r }) => r)));
    expect((await prepareReview(admitted, trusted)).resources[2].bytes.length).toBeGreaterThan(65536);
  });
  it('rejects caller revision/packet labels and unapproved child resources', async () => {
    const { admitted, trusted, resources } = await fixture();
    await expect(prepareReview({ ...admitted, head: context.head } as never, trusted)).rejects.toThrow();
    await expect(prepareReview(admitted, { ...trusted, readApprovedResources: async () => resources.slice(0, 2) })).rejects.toThrow();
    await expect(prepareReview(admitted, { ...trusted, readApprovedResources: async () => resources.map(r => ({ ...r, bytes: encode('substitution') })) })).rejects.toThrow();
  });
  it('preserves omitted/truncated evidence as incomplete and bounds aggregate attachments', async () => {
    const { admitted, trusted } = await fixture();
    const original = trusted.runCanonicalPacket;
    const incomplete = await prepareReview(admitted, { ...trusted, runCanonicalPacket: async input => {
      const packet = JSON.parse(new TextDecoder().decode(await original(input)));
      packet.evidence = { truncated: true }; packet.evidenceOmitted = 'resolver failed'; return encode(packet);
    } });
    expect(incomplete.evidenceComplete).toBe(false);
    expect(new TextDecoder().decode(incomplete.packets[0].bytes)).toContain('resolver failed');
    await expect(prepareReview(admitted, { ...trusted, runCanonicalPacket: async () => new Uint8Array(8 * 1024 * 1024 + 1) })).rejects.toThrow();
  });
  it('never treats an evidence resolver error, missing required fields or unknown resolution as complete', async () => {
    const { admitted, trusted } = await fixture();
    for (const evidence of [{ error: 'resolver failed' }, { lane: 'code-reviewer' },
      { lane: 'code-reviewer', callSites: null, anchorsCitingChanged: [] }]) {
      const prepared = await prepareReview(admitted, { ...trusted, runCanonicalPacket: async input => {
        const packet = JSON.parse(new TextDecoder().decode(await trusted.runCanonicalPacket(input)));
        return encode({ ...packet, evidence });
      } });
      expect(prepared.evidenceComplete).toBe(false);
    }
  });
  it('rejects shared-head, merge-queue, wrong repository and moved revision preparation', async () => {
    const { admitted, trusted } = await fixture();
    for (const changed of [{ headPullRequests: [34, 35] }, { mergeQueue: true }, { repositoryId: 99 }]) {
      await expect(prepareReview(admitted, { ...trusted, readContext: async () => ({ ...context, ...changed }) })).rejects.toThrow();
    }
    let reads = 0;
    await expect(prepareReview(admitted, { ...trusted, readContext: async () => ({ ...context, head: ++reads === 1 ? context.head : 'f'.repeat(40) }) })).rejects.toThrow();
  });
});

async function resultFixture(options: { missing?: boolean; tamper?: boolean; cleanup?: boolean; duplicate?: boolean } = {}) {
  const { prepared } = await preparedFixture();
  const objects = new Map<string, Uint8Array>();
  const files = [];
  for (const lane of REVIEW_LANES) {
    if (options.missing && lane === 'doc-updater') continue;
    const bytes = encode({ schemaVersion: 1, lane, packetDigest: prepared.packetDigest, head: context.head,
      generation: 2, complete: true, omissions: [], findings: options.duplicate ? [{ id: 'duplicate', severity: 'HIGH',
        path: 'src/a.ts', line: 1, evidence: 'evidence', message: 'finding' }] : [] });
    const path = `reports/${lane}.json`;
    files.push({ path, size: bytes.length, sha256: await reviewDigest(bytes) });
    objects.set(`output/${path}`, bytes);
  }
  const manifest = encode({ schemaVersion: 1, activityId: admission.activityId, sessionId: 'owned-session', operationId: 'sync-one',
    requestDigest: admission.inputDigest, policyDigest: admission.policyDigest, files });
  objects.set('private/manifest.json', manifest);
  if (options.tamper) objects.set('output/reports/code-reviewer.json', encode({ fake: true }));
  const expected = { activityId: admission.activityId, sessionId: 'owned-session', operationId: 'sync-one',
    requestDigest: admission.inputDigest, policyDigest: admission.policyDigest, manifestDigest: await reviewDigest(manifest),
    prefix: 'private/', filePrefix: 'output/', deadline: Date.now() + 60000 };
  let cleanup = 'not-attempted';
  const result = await collectReviewReports(prepared, {
    authorize: async () => {}, syncAndSeal: async () => expected,
    read: async (key: string, maxBytes: number) => { const value = objects.get(key) ?? null; if (value && value.length > maxBytes) throw Error('bound'); return value; },
    stopOwnedSession: async () => { cleanup = options.cleanup ? 'unknown' : 'stopped'; if (options.cleanup) throw Error('lost stop'); return 'stopped' as const; },
  });
  return { result, cleanup, prepared };
}

describe('REQ-OPERATOR-050: independent persistence and cleanup', () => {
  it('requires independently verified bytes for every lane', async () => {
    expect((await resultFixture()).result).toMatchObject({ status: 'complete', cleanup: 'stopped', reports: expect.any(Array) });
    expect((await resultFixture({ missing: true })).result.status).toBe('incomplete');
    expect((await resultFixture({ duplicate: true })).result.status).toBe('incomplete');
    const tampered = await resultFixture({ tamper: true });
    expect(tampered.result.status).toBe('incomplete'); expect(tampered.cleanup).toBe('stopped');
  });
  it('does not turn successful report persistence into a fabricated cleanup success', async () => {
    expect((await resultFixture({ cleanup: true })).result).toMatchObject({ status: 'complete', cleanup: 'unknown' });
  });
});

async function historyFixture() {
  const { result, prepared } = await resultFixture();
  const old = { ...prepared.admission, ...context, head: 'd'.repeat(40), generation: 1,
    packetDigest: '9'.repeat(64), status: 'complete', findings: [finding], resolvedFindingIds: [], rebuttals: [] };
  const body = 'This behavior is intentional; please verify against the current contract.';
  const rebuttal = { id: 'comment-1', findingId: finding.id, authorId: 77, body, digest: await reviewDigest(new TextEncoder().encode(body)), head: context.head };
  const github = { authorize: async () => {}, readContext: async () => context,
    readHistory: async () => ({ complete: true, records: [old], rebuttals: [rebuttal] }),
    authorizeRebuttal: async () => true };
  return { result, prepared, old, rebuttal, github };
}

describe('REQ-OPERATOR-050: GitHub-authoritative history', () => {
  it('carries original findings across force-push and snapshots authorized rebuttals without treating them as clearance', async () => {
    const f = await historyFixture(); const history = await reconcileReviewHistory(f.prepared, f.result, f.github);
    expect(history.findings).toEqual([finding]); expect(history.rebuttals).toEqual([f.rebuttal]);
    expect(history.clear).toBe(false); expect(history.coverageAdvanced).toBe(true);
  });
  it('missing history, unauthorized rebuttals, stale or partial rounds cannot clear or advance coverage', async () => {
    const f = await historyFixture();
    for (const github of [
      { ...f.github, readHistory: async () => ({ complete: false, records: [], rebuttals: [] }) },
      { ...f.github, authorizeRebuttal: async () => false },
      { ...f.github, readContext: async () => ({ ...context, base: 'e'.repeat(40) }) },
    ]) {
      const history = await reconcileReviewHistory(f.prepared, f.result, github);
      expect(history.clear).toBe(false); expect(history.coverageAdvanced).toBe(false);
    }
    const history = await reconcileReviewHistory(f.prepared, { ...f.result, status: 'incomplete' }, f.github);
    expect(history.coverageAdvanced).toBe(false); expect(history.findings).toEqual([finding]);
  });
  it('ignores resolution claims in partial records and rejects foreign history', async () => {
    const f = await historyFixture();
    const partial = { ...f.old, generation: 2, status: 'incomplete', findings: [], resolvedFindingIds: [finding.id] };
    const history = await reconcileReviewHistory(f.prepared, f.result, { ...f.github,
      readHistory: async () => ({ complete: true, records: [f.old, partial], rebuttals: [] }) });
    expect(history.findings).toEqual([finding]);
    const foreign = await reconcileReviewHistory(f.prepared, f.result, { ...f.github,
      readHistory: async () => ({ complete: true, records: [{ ...f.old, repositoryId: 99 }], rebuttals: [] }) });
    expect(foreign.clear).toBe(false); expect(foreign.coverageAdvanced).toBe(false);
  });
});

describe('REQ-OPERATOR-050: independent publisher uncertainty and fencing', () => {
  async function publisherFixture() {
    const f = await historyFixture();
    const history = await reconcileReviewHistory(f.prepared, f.result, { ...f.github,
      readHistory: async () => ({ complete: true, records: [], rebuttals: [] }) });
    let receipt: any = null; const published: any[] = [];
    const authority = { serialize: async <T>(run: () => Promise<T>) => run(), authorize: async () => {},
      readCurrent: async () => ({ ...context, activityId: admission.activityId, generation: 2 }),
      loadReceipt: async () => receipt, saveReceipt: async (value: unknown) => { receipt = value; },
      findPublication: async () => null,
      writePublication: async (record: unknown) => { published.push(record); return { checkId: 123, recordId: 456 }; } };
    return { ...f, history, authority, published, getReceipt: () => receipt };
  }
  it('publishes a generation-specific shadow result only through the independent authority', async () => {
    const f = await publisherFixture();
    expect(await publishReview(f.prepared, f.result, f.history, f.authority)).toMatchObject({ status: 'published', checkId: 123, recordId: 456 });
    expect(f.published[0]).toMatchObject({ conclusion: 'success', shadow: true, generation: 2, activityId: admission.activityId });
    expect(f.published[0].externalId).toContain('generation-2');
  });
  it('never clears stale/partial rounds or republishes an ambiguous accepted write', async () => {
    const f = await publisherFixture();
    expect((await publishReview(f.prepared, { ...f.result, cleanup: 'unknown' }, f.history, f.authority)).status).toBe('incomplete');
    const stale = await publishReview(f.prepared, f.result, f.history, { ...f.authority,
      readCurrent: async () => ({ ...context, activityId: admission.activityId, generation: 3 }) });
    expect(stale.status).toBe('stale'); expect(f.published).toEqual([]);
    const partial = await publishReview(f.prepared, { ...f.result, status: 'incomplete' }, f.history, f.authority);
    expect(partial.status).toBe('incomplete'); expect(f.published).toEqual([]);
    const authority = { ...f.authority, writePublication: async (record: unknown) => { f.published.push(record); throw Error('response lost'); } };
    expect((await publishReview(f.prepared, f.result, f.history, authority)).status).toBe('unknown');
    expect((await publishReview(f.prepared, f.result, f.history, authority)).status).toBe('unknown');
    expect(f.published).toHaveLength(1);
    expect((await publishReview(f.prepared, f.result, f.history, { ...authority,
      findPublication: async () => ({ checkId: 123, recordId: 456, digest: f.getReceipt().digest }) })).status).toBe('published');
  });
  it('rejects history from another packet and does not clear a report whose findings were dropped', async () => {
    const f = await publisherFixture();
    expect((await publishReview({ ...f.prepared, packetDigest: '0'.repeat(64) }, f.result, f.history, f.authority)).status).toBe('incomplete');
    const red = { ...f.result, reports: f.result.reports.map((r, index) => ({ ...r,
      findings: index === 0 ? [{ id: finding.id, severity: 'HIGH' as const, path: finding.path,
        line: finding.line, evidence: finding.evidence, message: finding.message }] : [] })) };
    expect((await publishReview(f.prepared, red, f.history, f.authority)).status).toBe('incomplete');
    expect(f.published).toEqual([]);
  });
  it('rechecks current context after a write and never reports stale publication as current', async () => {
    const f = await publisherFixture(); let reads = 0;
    expect((await publishReview(f.prepared, f.result, f.history, { ...f.authority,
      readCurrent: async () => ({ ...context, activityId: admission.activityId, generation: ++reads <= 2 ? 2 : 3 }) })).status).toBe('stale');
  });
});
