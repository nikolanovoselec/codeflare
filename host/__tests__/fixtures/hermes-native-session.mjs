// Isolated CI worker. Import only public SDK entry points and the Codeflare
// helper seam. Never import upstream's private stores/handlers or Pi's loader.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { importPiExtension } from './pi-extension-module.mjs';

const [scenario, home, repo] = process.argv.slice(2);
const deps = join(repo, 'preseed/agents/pi/node_modules');
const agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
const memoryDir = join(home, 'Vault/Memory'), workspaceMemoryDir = join(memoryDir, 'Projects/workspace');
const paths = { user: join(memoryDir, 'USER.md'), global: join(memoryDir, 'MEMORY.md'),
  workspace: join(workspaceMemoryDir, 'MEMORY.md'), lesson: join(memoryDir, 'failures.md') };
const facts = JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8'));
const markdown = () => Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(path, 'utf8')]));
const put = (key, value) => writeFileSync(paths[key], value);
const text = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
const wireText = body => body.messages.map(text).join('\n');
async function until(predicate, description) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

// Fail before invoking stock if CI ignored better-sqlite3's install script or
// supplied the wrong ABI. This also prevents upstream's ABI-repair path from
// trying a runtime npm rebuild. The real binding must execute a SQL query.
const requireStock = createRequire(join(deps, 'pi-hermes-memory/package.json'));
const Database = requireStock('better-sqlite3');
const native = new Database(':memory:');
assert.equal(native.prepare('SELECT 6 * 7 AS answer').get().answer, 42);
native.close();
const sdk = await import(pathToFileURL(join(deps, '@earendil-works/pi-coding-agent/dist/index.js')).href);
sdk.initTheme();
const { default: stock } = await import(pathToFileURL(join(home, 'stock.mjs')).href);
const { attachHermesMemoryToForeground, registerHermesMemoryContext } = await importPiExtension('hermes-memory-runtime');
const registry = {}, errors = [], requests = [], sessions = [], primaryMemoryWrites = [];
let sequence = 0, reviewSaved = false, correctionSaved = false;
let contextPhase = 'ordinary', contextReply = 0;
let childMode = false;

function completion(content) {
  const chunk = (delta, finish_reason) => ({ id: 'hermes-fixture-completion', object: 'chat.completion.chunk',
    created: 0, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
  return new Response([chunk({ role: 'assistant', content }, null), chunk({}, 'stop')]
    .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
}
const providerFailures = [];
globalThis.fetch = async (input, init) => {
  try {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, 'https://hermes-fixture.invalid', 'external model/network access forbidden');
    assert.equal(url.pathname, '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-hermes-key');
    const body = await request.json();
    requests.push(body);
    assert.equal(body.model, 'fixture');
    assert.equal(body.stream, true);
    if (['cold', 'warm', 'recall'].includes(scenario)) assert.fail('eager rebuild/search must not call a provider');
    const lastUser = text(body.messages.findLast(message => message.role === 'user') ?? {});
    if (lastUser.includes('--- User Correction to Save ---')) {
      assert.equal(childMode, false, 'helper prompts cannot start correction extraction');
      assert.ok(lastUser.includes(facts.user), 'correction review receives the existing fact');
      assert.ok(lastUser.includes(facts.corrected), 'correction review receives the genuine new preference');
      return completion(JSON.stringify({ operations: [{ action: 'replace', target: 'user', old_text: facts.user, content: facts.corrected }] }));
    }
    if (lastUser.includes('--- Conversation to Review ---')) {
      assert.equal(childMode, false, 'helper prompts cannot start automatic review');
      assert.equal(scenario, 'capture');
      for (const key of ['user', 'global', 'workspace', 'lesson']) assert.ok(lastUser.includes(facts[key]), `review payload contains ${key} evidence`);
      assert.equal(body.tools?.length ?? 0, 0, 'direct review is a side-channel completion, not primary tool dispatch');
      return completion(JSON.stringify({ operations: [
        { action: 'add', target: 'user', content: facts.user },
        { action: 'add', target: 'memory', content: facts.global },
        { action: 'add', target: 'project', content: facts.workspace },
        { action: 'add', target: 'failure', content: facts.lesson, category: 'failure' },
      ] }));
    }
    if (scenario === 'context') {
      if (contextPhase === 'overflow') {
        contextPhase = 'summary';
        return Response.json({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }, { status: 400 });
      }
      if (contextPhase === 'summary') {
        assert.ok(wireText(body).includes('HERMES_TASK_EVIDENCE'), 'real compaction receives the conversation to summarize');
        put('user', facts.corrected);
        contextPhase = 'retry';
        return completion('The user requested HERMES_TASK_EVIDENCE analysis. Continue the unfinished analysis.');
      }
      if (contextPhase === 'retry') {
        assertReference(body, facts.corrected, facts.user);
        assert.ok(wireText(body).includes('Continue the unfinished analysis'), 'the retry uses the real compaction summary');
        contextPhase = 'finished';
      }
      // Enough real history for compaction, without faking session internals.
      return completion(`HERMES_TASK_EVIDENCE response ${++contextReply}: ` + 'calibration detail '.repeat(160));
    }
    // The foreground model only emits text. The stock reviewer parses its own
    // separate wire completion and performs all file/SQLite mutations itself.
    return completion(`Foreground fixture acknowledgement ${++sequence}.`);
  } catch (error) {
    providerFailures.push(error);
    throw error;
  }
};

function assertReference(body, currentUser, staleUser) {
  for (const fact of [currentUser, facts.global, facts.workspace]) {
    const carrying = body.messages.filter(message => text(message).includes(fact));
    assert.equal(carrying.length, 1, `exactly one outbound reference for ${fact}`);
    assert.equal(carrying[0].role, 'user', 'public Pi serializer turns custom reference data into user-role content, never system authority');
    assert.equal(text(carrying[0]).split(fact).length - 1, 1);
  }
  if (staleUser) assert.ok(!wireText(body).includes(staleUser), 'stale snapshot absent from outbound context');
  assert.ok(!body.messages.filter(message => message.role === 'system').some(message => text(message).includes(currentUser)));
}

async function start({ parentSession, context = false } = {}) {
  let loader, queryResult;
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], cacheWarming: 'off',
    compaction: { enabled: context, reserveTokens: 256, keepRecentTokens: 256 }, retry: { enabled: false } });
  loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [async pi => {
      await attachHermesMemoryToForeground(registry, pi, stock);
      if (context || parentSession) registerHermesMemoryContext(pi, { memoryDir, workspaceMemoryDir });
    }, pi => {
      pi.on('tool_call', event => {
        if (['memory_add', 'memory_replace', 'memory_remove'].includes(event.toolName)) {
          primaryMemoryWrites.push(event.toolName);
          return { block: true, reason: 'This qualification permits no primary memory writes' };
        }
      });
      pi.registerCommand('hermes-native-search', {
        description: 'CI-only direct invocation of the real stock read-only definition',
        async handler(args, ctx) {
          // getExtensions() is the public ResourceLoader snapshot. This is NOT
          // model-issued dispatch; it proves zero-provider native search.
          const definitions = loader.getExtensions().extensions.map(extension => extension.tools.get('memory_search')).filter(Boolean);
          assert.equal(definitions.length, 1);
          queryResult = await definitions[0].definition.execute('hermes-native-search', JSON.parse(args), undefined, undefined, ctx);
        },
      });
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') });
  modelRuntime.registerProvider('hermes-fixture', { baseUrl: 'https://hermes-fixture.invalid/v1', api: 'openai-completions',
    apiKey: 'synthetic-hermes-key', models: [{ id: 'fixture', name: 'Hermes qualification', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }] });
  const model = modelRuntime.getModel('hermes-fixture', 'fixture');
  assert.ok(model);
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime, model,
    sessionManager: sdk.SessionManager.inMemory(cwd, parentSession ? { parentSession } : undefined), noTools: 'builtin' });
  sessions.push(session);
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  return {
    session,
    async search(args) {
      queryResult = undefined;
      await session.prompt(`/hermes-native-search ${JSON.stringify(args)}`);
      assert.ok(queryResult, 'public command executed actual stock search');
      assert.equal(queryResult.isError ?? false, false);
      assert.equal(queryResult.details.success, true, JSON.stringify(queryResult));
      return queryResult;
    },
  };
}
const databasePath = join(home, '.cache/pi-hermes-memory/global/sessions.db');
function openDatabase() {
  assert.ok(existsSync(databasePath), 'eager initialization produced the native database');
  const db = new Database(databasePath, { fileMustExist: true });
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  return db;
}
async function promptText(f, prompt) {
  await f.session.prompt(prompt);
  const last = f.session.messages.findLast(message => message.role === 'assistant');
  assert.ok(last, 'the real SDK persists the wire completion');
  assert.equal(last.stopReason, 'stop', JSON.stringify(last));
  assert.match(text(last), scenario === 'context' ? /^HERMES_TASK_EVIDENCE response \d+:/ : /^Foreground fixture acknowledgement \d+\.$/);
}
async function verifySearch(f, { corrected = false } = {}) {
  let matches = 0;
  for (const [key, target] of [['user', 'user'], ['global', 'memory'], ['workspace', 'project'], ['lesson', 'failure']]) {
    const fact = key === 'user' && corrected ? facts.corrected : facts[key];
    const result = await f.search({ query: fact.split(' ')[0].replace(':', ''), target, ...(target === 'project' ? { project: 'workspace' } : {}) });
    assert.equal(result.details.count, 1, JSON.stringify(result));
    assert.ok(result.details.output.includes(fact));
    assert.ok(result.details.output.includes(target === 'project' ? 'scope=project:workspace' : 'scope=global') || target === 'failure');
    matches++;
  }
  const missing = await f.search({ query: facts.excluded.split(' ')[0] });
  assert.equal(missing.details.count, 0, 'unrelated clone facts are not imported');
  return { matches, excludedMatches: missing.details.count };
}

async function run() {
  if (scenario === 'capture') {
    const f = await start();
    for (const name of ['memory_search', 'memory_add', 'memory_replace']) assert.ok(f.session.getActiveToolNames().includes(name));
    await promptText(f, `For this observatory work: ${facts.user}`);
    await promptText(f, `The calibration reference is: ${facts.global}`);
    await promptText(f, `The current shared workspace uses: ${facts.workspace} Prior import finding: ${facts.lesson}`);
    await until(() => Object.keys(paths).every(key => markdown()[key].includes(facts[key])), 'background review to save all four genuine facts');
    reviewSaved = true;
    await verifySearch(f);
    await promptText(f, `Actually, use this preference instead: ${facts.corrected}`);
    await until(() => markdown().user.includes(facts.corrected) && !markdown().user.includes(facts.user), 'stock correction replacement');
    correctionSaved = true;
    assert.deepEqual(primaryMemoryWrites, []);
    assert.ok(!f.session.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')),
      'no primary model tool call can account for the durable writes');
    const before = markdown();
    const helper = await start({ parentSession: join(agentDir, 'sessions/root.jsonl') });
    childMode = true;
    assert.equal(helper.session.getActiveToolNames().some(name => name.startsWith('memory_')), false);
    for (let i = 0; i < 4; i++) await promptText(helper, `Helper review task ${i}. Do not learn this task as user facts. ${facts.excluded}`);
    const helperBodies = requests.slice(-4);
    for (const body of helperBodies) for (const key of ['corrected', 'global', 'workspace']) assert.ok(!wireText(body).includes(facts[key]));
    assert.deepEqual(markdown(), before);
    return { reviewSaved, correctionSaved, primaryMemoryWrites, childHasMemoryTools: false, childLeakedContext: false, childChangedMarkdown: false };
  }
  if (scenario === 'context') {
    const f = await start({ context: true });
    await promptText(f, 'HERMES_TASK_EVIDENCE: analyze the calibration procedure.');
    assertReference(requests.at(-1), facts.user);
    // Edit canonical data, not the SDK state or the integration's context.
    put('user', facts.corrected);
    await promptText(f, 'HERMES_TASK_EVIDENCE: continue the ordinary analysis.');
    assertReference(requests.at(-1), facts.corrected, facts.user);
    const beforeUserTurns = f.session.messages.filter(message => message.role === 'user').length;
    let compactionFinished = false;
    const unsubscribe = f.session.subscribe(event => {
      if (event.type === 'auto_compaction_end') {
        assert.equal(event.aborted, false);
        compactionFinished = true;
      }
    });
    // Revert on disk, then correct DURING the actual summary request. The
    // automatic retry must read the correction without any further prompt.
    put('user', facts.user);
    contextPhase = 'overflow';
    await promptText(f, 'HERMES_TASK_EVIDENCE: finish the interrupted analysis.');
    unsubscribe();
    assert.equal(contextPhase, 'finished');
    assert.equal(compactionFinished, true);
    assert.ok(f.session.sessionManager.getEntries().some(entry => entry.type === 'compaction'), 'real SDK recorded compaction');
    assert.ok(f.session.messages.filter(message => message.role === 'user').length <= beforeUserTurns + 1,
      'automatic continuation required no new user prompt');
    const persistedReferenceCopies = f.session.sessionManager.getEntries().filter(entry => entry.type === 'message'
      && [facts.user, facts.corrected, facts.global, facts.workspace].some(fact => text(entry.message).includes(fact))).length;
    assert.equal(persistedReferenceCopies, 0, 'request-local custom memory is not persisted to the session tree');
    return { freshFirstAndNext: true, compactedAndRetried: true, persistedReferenceCopies };
  }
  assert.ok(['cold', 'warm', 'recall'].includes(scenario));
  if (scenario === 'cold') assert.equal(existsSync(databasePath), false, 'fixture begins with canonical Markdown only');
  const f = await start();
  const result = await verifySearch(f, { corrected: scenario === 'recall' });
  const db = openDatabase();
  try {
    const excluded = db.prepare('SELECT count(*) AS count FROM messages WHERE content LIKE ?').get(`%${facts.excluded}%`);
    assert.equal(excluded.count, 0, 'historical transcript backfill remains disabled');
    const rows = db.prepare('SELECT target, project, content FROM memories').all();
    for (const key of ['global', 'workspace', 'lesson']) assert.ok(rows.some(row => row.content.includes(facts[key])));
    if (scenario === 'cold') {
      // A fixture-owned marker proves reopening reuses the existing native
      // database rather than rebuilding a lookalike with the same facts.
      db.exec('CREATE TABLE hermes_native_warm_marker (value TEXT NOT NULL)');
      db.prepare('INSERT INTO hermes_native_warm_marker VALUES (?)').run(facts.global);
      writeFileSync(join(home, 'warm-inode.json'), JSON.stringify({ ino: statSync(databasePath).ino }));
    }
    if (scenario === 'warm') {
      assert.equal(statSync(databasePath).ino, JSON.parse(readFileSync(join(home, 'warm-inode.json'), 'utf8')).ino);
      assert.equal(db.prepare('SELECT value FROM hermes_native_warm_marker').get().value, facts.global);
    }
  } finally { db.close(); }
  assert.equal(requests.length, 0);
  return { ...result, providerRequests: requests.length, reusedNativeDatabase: scenario === 'warm', recalledCorrection: scenario === 'recall' };
}

try {
  const result = await run();
  assert.deepEqual(providerFailures, []);
  assert.deepEqual(errors, []);
  console.log(`HERMES_NATIVE_RESULT=${JSON.stringify(result)}`);
  for (const session of sessions) session.dispose();
  // There is no public SDK shutdown emitter. Exit this isolated worker only
  // after all observed writes/search assertions finish; no graceful-flush claim.
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
