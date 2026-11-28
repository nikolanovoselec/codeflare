import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { runHermesShutdownInference } from '../src/hermes-shutdown-inference.ts';
import { shutdownPiMemoryOwners } from '../src/pi-memory-shutdown.ts';
import { mergeAfterFinalSave } from '../../src/container/hermes-shutdown.ts';

const sdkRoot = process.env.OPERATOR_INFERENCE_TEST_SDK_ROOT
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';
const route = { model: 'team-default', reasoning: 'off', contextWindow: 128000 };
const nativeModel = 'gpt-5.4';
const auth = { openai: { type: 'api_key', key: 'synthetic-user-key' } };

function completion(model, answer) {
  const chunk = (delta, finish_reason) => ({ id: 'shutdown-fixture', object: 'chat.completion.chunk',
    created: 0, model, choices: [{ index: 0, delta, finish_reason }] });
  return new Response([chunk({ role: 'assistant', content: answer }, null), chunk({}, 'stop')]
    .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

function nativeCompletion(model, text) {
  const item = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model, output: [item] } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, { drain = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-shutdown-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.pi/extensions'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'FOREGROUND_CONTEXT_MUST_NOT_LEAK');
  await writeFile(join(workspace, '.pi/extensions/side-effect.ts'), 'throw new Error("Do not run user extensions");');
  const owners = join(root, 'owners');
  await mkdir(owners);
  const foreground = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.title = 'pi';
    const receipt = process.argv[1] + '/' + process.pid + '.json';
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    process.on('SIGTERM', () => {
      fs.writeFileSync(process.argv[2], 'final fixture delta');
      fs.unlinkSync(receipt);
      process.exit(0);
    });
    fs.writeFileSync(receipt, JSON.stringify({ pid: process.pid, startTime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19] }));
    process.send('registered');
    setInterval(() => {}, 1000);
  `, owners, join(root, 'active.md')], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (foreground.exitCode === null) foreground.kill('SIGKILL'); });
  const exit = once(foreground, 'exit');
  const [ready] = await Promise.race([once(foreground, 'message', { signal: AbortSignal.timeout(2000) }), exit]);
  assert.equal(ready, 'registered');
  const save = async () => {
    assert.deepEqual(await shutdownPiMemoryOwners(owners, Date.now() + 2000), { status: 'exited', count: 1 });
    assert.deepEqual(await exit, [0, null]);
    const value = await readFile(join(root, 'active.md'), 'utf8');
    assert.equal(value, 'final fixture delta');
    return value;
  };
  const saved = drain ? await save() : undefined;
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: nativeModel }));
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify(auth));
  return { agentDir, foreground, saved, save };
}

for (const model of ['team-default', 'cf-native-12345678-1234-4321-8432-123456789abc']) {
  test(`REQ-ENTERPRISE-100: headless Pi sends the exact managed route ${model} after confirmed save`, async t => {
    const f = await fixture(t, { drain: false });
    let dispatched = false, saved;
    const result = await mergeAfterFinalSave({
      signal: AbortSignal.timeout(5000), finalSyncBudgetMs: 4000, assertCurrent: async () => {},
      forwardExisting: async request => {
        assert.equal(request.url, 'http://localhost/internal/final-sync');
        assert.equal(request.method, 'POST');
        saved = await f.save();
        return Response.json({ synced: true });
      },
      merge: ({ signal }) => runHermesShutdownInference({
      sdkRoot, agentDir: f.agentDir, allowPersonalPiProviders: false, gateway: { ...route, model },
      input: saved, signal,
      send: async (request, init) => {
        assert.equal(f.foreground.exitCode, 0);
        const wire = new Request(request, init);
        assert.equal(wire.url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(wire.method, 'POST');
        assert.equal(wire.headers.get('x-codeflare-exact-model'), '1');
        assert.equal(wire.headers.get('authorization'), 'Bearer codeflare-enterprise');
        const payload = await wire.json();
        assert.equal(payload.model, model);
        assert.ok(!payload.tools?.length, 'the model cannot publish, invoke tools, or read files');
        assert.match(JSON.stringify(payload.messages), /final fixture delta/);
        assert.doesNotMatch(JSON.stringify(payload.messages), /FOREGROUND_CONTEXT_MUST_NOT_LEAK/);
        dispatched = true;
        return completion(model, 'candidate from the selected route');
      },
    }),
    });
    assert.equal(result, 'candidate from the selected route');
    assert.equal(dispatched, true, 'a synthetic provider request actually ran');
  });
}

test('REQ-ENTERPRISE-100: native policy uses the saved Pi default via the existing provider', async t => {
  const f = await fixture(t, { drain: false });
  let endpoint, saved;
  const output = await mergeAfterFinalSave({
    signal: AbortSignal.timeout(5000), finalSyncBudgetMs: 4000, assertCurrent: async () => {},
    forwardExisting: async request => {
      assert.equal(new URL(request.url).pathname, '/internal/final-sync');
      saved = await f.save();
      return Response.json({ synced: true });
    },
    merge: ({ signal }) => runHermesShutdownInference({ sdkRoot, agentDir: f.agentDir, allowPersonalPiProviders: true,
    gateway: route, input: saved, signal,
    send: async (request, init) => {
      const wire = new Request(request, init);
      endpoint = wire.url;
      assert.equal(f.foreground.exitCode, 0);
      assert.equal(wire.url, 'https://api.openai.com/v1/responses');
      assert.equal(wire.headers.get('authorization'), 'Bearer synthetic-user-key');
      const payload = await wire.json();
      assert.equal(payload.model, nativeModel);
      assert.ok(!payload.tools?.length);
      assert.match(JSON.stringify(payload.input), /final fixture delta/);
      return nativeCompletion(nativeModel, 'candidate from native Pi');
    },
  }),
  });
  assert.equal(endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(output, 'candidate from native Pi');
});

test('REQ-ENTERPRISE-100: failed, unconfirmed or superseded saves do not dispatch a merge', async () => {
  for (const [status, synced] of [[504, false], [200, false], [200, null]]) {
    await assert.rejects(mergeAfterFinalSave({
      signal: AbortSignal.timeout(1000), finalSyncBudgetMs: 500, assertCurrent: async () => {},
      forwardExisting: async () => Response.json({ synced }, { status }),
      merge: () => assert.fail('only a confirmed save can dispatch a merge'),
    }), /save not confirmed/i);
  }
  let sameGeneration = true;
  await assert.rejects(mergeAfterFinalSave({
    signal: AbortSignal.timeout(1000), finalSyncBudgetMs: 500,
    assertCurrent: async () => { if (!sameGeneration) throw new Error('generation replaced'); },
    forwardExisting: async () => { sameGeneration = false; return Response.json({ synced: true }); },
    merge: () => assert.fail('a replaced generation cannot dispatch a merge'),
  }), /generation replaced/);
});

test('REQ-ENTERPRISE-100: rejected native authentication does not substitute the configured Gateway', async t => {
  const f = await fixture(t);
  const endpoints = [];
  await assert.rejects(runHermesShutdownInference({ sdkRoot, agentDir: f.agentDir, allowPersonalPiProviders: true,
    gateway: route, input: 'No provider fallback', signal: AbortSignal.timeout(5000),
    send: async (request, init) => {
      endpoints.push(new Request(request, init).url);
      return Response.json({ error: { code: 'invalid_api_key', message: 'synthetic authentication failure' } }, { status: 401 });
    },
  }), /inference failed/i);
  assert.deepEqual(endpoints, ['https://api.openai.com/v1/responses']);
});

test('REQ-ENTERPRISE-100: a response received after cancellation does not become a candidate', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let dispatched = false;
  await assert.rejects(runHermesShutdownInference({ sdkRoot, agentDir: f.agentDir, allowPersonalPiProviders: false,
    gateway: route, input: f.saved, signal: controller.signal,
    send: async () => {
      dispatched = true;
      controller.abort(new Error('shutdown attempt cancelled'));
      return completion(route.model, 'must not be returned');
    },
  }), /shutdown attempt cancelled/);
  assert.ok(dispatched);
});

test('REQ-ENTERPRISE-100: cancellation returns no candidate and makes no provider call', async t => {
  const f = await fixture(t);
  await assert.rejects(runHermesShutdownInference({
    sdkRoot, agentDir: f.agentDir, allowPersonalPiProviders: false, gateway: route, input: 'fixed merge delta',
    signal: AbortSignal.abort(new Error('shutdown attempt cancelled')),
    send: async () => assert.fail('a cancelled attempt must not dispatch'),
  }), /cancelled|abort/i);
});
