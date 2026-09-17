/** REQ-OPERATOR-021: authenticated host Pi API projections and bounds. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorPiHttpController } from '../dist/operator-pi-http.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
function fixture() {
  const calls = [];
  const conversation = {
    async ensure() { calls.push(['ensure']); return { conversationId: 'pi-1', sessionFile: '/secret/pi-1.jsonl' }; },
    async send(input) { calls.push(['send', input]); return { status: 'running' }; },
    observe(cursor) { calls.push(['observe', cursor]); return { events: [{ sequence: cursor + 1, event: { type: 'ready' } }], nextCursor: cursor + 1, gap: false }; },
    async abort(taskId) { calls.push(['abort', taskId]); return { status: 'cancelled' }; },
  };
  return { controller: new OperatorPiHttpController(conversation), calls, conversation };
}

test('REQ-OPERATOR-021: fixed ensure/send/observe/abort API omits the private session file', async () => {
  const f = fixture();
  const ensure = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure', body: bytes({}) });
  assert.equal(ensure.status, 200);
  assert.deepEqual(JSON.parse(ensure.body), { conversationId: 'pi-1', ready: true });
  assert.equal(ensure.body.includes('/secret/'), false);
  const send = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks',
    body: bytes({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'work', mode: 'prompt' }) });
  assert.equal(send.status, 202);
  assert.deepEqual(JSON.parse(send.body), { taskId: 'task-1', status: 'running' });
  const tool = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks',
    body: bytes({ taskId: 'tool-1', digest: 'b'.repeat(64), mode: 'tool', toolName: 'write',
      arguments: { path: '/owned/output.txt', content: 'expected' } }) });
  assert.equal(tool.status, 202);
  assert.deepEqual(JSON.parse(tool.body), { taskId: 'tool-1', status: 'running' });
  const observe = await f.controller.handle({ method: 'GET', pathname: '/internal/operator/pi/events', query: new URLSearchParams('cursor=4') });
  assert.deepEqual(JSON.parse(observe.body), { events: [{ sequence: 5, event: { type: 'ready' } }], nextCursor: 5, gap: false });
  const abort = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks/task-1/abort', body: bytes({}) });
  assert.deepEqual(JSON.parse(abort.body), { taskId: 'task-1', status: 'cancelled' });
  assert.equal([ensure, send, tool, observe, abort].every(result => result.headers['Cache-Control'] === 'no-store'), true);
  assert.deepEqual(f.calls[2], ['send', { taskId: 'tool-1', digest: 'b'.repeat(64), mode: 'tool',
    toolName: 'write', arguments: { path: '/owned/output.txt', content: 'expected' } }]);
});

test('REQ-OPERATOR-021: unknown routes/methods and malformed or oversized requests fail before SDK calls', async () => {
  const f = fixture();
  assert.equal(await f.controller.handle({ method: 'GET', pathname: '/health' }), null);
  assert.equal((await f.controller.handle({ method: 'GET', pathname: '/internal/operator/pi/ensure' })).status, 405);
  assert.equal((await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body: new TextEncoder().encode('{') })).status, 400);
  assert.equal((await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks', body: new Uint8Array(65 * 1024) })).status, 413);
  assert.equal((await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks',
    body: bytes({ taskId: 'tool-1', digest: 'a'.repeat(64), mode: 'tool', toolName: 'write', arguments: [] }) })).status, 400);
  assert.deepEqual(f.calls, []);
});

test('REQ-OPERATOR-021: conflicts are explicit and internal failures are redacted', async () => {
  const f = fixture();
  f.conversation.send = async () => { throw new Error('Pi task conflict /secret/token'); };
  const conflict = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/tasks',
    body: bytes({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'work', mode: 'prompt' }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.includes('/secret/'), false);
  f.conversation.ensure = async () => { throw new Error('disk /secret/token failed'); };
  const failed = await f.controller.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure', body: bytes({}) });
  assert.equal(failed.status, 500);
  assert.deepEqual(JSON.parse(failed.body), { error: 'Structured Pi operation failed', code: 'PI_OPERATION_FAILED' });
});
