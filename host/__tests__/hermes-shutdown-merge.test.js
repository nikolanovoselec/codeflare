import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { runHermesShutdownMerge } from '../src/hermes-shutdown-merge.ts';

const files = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'];
const [user, memory, failures, project] = files;
const delimiter = '\n§\n';
const budget = 20 * 60_000;
const metadata = (text, last = '2026-11-23') => `${text} <!-- created=2026-11-01, last=${last} -->`;
const all = (overrides = {}) => Object.fromEntries(files.map(file => [file, overrides[file] ?? '']));
const bytes = stores => Object.fromEntries(Object.entries(stores).map(([file, body]) => [file, Buffer.from(body)]));
const text = stores => Object.fromEntries(Object.entries(stores).map(([file, body]) => [file, Buffer.from(body).toString('utf8')]));
const digests = stores => Object.fromEntries(Object.entries(stores).map(([file, body]) => [file, createHash('sha256').update(body).digest('hex')]));
const source = n => ({ owner: 'fixture-bucket', sessionId: `hermes${n}fixture`, generation: 7,
  intent: `stop-${n}`, snapshotId: `saved-${n}` });

function fixture({ initial = all(), opaque = false, before, after } = {}) {
  const snapshots = new Map(), revisions = new Map(), events = [];
  let current, version = 0;
  const saved = (id, baseline, working) => snapshots.set(id.snapshotId, {
    id, baseline: baseline === null ? null : bytes(baseline), files: bytes(working),
  });
  function install(revision, id, stores) {
    const contents = bytes(stores);
    revisions.set(revision, contents);
    current = { etag: opaque ? `"encrypted-generation-${++version}"` : `"object-${++version}"`,
      commit: { revision, source: id, files: digests(contents) } };
  }
  install('prior-revision', source(0), initial);
  const storage = {
    async loadSnapshot(id) {
      const snapshot = snapshots.get(id.snapshotId);
      if (!snapshot || !isDeepStrictEqual(id, snapshot.id)) {
        throw new Error('no confirmed save for this source');
      }
      return { baseline: snapshot.baseline && bytes(snapshot.baseline), files: bytes(snapshot.files) };
    },
    async readCommit() {
      const event = { op: 'read-commit' };
      events.push(event);
      before?.(event);
      return structuredClone(current);
    },
    async readRevisionFile(revision, file) {
      const event = { op: 'read-file', revision, file };
      events.push(event);
      before?.(event);
      const result = revisions.get(revision)?.[file];
      return after?.(event) ?? (result ? Buffer.from(result) : null);
    },
    async stageRevisionFile(revision, file, body) {
      const event = { op: 'stage', revision, file };
      events.push(event);
      before?.(event);
      if (!revisions.has(revision)) revisions.set(revision, {});
      revisions.get(revision)[file] = Buffer.from(body);
      after?.(event);
    },
    async commitRevision(commit, expectedEtag) {
      const event = { op: 'commit', revision: commit.revision, expectedEtag };
      events.push(event);
      before?.(event);
      if (current.etag !== expectedEtag) return false;
      current = { etag: `"new-generation-${++version}"`, commit: structuredClone(commit) };
      after?.(event);
      return true;
    },
  };
  const visibleFiles = () => text(revisions.get(current.commit.revision));
  const commits = () => events.filter(({ op }) => op === 'commit');
  function run(id, infer, options = {}) {
    return runHermesShutdownMerge({ source: id, attemptId: `attempt-${id.snapshotId}`, deadline: Date.now() + budget,
      signal: new AbortController().signal, storage, infer, ...options });
  }
  return { saved, run, visibleFiles, commits, events, install, commit: () => structuredClone(current) };
}

const canary = work => () => bytes(work);
function assertPublished(f, result, id, expected) {
  assert.equal(result.status, 'merged');
  const { commit } = f.commit();
  assert.deepEqual(commit.source, id);
  assert.deepEqual(commit.files, digests(bytes(expected)), 'commit covers the verified bytes of each of the four files');
  assert.deepEqual(f.visibleFiles(), expected);
  assert.deepEqual(result.receipt?.source, id, 'receipt must authorize only this exact saved snapshot');
  assert.equal(result.receipt?.revision, commit.revision);
}
function assertUnpublished(f, result, previous) {
  assert.notEqual(result.status, 'merged');
  assert.equal(result.receipt, undefined);
  assert.deepEqual(f.visibleFiles(), previous);
  assert.deepEqual(f.commits(), [], 'a failed attempt must not issue a commit for unverified content');
}

const inherited = 'Keep the calibration checksum.';
const oldFact = 'Report distances in miles.\nRetain the raw measurements.';
const correction = 'Report distances in kilometres.\nRetain the raw measurements.';
const original = all({ [user]: [metadata(oldFact), metadata(inherited)].join(delimiter), [memory]: 'Old lab notes.' });

// AC1: these callbacks observe only the synthetic model request, not private diff calls.
describe('REQ-MEM-044 AC1: whole-entry deltas', () => {
  test('REQ-MEM-044: three stops use fresh masters and carry whole additions and corrections without deleting absent facts', async () => {
    const f = fixture({ initial: original });
    const lab = 'Run the calibration first.\nStore two calibration readings.';
    const lesson = 'Do not reuse failed calibration data.';
    const projectFact = 'Use the lab manifest for fixture paths.';
    const first = all({ ...original, [user]: [metadata(correction), metadata(inherited)].join(delimiter), [failures]: lesson });
    const second = all({ ...first, [memory]: [original[memory], lab].join(delimiter) });
    const third = all({ ...second, [project]: projectFact });
    const cases = [
      { working: all({ ...original, [user]: metadata(correction), [failures]: [lesson, lesson].join(delimiter) }),
        expectedDeltas: { [user]: [correction], [failures]: [lesson] }, masters: original, output: first },
      { working: all({ ...original, [memory]: [metadata(original[memory]), lab].join(delimiter) }),
        expectedDeltas: { [memory]: [lab] }, masters: first, output: second },
      { working: all({ ...original, [project]: projectFact }),
        expectedDeltas: { [project]: [projectFact] }, masters: second, output: third },
    ];
    for (const [index, { working, expectedDeltas, masters, output }] of cases.entries()) {
      const id = source(index + 1);
      f.saved(id, original, working);
      let request;
      const result = await f.run(id, input => { request = input; return bytes(output); });
      assert.deepEqual(request?.masters, masters, 'every queue head uses the prior verified revision, not its original baseline');
      assert.deepEqual(Object.fromEntries(Object.entries(request?.changes ?? {}).filter(([, entries]) => entries.length)),
        expectedDeltas, 'pass complete materially new entries once, never inherited or missing entries');
      assertPublished(f, result, id, output);
    }
    assert.equal(f.commits().length, 3, 'each of the three saves publishes exactly one revision');
  });

  test('REQ-MEM-044: timestamp-only changes and removals alone skip inference and do not advance the masters', async () => {
    const f = fixture({ initial: original });
    let inferred = false;
    const id = source(1);
    f.saved(id, original, all({ ...original, [user]: metadata(oldFact, '2026-11-24') }));
    const result = await f.run(id, () => { inferred = true; return bytes(all()); });
    assert.equal(result.status, 'skipped');
    assert.equal(inferred, false);
    assertUnpublished(f, result, original);
  });

  test('REQ-MEM-044: an old store without a trustworthy baseline is preserved, not marked merged', async () => {
    const f = fixture({ initial: original });
    const id = source(1);
    f.saved(id, null, all({ [user]: 'A pre-baseline session fact.' }));
    let inferred = false;
    const result = await f.run(id, () => { inferred = true; return bytes(all()); });
    assert.equal(inferred, false);
    assertUnpublished(f, result, original);
  });
});

// AC2: the fake versions opaque commit tokens and exposes what a reader can see.
describe('REQ-MEM-044 AC2: validated complete revision', () => {
  for (const opaque of [false, true]) {
    test(`REQ-MEM-044: repairs an oversized candidate, verifies four files and conditionally publishes with ${opaque ? 'an opaque encrypted-style' : 'a plain-style'} token`, async () => {
      const f = fixture({ initial: original, opaque });
      const id = source(1);
      f.saved(id, original, all({ ...original, [project]: 'Use the lab manifest.' }));
      const previous = f.commit();
      const tail = delimiter + metadata('Another distinct entry.');
      const remaining = 150_000 - tail.length;
      const atLimit = '🧪'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) + tail;
      const compacted = all({ ...original, [project]: atLimit });
      const result = await f.run(id, ({ repair }) => bytes(repair ? compacted : { ...compacted, [project]: 'x' + atLimit }));
      assertPublished(f, result, id, compacted);
      const [commitEvent] = f.commits();
      assert.equal(f.commits().length, 1, 'the oversized first candidate never gets a commit');
      assert.equal(commitEvent.expectedEtag, previous.etag);
      assert.notEqual(commitEvent.revision, previous.commit.revision, 'readers of the previous commit retain immutable files');
      const boundary = f.events.indexOf(commitEvent);
      const events = f.events.slice(0, boundary);
      for (const file of files) {
        const stage = events.findIndex(e => e.op === 'stage' && e.revision === commitEvent.revision && e.file === file);
        assert.ok(stage >= 0 && events.slice(stage + 1).some(e => e.op === 'read-file' && e.revision === commitEvent.revision && e.file === file), file);
      }
      assert.ok(f.events.slice(boundary + 1).some(e => e.op === 'read-commit'), 'verify the published commit by readback');
    });
  }

  for (const [reason, invalid] of [
    ['malformed UTF-8', Buffer.from([0x61, 0xc3, 0x28])],
    ['an empty interior entry', `first${delimiter}${delimiter}last`],
  ]) {
    test(`REQ-MEM-044: persistent ${reason} never replaces any part of the validated revision`, async () => {
      const f = fixture({ initial: original });
      const id = source(1);
      f.saved(id, original, all({ ...original, [project]: 'Use the lab manifest.' }));
      assertUnpublished(f, await f.run(id, canary({ ...original, [project]: invalid })), original);
      assert.equal(f.events.some(e => e.op === 'stage'), false, 'validation precedes staging');
    });
  }

  for (const fault of ['partial upload', 'corrupted stage readback']) {
    test(`REQ-MEM-044: ${fault} leaves the previous complete revision readable`, async () => {
      let count = 0;
      const f = fixture({ initial: original,
        before: e => { if (fault === 'partial upload' && e.op === 'stage' && ++count >= 2) throw new Error('R2 write lost'); },
        after: e => fault === 'corrupted stage readback' && e.revision !== 'prior-revision' && e.file === project
          ? Buffer.from('different stored contents') : undefined,
      });
      const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
      f.saved(id, original, candidate);
      assertUnpublished(f, await f.run(id, canary(candidate)), original);
    });
  }

  test('REQ-MEM-044: a stale conditional writer does not overwrite the winning revision', async () => {
    const id = source(1), other = source(9), winner = all({ ...original, [failures]: 'Concurrent saved lesson.' });
    const f = fixture({ initial: original, before: e => {
      if (e.op === 'commit') f.install('winning-peer-revision', other, winner);
    } });
    const previous = f.commit();
    const candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    const result = await f.run(id, canary(candidate));
    assert.notEqual(result.status, 'merged');
    assert.equal(result.receipt, undefined);
    assert.deepEqual(f.visibleFiles(), winner);
    assert.deepEqual(f.commit().commit.source, other);
    assert.deepEqual(f.commits().map(e => e.expectedEtag), [previous.etag], 'no write with a renewed precondition');
  });
});

// AC3: the caller supplies the deadline created at confirmed save or retry head.
describe('REQ-MEM-044 AC3: fixed deadline, cancellation, and uncertain publication', () => {
  test('REQ-MEM-044: input loading, inference, and repair share the original 20-minute budget', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-23T00:00:00Z') });
    const deadline = Date.now() + budget;
    let readingInputs = true;
    const f = fixture({ initial: original, before: e => {
      if (readingInputs && e.op === 'read-commit') {
        readingInputs = false;
        t.mock.timers.tick(budget / 2);
      }
    } });
    const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    let repairStartedAt;
    const result = await f.run(id, ({ repair }) => {
      if (!repair) {
        t.mock.timers.tick(budget / 2 - 1);
        return bytes({ ...candidate, [project]: 'x'.repeat(150_001) });
      }
      repairStartedAt = Date.now();
      t.mock.timers.tick(1);
      return bytes(candidate);
    }, { deadline });
    assert.equal(repairStartedAt, deadline - 1, 'an invalid first candidate still permits a repair before expiry');
    assertUnpublished(f, result, original);
  });

  for (const reason of ['expiry', 'Kill']) {
    test(`REQ-MEM-044: ${reason} after staging fences the commit even when all candidate bytes are valid`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-23T00:00:00Z') });
      const controller = new AbortController();
      const f = fixture({ initial: original, after: e => {
        if (e.op === 'stage' && e.file === project) {
          if (reason === 'Kill') controller.abort();
          else t.mock.timers.tick(budget);
        }
      } });
      const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
      f.saved(id, original, candidate);
      assertUnpublished(f, await f.run(id, canary(candidate), { signal: controller.signal }), original);
      assert.ok(f.events.some(e => e.op === 'stage' && e.file === project), 'exercise cancellation during publication, not before inference');
    });
  }

  test('REQ-MEM-044: Kill aborts in-flight inference without waiting for a candidate or writing masters', { timeout: 1_000 }, async () => {
    const controller = new AbortController();
    const f = fixture({ initial: original });
    const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    const started = Promise.withResolvers(), model = Promise.withResolvers();
    const attempt = f.run(id, ({ signal }) => {
      started.resolve(signal);
      return model.promise;
    }, { signal: controller.signal });
    const signal = await started.promise;
    controller.abort();
    try {
      assertUnpublished(f, await attempt, original);
      assert.equal(signal.aborted, true, 'the cancellation propagates to the inference process');
    } finally {
      model.resolve(bytes(candidate));
    }
    assert.equal(f.events.some(e => e.op === 'stage'), false);
  });

  test('REQ-MEM-044: reconciles an issued commit whose response was lost at Kill without writing or inferring twice', async () => {
    const controller = new AbortController();
    const f = fixture({ initial: original, opaque: true, after: e => {
      if (e.op === 'commit') {
        controller.abort();
        throw new Error('commit response lost after R2 accepted it');
      }
    } });
    const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    assertPublished(f, await f.run(id, canary(candidate), { signal: controller.signal }), id, candidate);
    let inferred = false;
    const retry = await f.run(id, () => { inferred = true; return bytes(all()); }, { attemptId: 'manual-retry' });
    assertPublished(f, retry, id, candidate);
    assert.equal(inferred, false);
    assert.equal(f.commits().length, 1, 'a verified prior commit settles the exact save without another attempt to write');
  });

  test('REQ-MEM-044: a lost commit response with the predecessor still visible does not replay the write', async () => {
    const f = fixture({ initial: original, before: e => {
      if (e.op === 'commit') throw new Error('R2 may still be handling the first conditional put');
    } });
    const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    const result = await f.run(id, canary(candidate));
    assert.equal(result.status, 'uncertain', 'a predecessor read does not settle an already-issued write');
    assert.equal(result.receipt, undefined);
    assert.deepEqual(f.visibleFiles(), original);
    assert.equal(f.commits().length, 1, 'a read of the predecessor does not prove the issued write can no longer land');
  });

  test('REQ-MEM-044: a successful PUT without readback at expiry cannot confer a receipt, and later confirmation does not replay it', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-23T00:00:00Z') });
    let blockReadback = false;
    const f = fixture({ initial: original,
      before: e => { if (blockReadback && e.op === 'read-commit') throw new Error('R2 readback unavailable'); },
      after: e => {
        if (e.op === 'commit') {
          blockReadback = true;
          t.mock.timers.tick(budget);
        }
      },
    });
    const id = source(1), candidate = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, candidate);
    const result = await f.run(id, canary(candidate));
    assert.equal(result.status, 'uncertain');
    assert.equal(result.receipt, undefined);
    assert.deepEqual(f.visibleFiles(), candidate, 'an unverified response is not proof that nothing landed');
    assert.equal(f.commits().length, 1);
    blockReadback = false;
    let inferred = false;
    const retry = await f.run(id, () => { inferred = true; return bytes(all()); }, { attemptId: 'manual-retry' });
    assertPublished(f, retry, id, candidate);
    assert.equal(inferred, false);
    assert.equal(f.commits().length, 1);
  });

  // The retry test covers the worker in AC4; startup/terminal fencing and reseed in AC5 belong to integration.
  test('REQ-MEM-044: a headless worker retry uses the same saved change and current masters after an earlier failure', async () => {
    let unavailable = true;
    const f = fixture({ initial: original, before: e => {
      if (unavailable && e.op === 'stage') throw new Error('R2 temporarily unavailable');
    } });
    const id = source(1), working = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, working);
    assertUnpublished(f, await f.run(id, canary(working)), original);
    unavailable = false;
    const newer = all({ ...original, [failures]: 'A different session recorded this lesson.' });
    f.install('newer-masters', source(2), newer);
    const output = all({ ...newer, [project]: working[project] });
    let modelInput;
    const retry = await f.run(id, input => { modelInput = input; return bytes(output); }, { attemptId: 'manual-retry' });
    assert.deepEqual(modelInput?.changes[project], [working[project]]);
    assert.deepEqual(modelInput?.masters, newer);
    assertPublished(f, retry, id, output);

    for (const mismatch of [{ generation: id.generation + 1 }, { intent: 'new-stop' }, { snapshotId: 'different-save' }]) {
      let inferredFromStale = false;
      const stale = await f.run({ ...id, ...mismatch }, () => { inferredFromStale = true; return bytes(all()); });
      assert.equal(inferredFromStale, false, 'a mismatched save must not be passed to inference');
      assert.notEqual(stale.status, 'merged');
      assert.equal(stale.receipt, undefined, 'the earlier receipt does not settle a different save, generation, or intent');
    }
    assert.deepEqual(f.visibleFiles(), output);
    assert.equal(f.commits().length, 1);
  });
});
