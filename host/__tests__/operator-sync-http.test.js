/** REQ-OPERATOR-023: bounded scoped Sync now host API, distinct from whole-home bisync. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorSyncHttpController } from '../dist/operator-sync-http.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const request = { operationId: 'sync-1', requestDigest: 'a'.repeat(64), files: [
  { path: 'report.txt', size: 6, sha256: 'b'.repeat(64) },
] };
const receipt = { schemaVersion: 1, ...request, status: 'uploaded', manifestDigest: 'c'.repeat(64) };
function fixture() {
  const calls = [];
  const coordinator = { async upload(value) { calls.push(['upload', value]); return receipt; },
    async status(operationId) { calls.push(['status', operationId]); return operationId === 'sync-1' ? receipt : null; } };
  return { controller: new OperatorSyncHttpController(coordinator), calls, coordinator };
}
const syncNow = (controller, body = bytes(request)) => controller.handle({ method: 'POST', pathname: '/internal/bisync-trigger', body });

test('REQ-OPERATOR-023: scoped Sync now and GET receipt expose uploaded but not verified state', async () => {
  const f = fixture();
  const upload = await syncNow(f.controller);
  assert.equal(upload.status, 200);
  assert.deepEqual(JSON.parse(upload.body), receipt);
  assert.equal(upload.headers['Cache-Control'], 'no-store');
  const status = await f.controller.handle({ method: 'GET', pathname: '/internal/operator/sync/operations/sync-1' });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), receipt);
  assert.deepEqual(f.calls, [['upload', request], ['status', 'sync-1']]);
});

test('REQ-OPERATOR-023: malformed/oversized/method/unknown requests fail before coordinator effects', async () => {
  const f = fixture();
  assert.equal(await f.controller.handle({ method: 'GET', pathname: '/health' }), null);
  assert.equal((await f.controller.handle({ method: 'GET', pathname: '/internal/bisync-trigger' })).status, 405);
  assert.equal((await syncNow(f.controller, new TextEncoder().encode('{'))).status, 400);
  assert.equal((await syncNow(f.controller, new Uint8Array(65 * 1024))).status, 413);
  assert.equal((await f.controller.handle({ method: 'GET', pathname: '/internal/operator/sync/operations/missing' })).status, 404);
  assert.deepEqual(f.calls, [['status', 'missing']]);
});

test('REQ-OPERATOR-023: bounded output failures return stable redacted codes', async () => {
  const f = fixture();
  const missing = Object.assign(new Error('ENOENT /secret'), { code: 'ENOENT' });
  f.coordinator.upload = async () => { throw missing; };
  let response = await syncNow(f.controller);
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'Sync output is unavailable', code: 'SYNC_OUTPUT_NOT_FOUND' });
  assert.equal(response.body.includes('/secret'), false);

  f.coordinator.upload = async () => { throw new Error('Owned output size mismatch /secret'); };
  response = await syncNow(f.controller);
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'Sync output does not match its declaration', code: 'SYNC_OUTPUT_MISMATCH' });
  assert.equal(response.body.includes('/secret'), false);
});

test('REQ-OPERATOR-023: conflict, unknown and internal errors are explicit and redacted', async () => {
  const f = fixture();
  f.coordinator.upload = async () => { throw new Error('Operator sync operation conflict /secret'); };
  let response = await syncNow(f.controller);
  assert.equal(response.status, 409);
  assert.equal(response.body.includes('/secret'), false);
  f.coordinator.upload = async () => { throw new Error('Operator sync outcome is unknown /secret'); };
  response = await syncNow(f.controller);
  assert.equal(response.status, 202);
  assert.equal(JSON.parse(response.body).status, 'unknown');
  f.coordinator.upload = async () => { throw new Error('Operator sync state unavailable /secret'); };
  response = await syncNow(f.controller);
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'Sync state is unavailable', code: 'SYNC_STATE_FAILED' });
  f.coordinator.upload = async () => { throw new Error('disk /secret failed'); };
  response = await syncNow(f.controller);
  assert.equal(response.status, 500);
  assert.equal(response.body.includes('/secret'), false);
});
