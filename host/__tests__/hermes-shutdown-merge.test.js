import assert from 'node:assert/strict';
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
const source = n => ({ owner: 'fixture-bucket', sessionId: `hermes${n}fixture`, generation: 7,
  intent: `stop-${n}`, snapshotId: `saved-${n}` });

function fixture({ initial = all(), before, after } = {}) {
  const snapshots = new Map(), events = [];
  let masters = bytes(initial);
  const saved = (id, baseline, working) => snapshots.set(id.snapshotId, {
    id, baseline: baseline === null ? null : bytes(baseline), files: bytes(working),
  });
  const observe = event => { events.push(event); before?.(event); };
  const storage = {
    async loadSnapshot(id) {
      const snapshot = snapshots.get(id.snapshotId);
      if (!snapshot || !isDeepStrictEqual(id, snapshot.id)) throw new Error('no confirmed save for this source');
      return { baseline: snapshot.baseline && bytes(snapshot.baseline), files: bytes(snapshot.files) };
    },
    async readMaster(file) {
      const event = { op: 'read', file };
      observe(event);
      return after?.(event) ?? Buffer.from(masters[file]);
    },
    async writeMaster(file, body) {
      const event = { op: 'write', file };
      observe(event);
      masters[file] = Buffer.from(body);
      after?.(event);
    },
  };
  const visibleFiles = () => text(masters);
  const writes = () => events.filter(({ op }) => op === 'write');
  function run(id, infer, options = {}) {
    return runHermesShutdownMerge({ source: id, deadline: Date.now() + budget,
      signal: new AbortController().signal, storage, infer, ...options });
  }
  return { saved, run, visibleFiles, writes, events, install: stores => { masters = bytes(stores); } };
}

const canary = work => () => bytes(work);
function assertPublished(f, result, id, expected) {
  assert.equal(result.status, 'merged');
  assert.deepEqual(f.visibleFiles(), expected);
  assert.deepEqual(result.receipt?.source, id, 'receipt must authorize only this exact saved snapshot');
}
function assertUnpublished(f, result, previous) {
  assert.notEqual(result.status, 'merged');
  assert.equal(result.receipt, undefined);
  assert.deepEqual(f.visibleFiles(), previous);
  assert.deepEqual(f.writes(), [], 'no master writes before validated output');
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
      assert.deepEqual(request?.masters, masters, 'every queue head uses the latest fixed masters, not its original baseline');
      assert.deepEqual(Object.fromEntries(Object.entries(request?.changes ?? {}).filter(([, entries]) => entries.length)),
        expectedDeltas, 'pass complete materially new entries once, never inherited or missing entries');
      assertPublished(f, result, id, output);
    }
    assert.equal(f.writes().length, 12);
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

describe('REQ-MEM-044 AC2: validated fixed master transfer', () => {
  test('repairs oversized output and verifies all four fixed masters before granting a receipt', async () => {
    const id = source(1), f = fixture({ initial: original });
    const working = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, working);
    const atLimit = '🧪'.repeat(75_000);
    const output = { ...working, [project]: atLimit };
    const result = await f.run(id, ({ repair }) => bytes(repair ? output : { ...output, [project]: 'x' + atLimit }));
    assertPublished(f, result, id, output);
    assert.deepEqual(f.writes().map(event => event.file), files);
    const lastWrite = f.events.lastIndexOf(f.writes().at(-1));
    assert.deepEqual(f.events.slice(lastWrite + 1).map(e => e.file), files);
  });

  for (const invalid of [Buffer.from([0x61, 0xc3, 0x28]), `first${delimiter}${delimiter}last`]) {
    test('invalid Markdown is rejected before any master write', async () => {
      const id = source(1), f = fixture({ initial: original });
      f.saved(id, original, all({ ...original, [project]: 'New fact.' }));
      assertUnpublished(f, await f.run(id, canary({ ...original, [project]: invalid })), original);
    });
  }

  for (const fault of ['partial upload', 'corrupted readback', 'lost acknowledgement']) {
    test(`REQ-MEM-044: ${fault} never authorizes a merged receipt`, async () => {
      let writes = 0;
      const f = fixture({ initial: original, before: e => {
        if (e.op === 'write' && ++writes === 2 && fault === 'partial upload') throw new Error('write failed');
      }, after: e => {
        if (e.op === 'write' && writes === 1 && fault === 'lost acknowledgement') throw new Error('response lost');
        if (writes === 4 && e.op === 'read' && e.file === project && fault === 'corrupted readback') return Buffer.from('wrong');
      } });
      const id = source(1), output = all({ ...original, [user]: 'New preference.', [project]: 'New fact.' });
      f.saved(id, original, output);
      assert.deepEqual(await f.run(id, canary(output)), { status: 'pending' });
      assert.equal(f.visibleFiles()[user], output[user], 'an accepted write is not rolled back');
      assert.equal(f.writes().length, fault === 'partial upload' ? 2 : fault === 'lost acknowledgement' ? 1 : 4);
    });
  }
});

describe('REQ-MEM-044 AC3: fixed deadline and cancellation', () => {
  test('REQ-MEM-044: input loading, inference, and repair share the original 20-minute budget', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-23T00:00:00Z') });
    const deadline = Date.now() + budget;
    const f = fixture({ initial: original, before: e => {
      if (e.op === 'read' && e.file === user) t.mock.timers.tick(budget / 2);
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
    assert.equal(repairStartedAt, deadline - 1);
    assertUnpublished(f, result, original);
  });

  for (const reason of ['expiry', 'Kill']) {
    test(`REQ-MEM-044: ${reason} during upload fences further writes and grants no receipt`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-23T00:00:00Z') });
      const controller = new AbortController();
      const f = fixture({ initial: original, after: e => {
        if (e.op === 'write' && e.file === user) {
          if (reason === 'Kill') controller.abort();
          else t.mock.timers.tick(budget);
        }
      } });
      const id = source(1), candidate = all({ ...original, [user]: 'New preference.', [project]: 'New fact.' });
      f.saved(id, original, candidate);
      assert.deepEqual(await f.run(id, canary(candidate), { signal: controller.signal }), { status: 'pending' });
      assert.deepEqual(f.writes().map(e => e.file), [user]);
      assert.equal(f.visibleFiles()[user], candidate[user]);
    });
  }

  test('REQ-MEM-044: Kill aborts in-flight inference without waiting for a candidate or writing masters', { timeout: 1_000 }, async () => {
    const controller = new AbortController();
    const f = fixture({ initial: original });
    const id = source(1), candidate = all({ ...original, [project]: 'New fact.' });
    f.saved(id, original, candidate);
    const started = Promise.withResolvers(), model = Promise.withResolvers();
    const attempt = f.run(id, ({ signal }) => { started.resolve(signal); return model.promise; }, { signal: controller.signal });
    const signal = await started.promise;
    controller.abort();
    try {
      assertUnpublished(f, await attempt, original);
      assert.equal(signal.aborted, true);
    } finally { model.resolve(bytes(candidate)); }
  });

  // The retry test covers the worker in AC4; startup/terminal fencing and reseed in AC5 belong to integration.
  test('REQ-MEM-044: a headless worker retry uses the same saved change and current masters after an earlier failure', async () => {
    let unavailable = true;
    const f = fixture({ initial: original, before: e => {
      if (unavailable && e.op === 'write') throw new Error('R2 temporarily unavailable');
    } });
    const id = source(1), working = all({ ...original, [project]: 'Use the lab manifest.' });
    f.saved(id, original, working);
    assert.deepEqual(await f.run(id, canary(working)), { status: 'pending' });
    assert.deepEqual(f.visibleFiles(), original);
    unavailable = false;
    const newer = all({ ...original, [failures]: 'A different session recorded this lesson.' });
    f.install(newer);
    const output = all({ ...newer, [project]: working[project] });
    let modelInput;
    const retry = await f.run(id, input => { modelInput = input; return bytes(output); });
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
    assert.equal(f.writes().length, 5);
  });
});
