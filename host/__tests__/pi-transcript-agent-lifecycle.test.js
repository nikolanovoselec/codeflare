import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fixture, lifecycle, jsonl, assertTrimWindow } from './fixtures/pi-transcript-agent-fixture.mjs';

test('REQ-MEM-030 AC1: visible scoped launch is idempotent and cancelled with the parent session', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled');
  const item = l.launch(); assert.equal(item.request.subagent_type, 'transcript-trim');
  for (const key of ['model', 'thinking', 'max_turns']) assert.equal(item.request[key], undefined);
  l.emit('agent_settled'); assert.equal(l.sent.length, 1);
  const varsFile = item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]; assert.ok(fs.existsSync(varsFile));
  l.emit('session_before_switch'); assert.equal(fs.existsSync(varsFile), false);
  assert.ok(fs.statSync(f.file).size > 50_000_000);
  f.rows.splice(1); fs.writeFileSync(f.file, jsonl(f.rows));
  l.emit('session_start'); l.due(); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').flatMap(m => m.details.items).filter(i => i.jobType === 'transcript-trim').length, 1);
  assert.ok(fs.statSync(f.file).size < 50_000_000);
});
test('REQ-MEM-030 AC1: shared owner revokes scoped activation on fork shutdown restart and aborted boundaries', async t => {
  for (const event of ['session_before_switch', 'session_before_fork', 'session_shutdown', 'session_start', 'turn_end', 'agent_settled']) {
    const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
    const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
    const before = fs.readFileSync(f.file);
    l.emit(event, event === 'turn_end' ? { outcome: 'aborted' } : { aborted: true });
    assert.equal(fs.existsSync(req.directory), false, event);
    const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
    await assert.rejects(l.tools.get('transcript_trim').execute('revoked', { operation: 'trim' }, undefined, undefined, child));
    l.emit('agent_settled'); assert.equal(l.launch(), item, event);
    assert.ok(fs.readFileSync(f.file).subarray(0, before.length).equals(before), event);
    assert.ok(fs.statSync(f.file).size > 50_000_000);
  }
});
test('REQ-MEM-030 AC2: staged candidate and exact native Done alone never activate parent history', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  l.call(item); l.done({ requestId: 'foreign' }); l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  const beforeDone = fs.readFileSync(f.file);
  l.done(item); l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  assert.ok(fs.readFileSync(f.file).subarray(0, beforeDone.length).equals(beforeDone));
  assert.equal(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'), false);
});
test('REQ-MEM-030 AC6: native failures reuse scoped requests through common extraction reminders', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  l.call(item); l.done(item, 'Failed'); l.emit('agent_settled'); const retry = l.launch();
  assert.equal(retry.requestId, item.requestId); assert.deepEqual(retry.request, item.request);
  assert.equal(retry.reminder, 1); assert.equal(item.reminder, 0);
  l.emit('agent_settled'); assert.equal(l.launch(), retry);
  l.call(retry); l.done(retry, 'Stopped'); l.emit('agent_settled');
  const reqPath = item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1];
  assert.equal(fs.existsSync(reqPath), false);
  l.emit('agent_settled'); assert.equal(l.launch(), retry);
  assert.ok(fs.statSync(f.file).size > 50_000_000);
});
test('REQ-MEM-030 AC1: due maintenance launches at a normal boundary and scoped trim activates despite queued work', async t => {
  const f = fixture(t), l = lifecycle(f, true); l.due();
  for (const stopReason of ['toolUse', 'length', 'aborted', 'error']) l.emit('turn_end', { message: { role: 'assistant', stopReason, content: [] } });
  l.emit('turn_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'unfinished', name: 'read', arguments: {} }] } });
  assert.equal(l.launch(), undefined);
  const boundary = { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Ordinary turn completed; more user or Goal work is queued.' }] } };
  l.emit('turn_end', boundary); const item = l.launch(); assert.ok(item);
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  // Native follow-up delivery can remain queued across further boundaries. It must not duplicate.
  l.emit('turn_end', boundary); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').length, 1);
  l.append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [item] } });
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  const result = JSON.parse((await l.tools.get('transcript_trim').execute('queued', { operation: 'trim' }, undefined, undefined, child)).content[0].text);
  assert.equal(result.committed, true);
  assertTrimWindow(fs.statSync(f.file).size);
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
  l.emit('turn_end', boundary); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').length, 1);
});
