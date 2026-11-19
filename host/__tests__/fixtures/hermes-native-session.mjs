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
const memoryDir = join(home, 'Vault/Memory');
const workspaceMemoryDir = join(memoryDir, 'Projects/workspace');
const paths = { user: join(memoryDir, 'USER.md'), global: join(memoryDir, 'MEMORY.md'),
  workspace: join(workspaceMemoryDir, 'MEMORY.md'), lesson: join(memoryDir, 'failures.md') };
const facts = JSON.parse(readFileSync(join(home, 'facts.json'), 'utf8'));
const markdown = () => Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(path, 'utf8')]));
const put = (key, value) => writeFileSync(paths[key], value);
const text = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
const wireText = body => body.messages.map(text).join('\n');
const permissionBoundary = 'HERMES_PERMISSION_BOUNDARY: analysis only; no deployment authorization.';
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
const { attachHermesMemoryToForeground } = await importPiExtension('hermes-memory-runtime');
const registry = {}, errors = [], requests = [], sessions = [], primaryMemoryWrites = [], notifications = [];
let sequence = 0, reviewSaved = false, correctionSaved = false;
let contextPhase = 'ordinary', contextReply = 0;
let childMode = false;
let expectedModel = 'fixture';

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
    assert.equal(body.model, expectedModel, 'foreground and review use the current configured model');
    assert.equal(body.stream, true);
    if (['cold', 'warm', 'recall', 'managed', 'large'].includes(scenario)) assert.fail('eager rebuild/search must not call a provider');
    const lastUser = text(body.messages.findLast(message => message.role === 'user') ?? {});
    if (lastUser.includes('--- User Correction to Save ---')) {
      assert.equal(childMode, false, 'helper prompts cannot start correction extraction');
      assert.ok(lastUser.includes(facts.user), 'correction review receives the existing fact');
      assert.ok(lastUser.includes(facts.corrected), 'correction review receives the genuine new preference');
      return completion(JSON.stringify({ operations: [{ action: 'replace', target: 'user', old_text: facts.user, content: facts.corrected }] }));
    }
    if (lastUser.includes('--- Conversation to Review ---')) {
      assert.equal(childMode, false, 'helper prompts cannot start automatic review');
      // Context-only task prompts contain no new durable facts. Keep legitimate
      // stock background review enabled without inventing a memory operation.
      if (scenario === 'context') return completion(JSON.stringify({ operations: [] }));
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
        return Response.json({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }, { status: 400 });
      }
      if (contextPhase === 'summary') {
        assert.ok(wireText(body).includes('HERMES_TASK_EVIDENCE'), 'real compaction receives the conversation to summarize');
        put('user', facts.corrected + '\n' + facts.roleCanary + ' Compaction calibration reference.'.repeat(200));
        return completion('The user requested HERMES_TASK_EVIDENCE analysis. Continue the unfinished analysis.');
      }
      if (contextPhase === 'retry') {
        assertNoAutomaticFacts(body);
        assert.ok(wireText(body).includes('HERMES_TASK_EVIDENCE'), 'the pending task survives real compaction');
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

function assertNoAutomaticFacts(body) {
  for (const key of ['user', 'corrected', 'global', 'workspace', 'lesson', 'roleCanary']) {
    assert.ok(!wireText(body).includes(facts[key]), `stored ${key} canary must not enter provider context without search`);
  }
  assert.ok(body.messages.some(message => message.role === 'system' && text(message).includes(permissionBoundary)),
    'ordinary prompt permission boundaries remain intact');
  assert.ok(body.messages.some(message => message.role === 'system' && text(message).includes('memory_search')),
    'native retrieval policy remains present when full-file data is absent');
  for (const name of ['memory_search', 'memory_add', 'memory_replace', 'memory_remove']) {
    assert.ok(body.tools.some(tool => tool.function?.name === name), `${name} remains available to the foreground`);
  }
}

function assertNoSizeWarnings() {
  const sizeWarnings = notifications.filter(({ level, message }) => ['warning', 'error'].includes(level)
    && /memory.*(?:degraded|budget|size limit)|(?:USER|MEMORY)\.md.*(?:large|limit|size|budget)/i.test(message));
  assert.deepEqual(sizeWarnings, [], 'valid large policy-only stores do not emit the former per-request size warning');
}

async function start({ parentSession, context = false, managed = false } = {}) {
  let loader, queryResult;
  const sessionCwd = managed ? join(cwd, 'unrelated-clone') : cwd;
  const additionalExtensionPaths = managed ? [join(repo, 'preseed/agents/pi/extensions/hermes-memory-runtime.ts')] : [];
  if (context) {
    const compactRoot = join(deps, 'pi-smart-compact');
    const compact = JSON.parse(readFileSync(join(compactRoot, 'package.json'), 'utf8'));
    additionalExtensionPaths.push(join(repo, 'preseed/agents/pi/extensions/00-smart-compact-config.ts'),
      ...compact.pi.extensions.map(entry => join(compactRoot, entry)));
  }
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], cacheWarming: 'off',
    compaction: { enabled: context, reserveTokens: 256, keepRecentTokens: 256 }, retry: { enabled: false } });
  loader = new sdk.DefaultResourceLoader({ cwd: sessionCwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths,
    extensionFactories: [...(managed ? [] : [async pi => {
      await attachHermesMemoryToForeground(registry, pi, stock);
    }]), pi => {
      if (context) pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\n' + permissionBoundary }));
      pi.on('tool_call', event => {
        if (['memory_add', 'memory_replace', 'memory_remove'].includes(event.toolName)) {
          primaryMemoryWrites.push(event.toolName);
          return { block: true, reason: 'This qualification permits no primary memory writes' };
        }
      });
      pi.registerCommand('hermes-native-tool', {
        description: 'CI-only explicit invocation of a public stock memory tool',
        async handler(args, ctx) {
          const { name, params } = JSON.parse(args);
          assert.ok(['memory_add', 'memory_replace', 'memory_remove'].includes(name));
          assert.equal(scenario, 'large', 'automatic capture qualification never invokes primary writes');
          const definitions = loader.getExtensions().extensions.map(extension => extension.tools.get(name)).filter(Boolean);
          assert.equal(definitions.length, 1);
          queryResult = await definitions[0].definition.execute('hermes-native-tool', params, undefined, undefined, ctx);
        },
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
  if (context) assert.ok(loader.getExtensions().extensions.some(extension => extension.commands.has('smart-compact')),
    'the composed native context fixture must load the installed Smart Compact command');
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') });
  modelRuntime.registerProvider('hermes-fixture', { baseUrl: 'https://hermes-fixture.invalid/v1', api: 'openai-completions',
    apiKey: 'synthetic-hermes-key', models: [{ id: 'fixture', name: 'Hermes qualification', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 },
      { id: 'fixture-after-switch', name: 'Changed Hermes qualification', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }] });
  const model = modelRuntime.getModel('hermes-fixture', expectedModel);
  assert.ok(model);
  const { session } = await sdk.createAgentSession({ cwd: sessionCwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime, model,
    sessionManager: sdk.SessionManager.inMemory(sessionCwd, parentSession ? { parentSession } : undefined), noTools: 'builtin' });
  sessions.push(session);
  if (managed) process.title = 'pi';
  await session.bindExtensions({ mode: managed ? 'tui' : 'print', onError: error => errors.push(error),
    ...(context ? { uiContext: {
      notify(message, level = 'info') { notifications.push({ message: String(message), level }); },
      setStatus() {}, setWidget() {}, confirm: async () => true,
    } } : {}),
  });
  assert.deepEqual(errors, []);
  return {
    session,
    nextModel: modelRuntime.getModel('hermes-fixture', 'fixture-after-switch'),
    async mutate(name, params) {
      queryResult = undefined;
      await session.prompt(`/hermes-native-tool ${JSON.stringify({ name, params })}`);
      assert.ok(queryResult, 'explicit command executed the public stock mutation');
      assert.equal(queryResult.isError ?? false, false);
      assert.equal(queryResult.details.success, true, JSON.stringify(queryResult));
      return queryResult;
    },
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
  let last;
  const unsubscribe = f.session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') last = event.message;
  });
  try { await f.session.prompt(prompt); }
  finally { unsubscribe(); }
  assert.ok(last, 'this prompt must emit a new assistant response, not reuse an earlier completion');
  assert.equal(last.stopReason, 'stop', JSON.stringify(last));
  assert.match(text(last), scenario === 'context' ? /^HERMES_TASK_EVIDENCE response \d+:/ : /^Foreground fixture acknowledgement \d+\.$/);
}
async function verifySearch(f, { corrected = false } = {}) {
  let matches = 0;
  for (const [key, target] of [['user', 'user'], ['global', 'memory'], ['workspace', 'project'], ['lesson', 'failure']]) {
    const fact = key === 'user' && corrected ? facts.corrected : facts[key];
    let result;
    await until(async () => {
      result = await f.search({ query: fact.split(' ')[0].replace(':', ''), target, ...(target === 'project' ? { project: 'workspace' } : {}) });
      return result.details.count !== 0;
    }, `${target} fact to become searchable after Markdown persistence`);
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
    const f = await start({ managed: true });
    for (const name of ['memory_search', 'memory_add', 'memory_replace']) assert.ok(f.session.getActiveToolNames().includes(name));
    await promptText(f, `For this observatory work: ${facts.user}`);
    await promptText(f, `The calibration reference is: ${facts.global}`);
    await promptText(f, `The current shared workspace uses: ${facts.workspace} Prior import finding: ${facts.lesson}`);
    await until(() => Object.keys(paths).every(key => markdown()[key].includes(facts[key])), 'background review to save all four genuine facts');
    reviewSaved = true;
    await verifySearch(f);
    expectedModel = 'fixture-after-switch';
    await f.session.setModel(f.nextModel);
    await promptText(f, `Actually, use this preference instead: ${facts.corrected}`);
    await until(() => markdown().user.includes(facts.corrected) && !markdown().user.includes(facts.user), 'stock correction replacement');
    correctionSaved = true;
    assert.deepEqual(primaryMemoryWrites, []);
    assert.ok(!f.session.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')),
      'no primary model tool call can account for the durable writes');
    const before = markdown();
    const helper = await start({ managed: true, parentSession: join(agentDir, 'sessions/root.jsonl') });
    childMode = true;
    assert.equal(helper.session.getActiveToolNames().some(name => name.startsWith('memory_')), false);
    for (let i = 0; i < 4; i++) await promptText(helper, `Helper review task ${i}. Do not learn this task as user facts. ${facts.excluded}`);
    const helperBodies = requests.slice(-4);
    for (const body of helperBodies) for (const key of ['corrected', 'global', 'workspace']) assert.ok(!wireText(body).includes(facts[key]));
    assert.deepEqual(markdown(), before);
    return { reviewSaved, correctionSaved, primaryMemoryWrites, childHasMemoryTools: false, childLeakedContext: false, childChangedMarkdown: false };
  }
  if (scenario === 'large') {
    const before = markdown();
    const f = await start({ managed: true });
    assert.equal(f.session.sessionManager.getCwd(), join(cwd, 'unrelated-clone'));
    for (const [key, target] of [['user', 'user'], ['global', 'memory'], ['workspace', 'project']]) {
      assert.ok(before[key].length > 5000, `${target} starts above the former injection limit`);
      const original = await f.search({ query: facts[key].split(' ')[0], target });
      assert.equal(original.details.count, 1);
      assert.ok(original.details.output.includes(facts[key]));
      if (target === 'project') assert.ok(original.details.output.includes('scope=project:workspace'), 'clone cwd still recalls shared workspace');
      const token = `Probe${facts[key].split(' ')[0]}`;
      const added = `${token} calibration record is amber.`;
      const replaced = `${token} calibration record is violet.`;
      await f.mutate('memory_add', { target, content: added });
      let found = await f.search({ query: token, target });
      assert.equal(found.details.count, 1);
      assert.ok(found.details.output.includes(added));
      await f.mutate('memory_replace', { target, old_text: added, content: replaced });
      found = await f.search({ query: token, target });
      assert.equal(found.details.count, 1);
      assert.ok(found.details.output.includes(replaced));
      assert.ok(!found.details.output.includes(added));
      await f.mutate('memory_remove', { target, old_text: replaced });
      assert.equal((await f.search({ query: token, target })).details.count, 0, 'removed entries cannot be recalled');
      assert.equal(markdown()[key], before[key], 'add/replace/remove restores the original large Markdown byte-for-byte');
      assert.ok((await f.search({ query: facts[key].split(' ')[0], target })).details.output.includes(facts[key]));
    }
    assert.deepEqual(markdown(), before);
    assert.equal(requests.length, 0, 'search/CRUD over a large policy-only store needs no consolidation/provider');
    return { searchableScopes: 3, crudScopes: 3, originalsPreserved: true, providerRequests: requests.length };
  }
  if (scenario === 'context') {
    const f = await start({ context: true, managed: true });
    assert.equal(f.session.sessionManager.getCwd(), join(cwd, 'unrelated-clone'));
    const initialMarkdown = markdown();
    assert.ok(initialMarkdown.user.length > 5000, 'initial request starts with a valid over-limit store');
    await promptText(f, 'HERMES_TASK_EVIDENCE: analyze the calibration procedure.');
    assertNoAutomaticFacts(requests.at(-1));
    assertNoSizeWarnings();
    // Edit canonical data, not the SDK state or the integration's context.
    put('user', facts.corrected + '\n' + facts.roleCanary + ' Ordinary calibration reference.'.repeat(200));
    assert.ok(markdown().user.length > 5000);
    await promptText(f, 'HERMES_TASK_EVIDENCE: continue the ordinary analysis.');
    assertNoAutomaticFacts(requests.at(-1));
    assertNoSizeWarnings();
    const beforeUserTurns = f.session.messages.filter(message => message.role === 'user').length;
    let compactionResult;
    // Native compaction may summarize both history and a split-turn prefix.
    // Only its public completion event moves the provider into retry mode.
    const unsubscribe = f.session.subscribe(event => {
      if (event.type === 'compaction_start') contextPhase = 'summary';
      if (event.type === 'compaction_end') {
        compactionResult = event;
        contextPhase = event.willRetry ? 'retry' : 'compaction-failed';
      }
    });
    // Revert on disk, then correct DURING the actual summary request. The
    // automatic retry must not expose the correction (or any full-file data)
    // without explicit recall and without any further user prompt.
    put('user', facts.user + '\n' + facts.roleCanary + ' Precompaction calibration reference.'.repeat(200));
    contextPhase = 'overflow';
    await promptText(f, 'HERMES_TASK_EVIDENCE: finish the interrupted analysis.');
    unsubscribe();
    assert.deepEqual(providerFailures, []);
    assert.ok(compactionResult?.result, compactionResult?.errorMessage ?? 'the public compaction event must report a result');
    assert.equal(compactionResult.aborted, false);
    assert.equal(compactionResult.willRetry, true);
    assert.equal(contextPhase, 'finished');
    assert.ok(f.session.sessionManager.getEntries().some(entry => entry.type === 'compaction'), 'real SDK recorded compaction');
    assert.ok(f.session.messages.filter(message => message.role === 'user').length <= beforeUserTurns + 1,
      'automatic continuation required no new user prompt');
    const persistedReferenceCopies = f.session.sessionManager.getEntries().filter(entry => entry.type === 'message'
      && [facts.user, facts.corrected, facts.global, facts.workspace].some(fact => text(entry.message).includes(fact))).length;
    assert.equal(persistedReferenceCopies, 0, 'unsolicited stored facts are not persisted to the session tree');
    assertNoAutomaticFacts(requests.at(-1));
    assertNoSizeWarnings();
    assert.ok(markdown().user.length > 5000);
    assert.ok(markdown().user.includes(facts.corrected));
    for (const key of ['global', 'workspace', 'lesson']) assert.equal(markdown()[key], initialMarkdown[key], 'requests never rewrite unrelated stored facts');
    const beforeSearch = requests.length;
    const recalled = await f.search({ query: facts.corrected.split(' ')[0], target: 'user' });
    assert.equal(recalled.details.count, 1);
    assert.ok(recalled.details.output.includes(facts.corrected), 'explicit native search returns the large stored fact');
    assert.ok(recalled.details.output.includes(facts.roleCanary), 'role-like stored text stays retrievable as tool data, not unsolicited system authority');
    assert.equal(requests.length, beforeSearch, 'read-only explicit search needs no model request');
    return { initialAndSubsequentWithoutFacts: true, compactedAndRetried: true, postCompactionWithoutFacts: true,
      sizeWarnings: 0, explicitSearchReturnedFact: true, persistedReferenceCopies };
  }
  assert.ok(['cold', 'warm', 'recall', 'managed'].includes(scenario));
  if (scenario === 'cold') assert.equal(existsSync(databasePath), false, 'fixture begins with canonical Markdown only');
  const f = await start({ managed: scenario === 'managed' });
  if (scenario === 'managed') {
    assert.equal(f.session.sessionManager.getCwd(), join(cwd, 'unrelated-clone'), 'memory scope must not change the real session cwd');
    const helper = await start({ managed: true, parentSession: join(agentDir, 'sessions/root.jsonl') });
    assert.equal(helper.session.getActiveToolNames().some(name => name.startsWith('memory_')), false,
      'the default adapter keeps an in-process child from acquiring the foreground package');
  }
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
  const ownerRegistered = scenario === 'managed' && existsSync(join(home, '.cache/pi-hermes-memory/owners', `${process.pid}.json`));
  return { ...result, providerRequests: requests.length, reusedNativeDatabase: scenario === 'warm', recalledCorrection: scenario === 'recall', ownerRegistered };
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
