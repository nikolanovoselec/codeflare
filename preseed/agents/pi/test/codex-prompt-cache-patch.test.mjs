import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';

const script = fileURLToPath(new URL('../../../../scripts/patch-pi-codex-prompt-cache.mjs', import.meta.url));
const patcher = () => import(pathToFileURL(script).href);
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
const source = 'dist/api/openai-codex-responses.js';
const bundle = 'dist/bundle/chunks/openai-codex-responses-TEQRB65N.js';
const receiptName = '.codeflare-codex-prompt-cache-backport.json';
const commit = 'f7d9657ce20eb6e660d90a46fa235270abd04010';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function copyPackage(t, runtime = false) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-codex-backport-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const scope = join(temp, 'node_modules/@earendil-works');
  const root = join(scope, 'pi-coding-agent');
  const ai = join(scope, 'pi-ai');
  for (const [from, to, files] of [
    [installed, root, runtime ? ['package.json', 'dist/bundle/chunks'] : ['package.json', bundle]],
    [installedAI, ai, runtime ? ['package.json', 'dist'] : ['package.json', source]],
  ]) for (const file of files) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    cpSync(join(from, file), join(to, file), { recursive: true });
  }
  if (runtime) {
    // Real dependencies remain read-only; only our two disposable packages are copied.
    const modules = dirname(dirname(installed));
    for (const entry of readdirSync(modules)) {
      if (entry === '@earendil-works') continue;
      symlinkSync(join(modules, entry), join(temp, 'node_modules', entry));
    }
    for (const entry of readdirSync(join(modules, '@earendil-works'))) {
      if (['pi-ai', 'pi-coding-agent'].includes(entry)) continue;
      symlinkSync(join(modules, '@earendil-works', entry), join(scope, entry));
    }
  }
  return { root, ai, temp };
}
function snapshot({ root, ai }) {
  return [join(root, 'package.json'), join(ai, 'package.json'), join(ai, source), join(root, bundle), join(root, receiptName)]
    .map(path => existsSync(path) ? readFileSync(path, 'utf8') : null);
}
function assertRejectedUnchanged(fixture, operation, pattern) {
  const before = snapshot(fixture);
  assert.throws(operation, pattern);
  assert.deepEqual(snapshot(fixture), before, 'Rejected admission must not change either artifact or receipt');
}
function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

// Explicit artifact-integrity fixture: model the upstream PR, independent of the patcher's API.
function upstreamFixed({ root, ai }) {
  const path = join(ai, source);
  writeFileSync(path, readFileSync(path, 'utf8')
    .replace('        includeSystemPrompt: false,\n', '')
    .replace('    const initialSystemMessage = getInitialSystemMessage(context.messages);\n    const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";\n', '')
    .replace('        instructions: instructions || "You are a helpful assistant.",\n', ''));
  const bundled = join(root, bundle);
  writeFileSync(bundled, readFileSync(bundled, 'utf8')
    .replace('{includeSystemPrompt:!1,grammarToolInputProperties,supportsMidConvoSystemMessages:', '{grammarToolInputProperties,supportsMidConvoSystemMessages:')
    .replace('initialSystemMessage=getInitialSystemMessage(context.messages),instructions=initialSystemMessage?getSystemMessageText(initialSystemMessage):"",body=', 'body=')
    .replace('instructions:instructions||"You are a helpful assistant.",', ''));
}

test('REQ-AGENT-238: pristine necessity gate validates the actual lock-matched Pi packages without writes', async () => {
  const { verifyPiCodexPatchRequired } = await patcher();
  assert.equal(manifest(installed).version, lock.packages['node_modules/@earendil-works/pi-coding-agent'].version);
  assert.equal(manifest(installedAI).version, lock.packages['node_modules/@earendil-works/pi-ai'].version);
  const fixture = { root: installed, ai: installedAI };
  const before = snapshot(fixture);
  verifyPiCodexPatchRequired(installed);
  const checked = cli('--check-pristine', installed);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(snapshot(fixture), before);
});

test('REQ-AGENT-238: owned receipt permits exact repeat preparation but never pristine admission', async t => {
  const { patchPiCodexPromptCache, verifyPiCodexPatchRequired } = await patcher();
  const fixture = copyPackage(t);
  const before = snapshot(fixture);
  patchPiCodexPromptCache(fixture.root);
  const after = snapshot(fixture);
  assert.notEqual(after[2], before[2]);
  assert.notEqual(after[3], before[3]);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'Package manifests stay untouched');
  // Intentional artifact-integrity contract: exactly the reviewed upstream PR diff,
  // including retaining includeSystemPrompt:false in WS bookkeeping, and no other edits.
  assert.deepEqual(after.slice(2, 4).map(sha256), [
    'fc011fbb0b1c06c37b0832a0ae3cd0b5c94a0b5bf360248700100ce719726d0c',
    'b79e38279b11e67699e4bbbe9c93f3101eabf8eba7dc0f56311e7840c51d3cd5',
  ]);
  const receipt = JSON.parse(after[4]);
  assert.equal(receipt.upstreamCommit, commit);
  assert.equal(receipt.version, '1.5.2');
  assert.deepEqual(receipt.files, [
    { package: '@earendil-works/pi-ai', path: source, originalSha256: sha256(before[2]), patchedSha256: sha256(after[2]) },
    { package: '@earendil-works/pi-coding-agent', path: bundle, originalSha256: sha256(before[3]), patchedSha256: sha256(after[3]) },
  ]);
  patchPiCodexPromptCache(fixture.root);
  assert.equal(cli(fixture.root).status, 0);
  assert.deepEqual(snapshot(fixture), after);
  assertRejectedUnchanged(fixture, () => verifyPiCodexPatchRequired(fixture.root), /pristine|already|obsolete/i);
  const checked = cli('--check-pristine', fixture.root);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /pristine|already|obsolete/i);
});

for (const futureVersion of [false, true]) {
  test(`REQ-AGENT-238: raw ${futureVersion ? 'future upstream' : 'unowned fixed'} packages demand removal of the obsolete backport`, async t => {
    const { patchPiCodexPromptCache, verifyPiCodexPatchRequired } = await patcher();
    const fixture = copyPackage(t);
    upstreamFixed(fixture);
    if (futureVersion) for (const root of [fixture.root, fixture.ai]) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest(root), version: '99.0.0' }));
    }
    for (const operation of [patchPiCodexPromptCache, verifyPiCodexPatchRequired]) {
      assertRejectedUnchanged(fixture, () => operation(fixture.root), /remove.*obsolete.*backport/i);
    }
  });
}

for (const damage of ['agent version', 'ai version', 'agent name', 'ai name', 'source bytes', 'bundle bytes', 'partial', 'malformed receipt', 'foreign receipt', 'receipt on pristine', 'receipt identity', 'patched source drift', 'patched bundle drift']) {
  test(`REQ-AGENT-238: rejects ${damage} before writing any package`, async t => {
    const { patchPiCodexPromptCache, verifyPiCodexPatchRequired } = await patcher();
    const fixture = copyPackage(t);
    if (damage.includes('version') || damage.includes('name')) {
      const root = damage.startsWith('ai') ? fixture.ai : fixture.root;
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest(root),
        ...(damage.endsWith('version') ? { version: '99.0.0' } : { name: 'unrelated-package' }) }));
    } else if (['source bytes', 'bundle bytes'].includes(damage)) {
      const path = damage === 'source bytes' ? join(fixture.ai, source) : join(fixture.root, bundle);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// unknown drift\n`);
    } else if (damage === 'malformed receipt' || damage === 'foreign receipt') {
      writeFileSync(join(fixture.root, receiptName), damage === 'malformed receipt' ? '{' : JSON.stringify({ owner: 'some-other-patch' }));
    } else {
      const before = snapshot(fixture);
      patchPiCodexPromptCache(fixture.root);
      if (damage === 'partial' || damage === 'receipt on pristine') writeFileSync(join(fixture.root, bundle), before[3]);
      if (damage === 'receipt on pristine') writeFileSync(join(fixture.ai, source), before[2]);
      if (damage === 'receipt identity') {
        const path = join(fixture.root, receiptName);
        const receipt = JSON.parse(readFileSync(path, 'utf8'));
        receipt.files[0].patchedSha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(receipt));
      }
      if (damage.startsWith('patched')) {
        const path = damage === 'patched source drift' ? join(fixture.ai, source) : join(fixture.root, bundle);
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n// unowned edit\n`);
      }
    }
    for (const operation of [patchPiCodexPromptCache, verifyPiCodexPatchRequired]) {
      assertRejectedUnchanged(fixture, () => operation(fixture.root), /drift|receipt|partial|requires|unsupported|pristine|obsolete/i);
    }
  });
}

test('REQ-AGENT-238: interrupted unreceipted preparation cannot be adopted', async t => {
  const { patchPiCodexPromptCache } = await patcher();
  const fixture = copyPackage(t);
  const before = snapshot(fixture);
  patchPiCodexPromptCache(fixture.root);
  rmSync(join(fixture.root, receiptName));
  writeFileSync(join(fixture.root, bundle), before[3]);
  assertRejectedUnchanged(fixture, () => patchPiCodexPromptCache(fixture.root), /partial|drift|obsolete/i);
});

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
async function loadProvider(fixture, kind) {
  return import(pathToFileURL(kind === 'library' ? join(fixture.ai, source) : join(fixture.root, bundle)).href);
}

for (const kind of ['library', 'bundle']) {
  test(`REQ-AGENT-238: ${kind} HTTP completion sends cacheable developer input and preserves request options`, { timeout: 15_000 }, async t => {
    const { patchPiCodexPromptCache } = await patcher();
    const fixture = copyPackage(t, true);
    patchPiCodexPromptCache(fixture.root);
    const provider = await loadProvider(fixture, kind);
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
    const { patchPiCodexPromptCache } = await patcher();
    const fixture = copyPackage(t, true);
    patchPiCodexPromptCache(fixture.root);
    const provider = await loadProvider(fixture, kind);
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
