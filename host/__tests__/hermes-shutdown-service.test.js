import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesShutdownService } from '../src/hermes-shutdown-service.ts';

const signal = new AbortController().signal;
const owner = 'owner-bucket';
const sessionId = 'hermessorig';
const generation = 3;
const route = { allowPersonalPiProviders: true };
const snapshotId = 'a'.repeat(64);
const command = () => ({ ...route, intent: 'shutdown-3', snapshotId, deadline: Date.now() + 60_000 });

function fixture(value = snapshotId, retry) {
  const calls = [];
  const service = createHermesShutdownService({ owner, sessionId, generation, retry,
    async identifySavedSnapshot() { return value; },
    async run(options) { calls.push(options.source); return { status: 'skipped' }; },
  });
  return { service, calls };
}

test('REQ-MEM-044: a merge uses the exact last confirmed save and current owner generation', async () => {
  const { service, calls } = fixture();
  assert.equal(await service.saved(signal), snapshotId);
  assert.deepEqual(await service.merge(command(), signal), { status: 'skipped' });
  assert.deepEqual(calls, [{ owner, sessionId, generation, intent: 'shutdown-3', snapshotId }]);
});

test('REQ-MEM-044: an unconfirmed or mismatched snapshot never starts a merge', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.merge(command(), signal), /confirmed save/);
  await service.saved(signal);
  await assert.rejects(service.merge({ ...command(), snapshotId: 'b'.repeat(64) }, signal), /confirmed save/);
  assert.deepEqual(calls, []);
});

test('REQ-MEM-044: headless retry consumes the original confirmed snapshot without a new save', async () => {
  const { service, calls } = fixture(undefined, { snapshotId });
  await assert.rejects(service.merge({ ...command(), snapshotId: 'b'.repeat(64) }, signal), /confirmed save/);
  assert.deepEqual(await service.merge(command(), signal), { status: 'skipped' });
  assert.deepEqual(calls, [{ owner, sessionId, generation, intent: 'shutdown-3', snapshotId }]);
});

test('REQ-MEM-044: expired, malformed and duplicate requests cannot start inference', async () => {
  const { service, calls } = fixture();
  await service.saved(signal);
  await assert.rejects(service.merge({ ...command(), deadline: Date.now() - 1 }, signal), /invalid/i);
  await assert.rejects(service.merge({ ...command(), gateway: { model: '../../foreign', contextWindow: 1 } }, signal), /invalid/i);
  await service.merge(command(), signal);
  await assert.rejects(service.merge(command(), signal), /confirmed save/);
  assert.equal(calls.length, 1);
});
