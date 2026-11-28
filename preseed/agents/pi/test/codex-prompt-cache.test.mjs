import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';

function packageRoot(name, from) {
  // Pi exports are ESM-only, so require.resolve(name) cannot locate its entry point.
  return createRequire(from).resolve.paths(name).map(path => join(path, name))
    .find(path => existsSync(join(path, 'package.json')));
}
function installedRoot() {
  if (process.env.CODEFLARE_PI_PACKAGE_ROOT) return resolve(process.env.CODEFLARE_PI_PACKAGE_ROOT);
  const local = packageRoot('@earendil-works/pi-coding-agent', import.meta.url);
  if (local) return local;
  const imageRoot = '/opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent';
  assert.ok(existsSync(join(imageRoot, 'package.json')), 'Install locked preseed dependencies or supply CODEFLARE_PI_PACKAGE_ROOT');
  return imageRoot;
}
const installed = installedRoot();
const installedAI = packageRoot('@earendil-works/pi-ai', join(installed, 'package.json'));
assert.ok(installedAI, 'The coding-agent package must resolve its pi-ai dependency');
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const versionOf = root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
assert.equal(versionOf(installed), lock.packages['node_modules/@earendil-works/pi-coding-agent'].version);
assert.equal(versionOf(installedAI), lock.packages['node_modules/@earendil-works/pi-ai'].version);
const chunks = join(installed, 'dist/bundle/chunks');
const codexChunks = readdirSync(chunks).filter(name => /^openai-codex-responses-[A-Z0-9]+\.js$/.test(name));
assert.equal(codexChunks.length, 1, 'Expected one packaged Codex provider chunk');

const model = { id: 'gpt-6.2-sol', name: 'Synthetic Codex', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://offline.invalid/backend-api', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const apiKey = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })).toString('base64url')}.synthetic`;
const user = text => ({ role: 'user', content: text, timestamp: 0 });
const system = content => ({ role: 'system', content, timestamp: 0 });
const developer = { role: 'developer', content: 'Reusable system prefix.' };
const userInput = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const options = { apiKey, sessionId: 'codex-offline-session', textVerbosity: 'high', temperature: 0.4,
  reasoningEffort: 'low', reasoningSummary: 'concise', serviceTier: 'priority', toolChoice: 'none', maxRetries: 0 };
function responseEvents(id = 'resp_1', text = 'Synthetic answer.') {
  const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: {
      input_tokens: 23, output_tokens: 5, total_tokens: 28, input_tokens_details: { cached_tokens: 17 } } } },
  ];
}
function assertOptions(body) {
  assert.equal(Object.hasOwn(body, 'instructions'), false);
  assert.equal(body.model, model.id);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.prompt_cache_key, options.sessionId);
  assert.deepEqual(body.text, { verbosity: 'high' });
  assert.deepEqual(body.reasoning, { effort: 'low', summary: 'concise' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.service_tier, 'priority');
  assert.equal(body.tool_choice, 'none');
  assert.equal(body.parallel_tool_calls, true);
}
async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  const output = await stream.result();
  assert.equal(output.stopReason, 'stop', output.errorMessage);
  assert.equal(output.content[0].text, 'Synthetic answer.');
  assert.equal(output.usage.cacheRead, 17);
  assert.equal(events.find(event => event.type === 'text_delta')?.delta, 'Synthetic answer.');
  assert.equal(events.at(-1).type, 'done');
  return output;
}
async function loadProvider(kind) {
  return import(pathToFileURL(kind === 'library' ? join(installedAI, 'dist/api/openai-codex-responses.js') : join(chunks, codexChunks[0])).href);
}

for (const kind of ['library', 'bundle']) {
  test(`REQ-AGENT-238: ${kind} HTTP completion sends cacheable developer input and preserves request options`, { timeout: 15_000 }, async () => {
    const provider = await loadProvider(kind);
    for (const systemPrompt of [developer.content, '', undefined]) {
      let captured;
      const output = await collect(provider.stream(model, { messages: [...(systemPrompt === undefined ? [] : [system(systemPrompt)]), user('Hello')] }, {
        ...options, transport: 'sse', headers: { 'x-synthetic': 'retained' },
        fetch: async (url, init) => {
          assert.equal(String(url), `${model.baseUrl}/codex/responses`);
          assert.equal(init.headers.get('x-synthetic'), 'retained');
          assert.equal(init.headers.get('authorization'), `Bearer ${apiKey}`);
          const bytes = init.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
          captured = JSON.parse(bytes.toString());
          return new Response(responseEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } });
        },
      }));
      assert.equal(output.responseId, 'resp_1');
      assertOptions(captured);
      assert.deepEqual(captured.input, systemPrompt ? [developer, userInput('Hello')] : [userInput('Hello')]);
    }
  });

  test(`REQ-AGENT-238: ${kind} WebSocket continuation sends only delta and reconnect restores developer prefix`, { timeout: 15_000 }, async t => {
    const provider = await loadProvider(kind);
    const sent = [];
    const sockets = [];
    const oldWebSocket = globalThis.WebSocket;
    class SyntheticWebSocket extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
      }
      send(data) {
        const body = JSON.parse(data);
        sent.push(body);
        const n = sent.length;
        // A lost continuation on a still-open connection forces the provider's full reconnect path.
        const events = n === 3 ? [{ type: 'error', code: 'previous_response_not_found', message: 'Synthetic expired response' }] : responseEvents(`resp_${n}`);
        setTimeout(() => {
          for (const event of events) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
        }, 0);
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    globalThis.WebSocket = SyntheticWebSocket;
    t.after(() => { provider.closeOpenAICodexWebSocketSessions(); globalThis.WebSocket = oldWebSocket; });
    const requestOptions = { ...options, transport: 'websocket-cached', fetch: async () => { throw new Error('Unexpected HTTP fallback'); } };
    const context = { messages: [system(developer.content), user('Hello')] };
    const first = await collect(provider.stream(model, context, requestOptions));
    context.messages.push(first, user('Continue'));
    const second = await collect(provider.stream(model, context, requestOptions));
    context.messages.push(second, user('Finish'));
    const third = await collect(provider.stream(model, context, requestOptions));
    assert.equal(third.responseId, 'resp_4');
    assert.equal(sockets.length, 2, 'Expired continuation reconnects rather than silently falling back to HTTP');
    assert.equal(sent.length, 4);
    for (const body of sent) { assertOptions(body); assert.equal(body.type, 'response.create'); }
    assert.deepEqual(sent[0].input, [developer, userInput('Hello')]);
    assert.equal(sent[0].previous_response_id, undefined);
    assert.deepEqual(sent[1].input, [userInput('Continue')]);
    assert.equal(sent[1].previous_response_id, 'resp_1');
    assert.deepEqual(sent[2].input, [userInput('Finish')]);
    assert.equal(sent[2].previous_response_id, 'resp_2');
    assert.equal(sent[3].previous_response_id, undefined);
    assert.equal(sent[3].input.length, 6);
    assert.deepEqual(sent[3].input[0], developer);
    assert.deepEqual(sent[3].input.at(-1), userInput('Finish'));
    assert.deepEqual(sent[3].input.filter(item => item.role === 'assistant').map(item => item.content[0].text),
      ['Synthetic answer.', 'Synthetic answer.']);
  });
}
