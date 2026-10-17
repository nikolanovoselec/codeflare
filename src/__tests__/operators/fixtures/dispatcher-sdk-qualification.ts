import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { parseDispatcherBundle, parseOperatorManifest } from '../../../operators/distribution';
import { errorSchema, readSdkProvenance, sourceMatches, type DiagnosticSource, type ErrorMetadata, type SdkProvenance } from '../../../operators/dispatcher-diagnostics-wire';
import type { NativeFaultImport, NativeFaultSettlement } from './dispatcher-composed-fixture';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const compilerCommit = '50a530f0bcda6e264e76aae1ba19ccb5ab7b9fe1';
const selectors = ['DISPATCHER_DIAGNOSTICS_NATIVE_PACKAGE', 'DISPATCHER_DIAGNOSTICS_NATIVE_BUNDLE_SHA256',
  'DISPATCHER_DIAGNOSTICS_NATIVE_MANIFEST_SHA256', 'DISPATCHER_DIAGNOSTICS_NATIVE_PROVENANCE_SHA256',
  'DISPATCHER_DIAGNOSTICS_NATIVE_SOURCE_SHA', 'DISPATCHER_RELEASE_BRIEF_PACKAGE',
  'DISPATCHER_RELEASE_BRIEF_BUNDLE_SHA256', 'DISPATCHER_RELEASE_BRIEF_MANIFEST_SHA256',
  'DISPATCHER_RELEASE_BRIEF_PROVENANCE_SHA256'] as const;

/** Explicit caller-scoped qualification. No selector can repin a historical/v24 control. */
export async function diagnosticsQualificationAssets() {
  const required = process.env.DISPATCHER_DIAGNOSTICS_QUALIFICATION_REQUIRED;
  if (required !== undefined && required !== '1') throw new Error('Qualification-required selector must be 1 or absent');
  if (process.env.DISPATCHER_DIAGNOSTICS_NATIVE_ARTIFACT !== undefined || process.env.DISPATCHER_DIAGNOSTICS_NATIVE_SHA256 !== undefined) {
    throw new Error('Global diagnostic artifact override retired: supply the separately verified three-file diagnostic package');
  }
  if (!required && selectors.every(name => process.env[name] === undefined)) {
    console.info('[native-flue] historical/v24 controls only; no candidate SDK diagnostics qualification claimed');
    return null;
  }
  for (const name of selectors) expect(process.env[name], `Candidate qualification requires BOTH immutable packages: ${name}`).toBeTruthy();
  const sourceCommit = process.env.DISPATCHER_DIAGNOSTICS_NATIVE_SOURCE_SHA!;
  expect(sourceCommit, 'Exact source of both successful package GHA assets').toMatch(/^[a-f0-9]{40}$/);
  async function load(prefix: 'DISPATCHER_DIAGNOSTICS_NATIVE' | 'DISPATCHER_RELEASE_BRIEF', intentVersion: '4' | '1') {
    const contents: string[] = [];
    for (const name of ['bundle', 'manifest', 'provenance'] as const) {
      const pin = process.env[`${prefix}_${name.toUpperCase()}_SHA256`];
      expect(pin, 'Root supplies independently verified GHA byte digests, never self-authorized local hashes').toMatch(hash);
      const bytes = await readFile(`${process.env[`${prefix}_PACKAGE`]}/operator-${name}.json`);
      expect(digest(bytes), `${prefix} immutable ${name} asset`).toBe(pin);
      contents.push(bytes.toString());
    }
    const bundleDigest = process.env[`${prefix}_BUNDLE_SHA256`]!;
    const artifact = await parseDispatcherBundle(new TextEncoder().encode(contents[0]), bundleDigest);
    const manifest = parseOperatorManifest(contents[1], 'https://fixture.internal/');
    const provenance = JSON.parse(contents[2]);
    expect(artifact).toMatchObject({ sourceCommit, className: 'FlueDispatcherAgent',
      versions: { runtime: '2.2.2', vitePlugin: '2.2.2', agents: '0.20.1' } });
    expect(manifest).toMatchObject({ profile: 'dispatcher', intentVersion, artifact: { sha256: bundleDigest } });
    if (intentVersion === '1') expect(manifest.id).toBe('release-brief-dispatcher-ci');
    expect(provenance).toMatchObject({ sourceCommit, bundleDigest,
      manifestDigest: process.env[`${prefix}_MANIFEST_SHA256`], compilerCommit });
    const sdkProvenance = readSdkProvenance(artifact);
    expect(sdkProvenance, 'Candidate must bind a valid compiler-carried derived SDK patch manifest').not.toBeNull();
    expect(sdkProvenance!.capabilities).toEqual(expect.arrayContaining(['origin-error-v1', 'strict-sse-v1',
      'sdk-attempt-v1', 'canonical-commit-v1', 'settlement-finalization-v1', 'cleanup-error-v1', 'local-outbox-v1']));
    // Transport parses JSON; production admission hashes the normalized bundle.
    // Original compiler files were verified above and are never rewritten.
    const normalizedDigest = digest(JSON.stringify(artifact));
    const { url: _url, ...manifestArtifact } = manifest.artifact;
    return { artifact, digest: normalizedDigest, sdkProvenance: sdkProvenance!,
      qualificationManifest: JSON.stringify({ ...manifest, artifact: { ...manifestArtifact, sha256: normalizedDigest } }) };
  }
  const native = await load('DISPATCHER_DIAGNOSTICS_NATIVE', '4');
  const brief = await load('DISPATCHER_RELEASE_BRIEF', '1');
  expect(brief.sdkProvenance, 'Both packages must exercise the SAME derived SDK patch set').toEqual(native.sdkProvenance);
  return { native, brief };
}

export type SdkQualificationAssets = NonNullable<Awaited<ReturnType<typeof diagnosticsQualificationAssets>>>;
type Event = { kind: string; id: string; sequence: number; generation: number; owner: string; timestamp: number;
  boundary: string; outcome: string; code: string; origin: string; error?: ErrorMetadata; evidence: string; correlation: {
    submissionDigest?: string; rootDigest?: string; sdkAttemptDigest?: string;
    sdkBatchSequence?: number; sdkRecordIndex?: number; sdkProducerEpoch?: number; sdkProducerSequence?: number;
  }; source: DiagnosticSource };
type Page = { version: number; records: Event[]; nextCursor: string | null; pageStatus: string; retainedStatus: string;
  highWater: { events: number | null };
  retention: { epoch: number; evictedRoutine: number; droppedFailure: number; droppedTerminal: number; oversized: number; rejected: number };
  binding: { generation: number; artifactDigest: string; inputDigest: string }; health: {
    sdkImport: string; gaps: string[]; sdkImportReason?: 'retirement-tail-unwitnessed' } };

/** Owner HTTP evidence plus supplied native-only window/obligation witnesses.
 * Never creates events, fabricates acknowledgements or queries a retired child. */
export async function qualifyImportedSdk(fetch: (path: string) => Promise<Response>, id: string,
  artifactDigest: string, submissions: string[], sdkProvenance: SdkProvenance, recovered = false,
  faults?: { scenario: 'ordinary' | 'precommit-reset'; settlement: NativeFaultSettlement | null; importWindow: NativeFaultImport | null }) {
  const address = `/dispatcher-composed?activity=${encodeURIComponent(id)}`;
  async function read<T>(path: string): Promise<T> {
    const response = await fetch(path);
    expect(response.status, 'REQ081 AC1/4/7; Dispatcher007 AC1/7: genuine retained SDK evidence via owner HTTP').toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(65536);
    return JSON.parse(text) as T;
  }
  type Summary = { version: number; activityId: string; binding: Page['binding']; retention: Page['retention']; highWater: Page['highWater'];
    health: Page['health']; provenance: { patchSetDigest: string }; sdkBinding: { status: string; rootDigest: string; submissionDigest: string } };
  const value = await read<Summary>(`${address}&diagnostics=summary`);
  const healthSnapshots: Page['health'][] = [];
  function qualifyImportHealth(health: Page['health']) {
    healthSnapshots.push(health);
    if (health.sdkImportReason === 'retirement-tail-unwitnessed') {
      // This sole uncertainty is architectural, not an observed dropped record:
      // the last reported window is persisted, but abort cannot witness future
      // child cleanup capture. Actual receipt/application/commit/finalization
      // records are still required below. No child scrape or flush is added.
      expect(health.sdkImport).toBe('pending');
      expect(health.gaps).toEqual(['sdk-import-incomplete']);
    } else if (faults && health.gaps.includes('error-truncated')) {
      // The public tail-only reason is intentionally absent when another
      // truthful loss already exists. Permit ONLY explained safe-error loss;
      // source/retention continuity is independently required below. This is
      // still incomplete retirement import, not a complete-tail claim.
      expect(health.sdkImportReason).toBeUndefined();
      expect(health.sdkImport).toBe('pending');
      expect([...health.gaps].sort()).toEqual(['error-truncated', 'sdk-import-incomplete']);
    } else {
      expect(health.sdkImport).toBe('host-persisted');
      expect(health.gaps).toEqual([]);
    }
  }
  function qualifyRetention(retention: Page['retention']) {
    if (faults) expect(retention, 'Fault qualification cannot waive rejected/oversized/evicted or dropped records').toMatchObject({
      epoch: 0, evictedRoutine: 0, droppedFailure: 0, droppedTerminal: 0, oversized: 0, rejected: 0,
    });
  }
  qualifyImportHealth(value.health);
  qualifyRetention(value.retention);
  expect(value).toMatchObject({ version: 2, activityId: id, binding: { generation: 1, artifactDigest,
    inputDigest: digest(JSON.stringify({ schemaVersion: 1, operatorId: 'composed-dispatcher', activityId: id,
      invocation: { repository: 'authorized/project' } })) },
    provenance: { patchSetDigest: sdkProvenance.patchSetDigest },
    sdkBinding: { status: 'available', rootDigest: expect.stringMatching(hash), submissionDigest: expect.stringMatching(hash) } });
  const records: Event[] = [];
  let cursor: string | null = null;
  let exhausted = false;
  const cursors = new Set<string>();
  // Existing finite retention budget, not a new workload or a claim that 16 pages exhaust all evidence.
  for (let request = 0; request < 128; request++) {
    const page: Page = await read<Page>(`${address}&diagnostics=history${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(page).toMatchObject({ version: 2, binding: value.binding,
      retainedStatus: page.health.gaps.length ? 'loss' : 'complete' });
    qualifyImportHealth(page.health);
    qualifyRetention(page.retention);
    if (faults) expect(page.highWater.events, 'Import witness and owner traversal must describe the same retained event snapshot').toBe(value.highWater.events);
    expect(page.records.length).toBeLessThanOrEqual(32);
    records.push(...page.records.filter(row => row.kind === 'event'));
    cursor = page.nextCursor;
    if (cursor === null) { expect(page.pageStatus).toBe('complete'); exhausted = true; break; }
    expect(page.pageStatus).toBe('more');
    expect(cursors.has(cursor), 'Retained history cursor must advance').toBe(false);
    cursors.add(cursor);
  }
  expect(exhausted, 'Qualification cannot claim complete history without enumeration exhaustion').toBe(true);
  expect(new Set(records.map(row => row.id)).size, 'No repeated event across history pages').toBe(records.length);
  const sdk = records.filter(row => row.owner === 'sdk' && row.evidence === 'observed');
  expect(sdk.length).toBeGreaterThan(0);
  for (const row of sdk) {
    expect(row.generation).toBe(1);
    expect(sourceMatches(row.source, sdkProvenance), 'Source must bind the exact admitted derived artifact').toBe(true);
    expect(row.source.boundary).toBe(row.boundary);
  }
  // Startup and instance-wide canonical rows can genuinely lack a submission
  // association. They remain visible, but cannot qualify this accepted attempt.
  const submissionDigests = submissions.length ? submissions.map(digest) : [value.sdkBinding.submissionDigest];
  expect(submissionDigests).toContain(value.sdkBinding.submissionDigest);
  const commits = sdk.filter(row => row.boundary === 'canonical-commit' && row.outcome === 'committed'
    && row.correlation.rootDigest === value.sdkBinding.rootDigest
    && submissionDigests.includes(row.correlation.submissionDigest ?? '')
    && hash.test(row.correlation.sdkAttemptDigest ?? ''));
  expect(commits.length, 'Model HTTP success or an unassociated canonical row is not this submission\'s SDK commit').toBeGreaterThan(0);
  for (const commit of commits) {
    expect(commit.source).toMatchObject({ package: '@flue/runtime', status: 'verified' });
    expect(commit.source.frames.length, 'Actual immutable source mapping, not arbitrary stack coordinates').toBeGreaterThan(0);
    expect(commit.correlation).toMatchObject({ rootDigest: value.sdkBinding.rootDigest,
      sdkAttemptDigest: expect.stringMatching(hash), submissionDigest: expect.stringMatching(hash),
      sdkBatchSequence: expect.any(Number), sdkRecordIndex: expect.any(Number),
      sdkProducerEpoch: expect.any(Number), sdkProducerSequence: expect.any(Number) });
    for (const count of [commit.correlation.sdkBatchSequence, commit.correlation.sdkRecordIndex,
      commit.correlation.sdkProducerEpoch, commit.correlation.sdkProducerSequence]) {
      expect(Number.isSafeInteger(count) && count! >= 0, 'Committed coordinates, not inferred host ordinals').toBe(true);
    }
  }
  // Serial submissions come independently from real production phase-context responses.
  // A direct nonserial submission uses the accepted SDK binding, never a phase token.
  for (const submissionDigest of submissionDigests) {
    const sourced = sdk.filter(row => row.correlation.submissionDigest === submissionDigest
      && row.correlation.rootDigest === value.sdkBinding.rootDigest);
    const committedAttempts = new Set(commits.filter(row => row.correlation.submissionDigest === submissionDigest)
      .map(row => row.correlation.sdkAttemptDigest));
    expect(committedAttempts.size, 'Every real submission needs its own committed SDK attempt').toBeGreaterThan(0);
    expect(sourced.some(row => row.boundary === 'delivery' && row.outcome === 'applied'
      && committedAttempts.has(row.correlation.sdkAttemptDigest) && hash.test(row.correlation.sdkAttemptDigest ?? '')),
    'Receipt acceptance alone is not actual input application on the committed attempt').toBe(true);
    expect(sourced.some(row => row.boundary === 'settlement' && row.outcome === 'completed'
      && committedAttempts.has(row.correlation.sdkAttemptDigest) && hash.test(row.correlation.sdkAttemptDigest ?? '')),
    'Early live terminal publication alone is not operational finalization on the committed attempt').toBe(true);
  }
  if (recovered) {
    const attemptsBySubmission = submissionDigests.map(submissionDigest => {
      // The pinned coordinator emits attempt-running with its actual submission
      // and attempt IDs BEFORE processSubmissionEntry reads the canonical root.
      // Require independently rooted evidence for that same attempt, rather
      // than inventing a root on the earlier started capture or discarding it.
      const started = sdk.filter(row => row.boundary === 'submission' && row.outcome === 'started'
        && row.correlation.submissionDigest === submissionDigest && hash.test(row.correlation.sdkAttemptDigest ?? ''));
      for (const row of started) {
        expect(row.source).toMatchObject({ package: '@flue/runtime', status: 'verified' });
        expect(row.source.frames.length).toBeGreaterThan(0);
        if (row.correlation.rootDigest !== undefined) expect(row.correlation.rootDigest).toBe(value.sdkBinding.rootDigest);
        expect(sdk.some(observed => observed.correlation.rootDigest === value.sdkBinding.rootDigest
          && observed.correlation.submissionDigest === submissionDigest
          && observed.correlation.sdkAttemptDigest === row.correlation.sdkAttemptDigest),
        'Each actual started attempt needs independently observed evidence on the accepted root and SAME submission').toBe(true);
      }
      return new Set(started.map(row => row.correlation.sdkAttemptDigest)).size;
    });
    expect(attemptsBySubmission.some(count => count >= 2),
      'Eviction must retain two actual SDK attempts of the SAME submission, not two serial phases').toBe(true);
  }
  if (faults) {
    // REQ081 AC1/3 + REQ082 AC1; Dispatcher007 AC1/4/7: qualify genuine caught
    // faults AND their unchanged successful outcomes, never synthetic envelopes.
    const selected = submissionDigests[0]; // Actual first/discovery phase response.
    const window = faults.importWindow;
    expect(window, 'Fault runs need observed root-ledger import continuity, not a fabricated outbox acknowledgement').not.toBeNull();
    expect(window).toMatchObject({ generation: 1, indexSdkImport: 'host-persisted', dropped: 0, pendingSequences: [] });
    for (const count of [window!.events, window!.through, window!.localThrough, window!.armedThrough]) {
      expect(Number.isSafeInteger(count) && count > 0).toBe(true);
    }
    // Bind the atomic root-ledger witness to this owner HTTP event snapshot;
    // do not use an earlier clean window to excuse later known source gaps.
    expect(window!.events).toBe(value.highWater.events);
    expect(window!.through).toBe(window!.localThrough);
    expect(window!.through).toBeGreaterThan(window!.armedThrough);
    const explainedErrorLoss = sdk.some(row => row.error && errorSchema.safeParse(row.error).success && row.error.loss.length > 0);
    const expectedLocalGaps = explainedErrorLoss ? ['error-truncated'] : [];
    expect(window!.gaps).toEqual(expectedLocalGaps);
    for (const health of healthSnapshots) {
      expect(health.gaps.includes('error-truncated'), 'Every allowed error-truncated gap must be witnessed in retained safe error.loss').toBe(explainedErrorLoss);
      expect(health.sdkImport, 'Imported observed window is not a witnessed retirement tail').toBe('pending');
    }
    function safeFailure(row: Event, pkg: '@flue/runtime' | 'agents', status: 'verified' | 'partial') {
      expect(row).toMatchObject({ owner: 'sdk', outcome: 'failed', origin: 'catching', evidence: 'observed',
        source: { package: pkg, status } });
      // This strict public-safe wire contract bounds causes/loss/fingerprints
      // and rejects raw error fields. A native lazy stack getter may honestly
      // yield null + unsafe-error-access; no stack digest is required or read.
      expect(errorSchema.safeParse(row.error).success, 'Actual fault needs bounded safe error metadata').toBe(true);
      expect(row.source.frames.length).toBeLessThanOrEqual(4);
      if (status === 'partial') expect(row.source.frames).toEqual([]);
      else {
        expect(row.source.frames.length).toBeGreaterThan(0);
        for (const frame of row.source.frames) expect(frame.kind).toBe('patch-boundary');
      }
    }
    if (faults.scenario === 'ordinary') {
      const appendFailures = sdk.filter(row => row.boundary === 'canonical-commit' && row.outcome === 'failed'
        && row.code === 'canonical-append-failed' && row.correlation.submissionDigest === selected);
      expect(appendFailures, 'The selected real SQLite INSERT must reject, not an oversized or fabricated batch').toHaveLength(1);
      const failed = appendFailures[0];
      safeFailure(failed, '@flue/runtime', 'verified');
      expect(failed.correlation.sdkAttemptDigest).toMatch(hash);
      const recoveredAppend = sdk.filter(row => row.boundary === 'canonical-commit' && row.outcome === 'recovered'
        && row.code === 'canonical-append-failed' && row.correlation.submissionDigest === selected
        && row.correlation.sdkAttemptDigest === failed.correlation.sdkAttemptDigest);
      expect(recoveredAppend, 'The actual writer must recover its rejected append under the SAME attempt').toHaveLength(1);
      expect(recoveredAppend[0]).toMatchObject({ origin: 'state-transition', source: { package: '@flue/runtime', status: 'verified' } });
      expect(recoveredAppend[0].source.frames.length).toBeGreaterThan(0);
      for (const frame of recoveredAppend[0].source.frames) expect(frame.kind).toBe('patch-boundary');
      // store.append emits committed coordinates before the writer reports
      // recovery. Source timestamps, not host import sequence, bound this pair.
      expect(commits.some(row => row.correlation.submissionDigest === selected
        && row.correlation.sdkAttemptDigest === failed.correlation.sdkAttemptDigest
        && row.timestamp >= failed.timestamp && row.timestamp <= recoveredAppend[0].timestamp),
      'Writer recovery requires an actual subsequently committed canonical record with SDK coordinates').toBe(true);
      const cleanup = sdk.filter(row => row.boundary === 'release' && row.outcome === 'failed'
        && row.code === 'cleanup-failed' && row.source.package === 'agents');
      expect(cleanup, 'Agents must actually catch the post-bookkeeping release error without replacing the fiber result').toHaveLength(1);
      safeFailure(cleanup[0], 'agents', 'partial');
      // The instance-bound disposer callback has no independent attempt
      // association. Do not invent or demand one for cleanup qualification.
      const obligation = faults.settlement;
      expect(obligation, 'Read the real discovery obligation during the next live phase, before retirement').not.toBeNull();
      expect(obligation!.submissionDigest).toBe(selected);
      expect(obligation!.attemptDigest).toMatch(hash);
      expect(obligation!.obligationDigest).toMatch(hash);
      for (const count of [obligation!.batchSequence, obligation!.recordIndex, obligation!.producerEpoch, obligation!.producerSequence,
        obligation!.canonicalSequence, obligation!.failureSequence, obligation!.finalizedSequence]) {
        expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
      }
      expect(obligation!.canonicalSequence).toBeLessThan(obligation!.failureSequence);
      expect(obligation!.failureSequence).toBeLessThan(obligation!.finalizedSequence);
      expect(window!.through, 'The independently observed canonical/error/finalization window must reach host persistence')
        .toBeGreaterThanOrEqual(obligation!.finalizedSequence);
      const finalizationFailure = sdk.filter(row => row.boundary === 'submission' && row.outcome === 'failed'
        && row.code === 'submission-failed' && row.source.package === '@flue/runtime'
        && row.correlation.submissionDigest === selected && row.correlation.sdkAttemptDigest === obligation!.attemptDigest);
      expect(finalizationFailure, 'Operational finalization rejection is caught as submission-failed, not a dedicated settlementfailed seam').toHaveLength(1);
      safeFailure(finalizationFailure[0], '@flue/runtime', 'partial');
      const canonical = commits.find(row => row.correlation.submissionDigest === selected
        && row.correlation.sdkAttemptDigest === obligation!.attemptDigest
        && row.correlation.sdkBatchSequence === obligation!.batchSequence && row.correlation.sdkRecordIndex === obligation!.recordIndex
        && row.correlation.sdkProducerEpoch === obligation!.producerEpoch && row.correlation.sdkProducerSequence === obligation!.producerSequence);
      expect(canonical, 'Actual submission_settled record coordinates must match the SAME retained operational obligation').toBeDefined();
      expect(sdk.some(row => row.boundary === 'settlement' && row.outcome === 'completed'
        && row.correlation.submissionDigest === selected && row.correlation.sdkAttemptDigest === obligation!.attemptDigest
        && row.timestamp >= finalizationFailure[0].timestamp),
      'Canonical settlement precedes the caught error; later ordinary SDK drain must finalize that obligation').toBe(true);
      expect(canonical!.timestamp).toBeLessThanOrEqual(finalizationFailure[0].timestamp);
    } else {
      const failures = sdk.filter(row => row.boundary === 'recovery' && row.outcome === 'failed'
        && row.code === 'submission-failed' && row.source.package === '@flue/runtime' && row.correlation.submissionDigest === selected);
      expect(failures, 'The interrupted replacement UPDATE must actually reject and reach the recovery catch').toHaveLength(1);
      safeFailure(failures[0], '@flue/runtime', 'partial');
      const originalAttempt = failures[0].correlation.sdkAttemptDigest;
      expect(originalAttempt).toMatch(hash);
      const starts = sdk.filter(row => row.boundary === 'submission' && row.outcome === 'started'
        && row.correlation.submissionDigest === selected && hash.test(row.correlation.sdkAttemptDigest ?? ''));
      expect(new Set(starts.map(row => row.correlation.sdkAttemptDigest)).size,
        'A rejected replacement UPDATE must not consume an extra running attempt').toBe(2);
      expect(starts.some(row => row.correlation.sdkAttemptDigest === originalAttempt)).toBe(true);
      const replacement = starts.find(row => row.correlation.sdkAttemptDigest !== originalAttempt
        && row.timestamp >= failures[0].timestamp);
      expect(replacement, 'Recovery catch must precede a second actual attempt of the SAME submission').toBeDefined();
      const attempt = replacement!.correlation.sdkAttemptDigest;
      expect(commits.some(row => row.correlation.submissionDigest === selected && row.correlation.sdkAttemptDigest === attempt)).toBe(true);
      expect(sdk.some(row => row.boundary === 'delivery' && row.outcome === 'applied'
        && row.correlation.submissionDigest === selected && row.correlation.sdkAttemptDigest === attempt)).toBe(true);
      expect(sdk.some(row => row.boundary === 'settlement' && row.outcome === 'completed'
        && row.correlation.submissionDigest === selected && row.correlation.sdkAttemptDigest === attempt)).toBe(true);
    }
  }
  const wire = JSON.stringify({ value, records });
  for (const privateValue of [...submissions, 'Migration compatibility remains unverified.', 'Added CSV export',
    'Fixture canonical SQLite rejection', 'Fixture operational finalization rejection',
    'Fixture interrupted replacement rejection', 'Fixture swallowed facet cleanup rejection',
    'fixture-only-token', 'fixture-only-access']) expect(wire).not.toContain(privateValue);
  return { value, records };
}
