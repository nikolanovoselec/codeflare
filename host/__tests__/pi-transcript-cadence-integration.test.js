import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const jsonl = entries => entries.map(entry => JSON.stringify(entry) + '\n').join('');

test('REQ-MEM-028 AC1: actual trims preserve the next twenty-prompt cadence and frozen extraction inputs', async t => {
  const { registerMemoryVault } = await importPiExtension('memory-vault');
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-trim-cadence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const entries = [{ type: 'session', version: 3, id: 'fixture', cwd: '/synthetic' }];
  const append = payload => {
    const entry = { id: `e${entries.length}`, parentId: entries.length === 1 ? null : entries.at(-1).id,
      timestamp: '2026-11-03T00:00:00Z', ...payload };
    entries.push(entry);
    return entry;
  };
  for (let n = 0; n < 4; n++) append({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: 'h'.repeat(8_000_000) }, { type: 'text', text: `historical answer ${n}` }] } });
  const kept = append({ type: 'custom', customType: 'synthetic-opaque-state', data: { payload: 'p'.repeat(19_000_000) } });
  append({ type: 'compaction', firstKeptEntryId: kept.id, summary: 'Historical answers summarized', tokensBefore: 1000 });
  fs.writeFileSync(file, jsonl(entries));
  assert.ok(fs.statSync(file).size > 50_000_000);
  const ctx = { sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => file,
    getHeader: () => entries[0], getLeafId: () => entries.at(-1).id, getBranch: () => entries.slice(1) } };
  const paths = { vaultRoot: join(root, 'Vault'), cacheDir: join(root, 'cache'), memoryCounterDir: join(root, 'counters'),
    memoryPromptFile: join(root, 'memory.md'), vaultPromptFile: join(root, 'vault.md'),
    vaultManifestFile: join(root, 'Vault/graphify-out/manifest.json'), vaultInitializationFile: join(root, 'Vault/graphify-out/initialized'),
    vaultMarkerFile: join(root, 'marker') };
  fs.writeFileSync(paths.memoryPromptFile, '# capture'); fs.writeFileSync(paths.vaultPromptFile, '# vault');
  const handlers = new Map(), messages = [], tools = new Map();
  let promptNumber = 0;
  const pi = {
    on(name, handler) { const rows = handlers.get(name) ?? []; rows.push(handler); handlers.set(name, rows); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, sendMessage(...args) { messages.push(args); },
  };
  let sequence = 0;
  registerMemoryVault(pi, { paths, now: () => Date.parse('2026-11-03T00:00:00Z'), randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  const emit = (name, event = {}) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
  const snapshot = directory => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(join(directory, name), 'utf8')]);
  emit('session_start');
  let frozenCache, frozenVars;
  const reductions = [];
  for (promptNumber = 1; promptNumber <= 41; promptNumber++) {
    // Model a later public-SDK rewrite from loaded entries, without changing them:
    // the second actual trim must also preserve the already-frozen capture request.
    if (promptNumber === 41) fs.writeFileSync(file, jsonl(entries));
    const user = append({ type: 'message', message: { role: 'user', content: `prompt ${promptNumber}` } });
    fs.appendFileSync(file, jsonl([user]));
    emit('before_agent_start', { prompt: user.message.content });
    const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `answer ${promptNumber}` }] };
    fs.appendFileSync(file, jsonl([append({ type: 'message', message: answer })]));
    const before = fs.statSync(file).size;
    emit('agent_end', { messages: [answer] });
    // The scoped operation activates while the native child is still running;
    // native completion and the next owner boundary cannot authorize another write.
    if (promptNumber === 21 || promptNumber === 41) {
      emit('agent_settled');
      const item = messages.flatMap(([m]) => m.customType === 'background-extraction-launch' ? m.details.items : []).filter(i => i.jobType === 'transcript-trim').at(-1);
      assert.ok(item);
      if (promptNumber === 21) {
        const launch = messages.find(([message]) => message.customType === 'background-extraction-launch')[0];
        assert.ok(launch.details.items.some(job => job.jobType === 'memory-capture'));
        assert.ok(launch.details.items.some(job => job.jobType === 'transcript-trim'));
      }
      for (const payload of [
        { type: 'custom_message', customType: 'background-extraction-launch', details: { items: [item] } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: item.requestId, name: 'subagent', arguments: item.request }] } },
      ]) fs.appendFileSync(file, jsonl([append(payload)]));
      const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
      const result = JSON.parse((await tools.get('transcript_trim').execute('scoped-trim', { operation: 'trim' }, undefined, undefined, child)).content[0].text);
      assert.equal(result.committed, true); assert.equal(result.status, 'trimmed');
      fs.appendFileSync(file, jsonl([append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${item.requestId}</tool-use-id><status>Done</status>` })]));
      emit('agent_settled');
    }
    if (promptNumber === 21 || promptNumber === 41) {
      const after = fs.statSync(file).size;
      assert.ok(before > 50_000_000); assert.ok(after >= 15_000_000 && after <= 25_000_000);
      reductions.push({ prompt: promptNumber, before, after });
    }
    if (promptNumber === 21) {
      frozenCache = snapshot(paths.cacheDir);
      frozenVars = fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8');
    }
  }
  assert.deepEqual(reductions.map(item => item.prompt), [21, 41]);
  const trims = messages.flatMap(([message]) => message.customType === 'background-extraction-launch' ? message.details.items.filter(item => item.jobType === 'transcript-trim') : []);
  assert.equal(trims.length, 2); assert.notEqual(trims[0].requestId, trims[1].requestId);
  assert.equal(reductions.length, 2);
  assert.ok(frozenCache.length > 0); assert.ok(frozenVars.length > 0);
  assert.deepEqual(snapshot(paths.cacheDir), frozenCache);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8'), frozenVars);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.count'), 'utf8'), '1');
  const persisted = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(persisted.filter(entry => entry.message?.role === 'user').map(entry => entry.message.content),
    Array.from({ length: 41 }, (_value, n) => `prompt ${n + 1}`));
  assert.equal(persisted.find(entry => entry.id === kept.id).data.payload.length, 19_000_000);
  assert.equal(messages.filter(([m]) => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed').length, 2);
});

for (const order of ['capture-before-trim', 'trim-before-capture', 'capture-failed', 'published-before-native-success', 'cancel-switch', 'external-rewrite', 'frontier-removed', 'exhausted-after-trim', 'exhausted-rewrite-after-trim', 'serviced-companion-window', 'second-trim-success', 'exhausted-second-trim', 'abort-after-trim-success', 'exhausted-abort-after-trim']) {
  test(`own verified trim translates only the successful frontier: ${order}`, async t => {
    const { registerMemoryVault } = await importPiExtension('memory-vault');
    const { realUserPromptFingerprint, parseSessionEntries } = await importPiExtension('memory-vault-helpers');
    const root = fs.mkdtempSync(join(tmpdir(), 'pi-trim-checkpoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'session.jsonl');
    const entries = [{ type: 'session', version: 3, id: 'fixture', cwd: '/synthetic' }];
    const append = payload => {
      const entry = { id: `e${entries.length}`, parentId: entries.at(-1).id ?? null,
        timestamp: '2026-11-03T00:00:00Z', ...payload };
      entries.push(entry); fs.appendFileSync(file, jsonl([entry])); return entry;
    };
    fs.writeFileSync(file, jsonl(entries));
    for (let n = 1; n <= 63; n++) append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } });
    append({ type: 'message', message: { role: 'assistant', content: 'old'.repeat(10_700_000) } });
    append({ type: 'custom', customType: 'retained-padding', data: 'p'.repeat(19_000_000) });
    for (let n = 64; n <= 147; n++) append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } });
    const ctx = { sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => file,
      getHeader: () => entries[0], getLeafId: () => entries.at(-1).id, getBranch: () => entries.slice(1) } };
    const paths = { vaultRoot: join(root, 'Vault'), cacheDir: join(root, 'cache'), memoryCounterDir: join(root, 'counters'),
      memoryPromptFile: join(root, 'memory.md'), vaultPromptFile: join(root, 'vault.md'),
      vaultManifestFile: join(root, 'Vault/graphify-out/manifest.json'), vaultInitializationFile: join(root, 'Vault/graphify-out/initialized'),
      vaultMarkerFile: join(root, 'marker') };
    fs.writeFileSync(paths.memoryPromptFile, '# capture'); fs.writeFileSync(paths.vaultPromptFile, '# vault');
    const handlers = new Map(), messages = [], tools = new Map();
    const pi = { on(name, handler) { const rows = handlers.get(name) ?? []; rows.push(handler); handlers.set(name, rows); },
      registerTool(tool) { tools.set(tool.name, tool); }, getActiveTools: () => [], getAllTools: () => [], setActiveTools() {},
      sendMessage(...args) { messages.push(args); } };
    let sequence = 0;
    registerMemoryVault(pi, { paths, now: () => Date.parse('2026-11-03T00:00:00Z'),
      randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
    const emit = (name, event = {}, context = ctx) => { for (const handler of handlers.get(name) ?? []) handler(event, context); };
    const launches = job => messages.flatMap(([m]) => m.customType === 'background-extraction-launch' ? m.details.items.filter(i => i.jobType === job) : []);
    const countFile = join(paths.memoryCounterDir, 'fixture.count');
    const progressFile = join(paths.memoryCounterDir, 'fixture.progress.json');
    const activeFile = join(paths.memoryCounterDir, 'fixture.vars');
    emit('session_start');
    const previous = { promptCount: 127, transcriptFingerprint: realUserPromptFingerprint(entries, 127) };
    fs.writeFileSync(countFile, '127'); fs.writeFileSync(progressFile, JSON.stringify(previous));
    const chunk = requestId => fs.writeFileSync(join(paths.vaultRoot, 'graphify-out', `.graphify_chunk_${requestId}.json`),
      JSON.stringify({ nodes: [{ id: 'synthetic-concept', label: 'Synthetic concept', file_type: 'concept',
        source_file: null, source_location: null, source_url: null, captured_at: null, author: null, contributor: null }],
      edges: [], hyperedges: [], input_tokens: 0, output_tokens: 0 }));
    const companionNote = join(paths.vaultRoot, 'Notes/companion.md');
    if (order === 'serviced-companion-window') fs.writeFileSync(companionNote, '# Initial companion note');
    const oldNote = join(paths.vaultRoot, 'Raw/Sessions/previous.md');
    fs.writeFileSync(oldNote, `---\nsession_id: fixture\ncaptured_at: "2000-01-01T00-00-00+0000"\ncaptured_prompt_count: 127\ncaptured_prompt_fingerprint: ${previous.transcriptFingerprint}\nfixture_metadata: keep exactly\n---\nPrevious capture body\n`);
    emit('agent_settled');
    const memory = launches('memory-capture').at(-1);
    let trim = launches('transcript-trim').at(-1);
    assert.ok(memory); assert.ok(trim);
    if (order === 'serviced-companion-window') {
      const vault = launches('vault-extract').at(-1);
      assert.ok(vault);
      append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [vault] } });
      append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'vault-call', name: 'subagent', arguments: vault.request }] } });
      chunk(vault.requestId);
      append({ type: 'custom_message', customType: 'subagent-notification', content: '<tool-use-id>vault-call</tool-use-id><status>Done</status>' });
      emit('agent_settled');
      assert.ok(!fs.existsSync(join(paths.cacheDir, 'vault-extract.pi.vars')), 'initial companion completed before the edit');
    }
    const varsFile = memory.request.prompt.match(/^VARS_FILE=(.+)$/m)[1];
    const frozen = fs.readFileSync(varsFile, 'utf8'), request = JSON.parse(frozen);
    assert.equal(request.promptCount, 147);
    append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [memory] } });
    append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'memory-call', name: 'subagent', arguments: memory.request }] } });
    const note = join(paths.vaultRoot, 'Raw/Sessions', request.captureFilename);
    const publish = () => {
      fs.writeFileSync(note, '---\nfixture_metadata: keep exactly\n---\n# Captured immutable body\n' + request.transcript);
      chunk(request.requestId);
      append({ type: 'custom_message', customType: 'subagent-notification', content: '<tool-use-id>memory-call</tool-use-id><status>Done</status>' });
      emit('agent_settled');
    };
    if (order === 'capture-before-trim') publish();
    let publishedNote;
    if (order === 'published-before-native-success') {
      publishedNote = `---\nsession_id: fixture\ncaptured_at: "${request.captureTimestamp}"\ncaptured_prompt_count: 147\ncaptured_prompt_fingerprint: ${request.transcriptFingerprint}\nfixture_metadata: keep exactly\n---\nPublished but not accepted\n`;
      fs.writeFileSync(note, publishedNote);
      chunk(request.requestId);
      append({ type: 'custom_message', customType: 'subagent-notification', content: '<tool-use-id>memory-call</tool-use-id><status>Error</status>' });
    }
    // These prompts are outside the frozen 147-prompt capture, in both orders.
    for (let n = 148; n <= 150; n++) append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } });
    if (order === 'external-rewrite') {
      const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      disk.find(e => e.message?.content === 'prompt 100').message.content = 'externally rewritten prompt';
      fs.writeFileSync(file, jsonl(disk));
    }
    if (order === 'frontier-removed') {
      const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, jsonl(disk.filter(e => e.message?.content !== 'prompt 147')));
    }
    if (order === 'external-rewrite' || order === 'frontier-removed') {
      // Re-arm against the rewritten source. Even a subsequent own verified trim
      // cannot bless an already-invalid capture prefix.
      emit('agent_settled');
      trim = launches('transcript-trim').at(-1);
    }
    append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: trim.requestId, name: 'subagent', arguments: trim.request }] } });
    const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: trim.request.prompt } }] } };
    if (order === 'cancel-switch') {
      const prepared = await tools.get('transcript_trim').execute('prepare', { operation: 'prepare' }, undefined, undefined, child);
      assert.equal(JSON.parse(prepared.content[0].text).withinTarget, true);
      // Activation enters the private before-checkpoint hook synchronously, then
      // yields to its worker. Cancel before that worker can authorize a rename.
      const activation = tools.get('transcript_trim').execute('activate', { operation: 'activate' }, undefined, undefined, child);
      emit('session_before_switch');
      const foreignFile = join(root, 'foreign.jsonl');
      fs.writeFileSync(foreignFile, jsonl([{ type: 'session', version: 3, id: 'foreign', cwd: '/synthetic' },
        ...Array.from({ length: 20 }, (_, n) => ({ type: 'message', id: `foreign-${n}`, message: { role: 'user', content: `foreign prompt ${n}` } }))]));
      const foreign = { sessionManager: { ...ctx.sessionManager, getSessionId: () => 'foreign', getSessionFile: () => foreignFile,
        getHeader: () => ({ type: 'session', version: 3, id: 'foreign' }), getBranch: () => [], getLeafId: () => null } };
      emit('session_start', {}, foreign);
      fs.writeFileSync(join(paths.memoryCounterDir, 'foreign.count'), '0');
      emit('agent_settled', {}, foreign);
      const cancelled = JSON.parse((await activation).content[0].text);
      assert.notEqual(cancelled.status, 'trimmed');
      assert.equal(fs.readFileSync(countFile, 'utf8'), '127', 'cancelled authority cannot translate old-session progress');
      assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'foreign.count'), 'utf8'), '0');
      const foreignPointer = JSON.parse(fs.readFileSync(join(paths.memoryCounterDir, 'foreign.vars'), 'utf8'));
      const foreignRequest = JSON.parse(fs.readFileSync(join(paths.cacheDir, `memory-capture.foreign.${foreignPointer.requestId}.vars`), 'utf8'));
      assert.equal(foreignRequest.promptCount, 20, 'foreign-session eligibility is not deferred by old authority');
      emit('agent_settled');
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen, 'old frozen request remains retryable');
      assert.equal(fs.readFileSync(countFile, 'utf8'), '127');
      publish();
      assert.equal(fs.readFileSync(countFile, 'utf8'), '147');
      for (let n = 151; n <= 167; n++) {
        append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } });
        emit('agent_settled');
      }
      const resumedPointer = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      const resumedRequest = JSON.parse(fs.readFileSync(join(paths.cacheDir, `memory-capture.fixture.${resumedPointer.requestId}.vars`), 'utf8'));
      assert.equal(resumedRequest.promptCount, 167, 'returning-session eligibility is not stuck after cancellation');
      return;
    }
    const result = JSON.parse((await tools.get('transcript_trim').execute('trim', { operation: 'trim' }, undefined, undefined, child)).content[0].text);
    if (order === 'external-rewrite' || order === 'frontier-removed') {
      assert.equal(result.status, 'trimmed');
      publish();
      assert.equal(fs.readFileSync(countFile, 'utf8'), '147');
      assert.ok(fs.existsSync(activeFile), 'unrecognized rewrite still requests recovery');
      return;
    }
    assert.equal(result.status, 'trimmed');
    assert.equal(parseSessionEntries(fs.readFileSync(file, 'utf8')).filter(e => e.message?.role === 'user').length, 87);
    const secondTrim = order === 'second-trim-success' || order === 'exhausted-second-trim';
    const sameSessionAbort = order === 'abort-after-trim-success' || order === 'exhausted-abort-after-trim';
    if (secondTrim || sameSessionAbort) {
      assert.equal(result.committed, true);
      assert.equal(fs.readFileSync(countFile, 'utf8'), '64');
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen, 'verified first trim leaves raw 147 immutable');
      append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${trim.requestId}</tool-use-id><status>Done</status>` });
      emit('agent_settled');
    }
    if (secondTrim) {
      // Add only non-prompt payload, keeping all existing prompt IDs and content.
      // The real byte-cut engine removes prompts 64..99 on the next trim.
      const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      const originalPrompts = disk.filter(e => e.message?.role === 'user');
      const before100 = disk.findIndex(e => e.message?.content === 'prompt 100');
      assert.ok(before100 > 0);
      disk.splice(before100, 0,
        { type: 'message', id: 'second-trim-old-tool', parentId: disk[before100 - 1].id,
          message: { role: 'toolResult', toolCallId: 'old-read', toolName: 'read', content: 't'.repeat(32_000_000) } },
        { type: 'custom', id: 'second-trim-padding', parentId: 'second-trim-old-tool', customType: 'retained-padding', data: 'p'.repeat(19_000_000) });
      fs.writeFileSync(file, jsonl(disk));
      assert.deepEqual(parseSessionEntries(fs.readFileSync(file, 'utf8')).filter(e => e.message?.role === 'user'),
        originalPrompts, 'payload growth preserves prompt identity and content');
      const scheduled = JSON.parse((await tools.get('transcript_trim').execute('request-second-trim', { operation: 'request' }, undefined, undefined, ctx)).content[0].text);
      assert.equal(scheduled.status, 'scheduled');
      emit('agent_settled');
      const second = launches('transcript-trim').at(-1);
      assert.notEqual(second.requestId, trim.requestId);
      append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [second] } });
      append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: second.requestId, name: 'subagent', arguments: second.request }] } });
      const secondChild = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: second.request.prompt } }] } };
      const twice = JSON.parse((await tools.get('transcript_trim').execute('second-trim', { operation: 'trim' }, undefined, undefined, secondChild)).content[0].text);
      assert.equal(twice.status, 'trimmed');
      assert.equal(twice.committed, true);
      const retained = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(retained.filter(e => e.message?.role === 'user'), originalPrompts.slice(36),
        'second actual byte cut retains the exact prompts 100..150, including three uncaptured prompts');
      assert.equal(retained.filter(e => e.message?.role === 'user').length, 51);
      append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${second.requestId}</tool-use-id><status>Done</status>` });
      emit('agent_settled');
      assert.equal(messages.filter(([m]) => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed').length, 2);
    }
    if (sameSessionAbort) {
      emit('turn_end', { outcome: 'aborted' });
      emit('agent_settled', { aborted: true });
    }
    if (secondTrim || sameSessionAbort) {
      const committed = secondTrim ? 28 : 64;
      const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      assert.equal(fs.readFileSync(countFile, 'utf8'), String(committed));
      assert.equal(progress.promptCount, committed);
      assert.equal(progress.transcriptFingerprint, realUserPromptFingerprint(disk, committed));
      assert.match(fs.readFileSync(oldNote, 'utf8'), new RegExp(`captured_prompt_count: ${committed}\\n`));
      assert.match(fs.readFileSync(oldNote, 'utf8'), /fixture_metadata: keep exactly\n---\nPrevious capture body\n$/);
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen, 'translated coverage never mutates frozen raw 147 request');
      assert.equal(JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId, request.requestId);
    }
    if (order.startsWith('exhausted-')) {
      let callId = 'memory-call';
      for (let attempt = 1; attempt <= 6; attempt++) {
        append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${callId}</tool-use-id><status>Error</status>` });
        emit('agent_settled');
        if (attempt < 6) {
          const retry = launches('memory-capture').at(-1);
          assert.equal(retry.requestId, request.requestId);
          assert.equal(retry.reminder, attempt);
          callId = `retry-${attempt}`;
          append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [retry] } });
          append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'subagent', arguments: retry.request }] } });
        }
      }
      const giveup = messages.findLast(([m]) => m.customType === 'background-extraction-giveup'
        && m.details.items.some(i => i.requestId === request.requestId))[0];
      append({ type: 'custom_message', ...giveup });
      emit('agent_settled');
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen, 'own trim cannot immediately re-arm exhausted work');
      assert.equal(fs.readFileSync(countFile, 'utf8'), secondTrim ? '28' : '64', 'failed capture never advances committed progress');
      assert.equal(launches('memory-capture').length, 6);
      if (order === 'exhausted-rewrite-after-trim') {
        const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
        disk.find(e => e.message?.content === 'prompt 100').message.content = 'external edit after translation';
        fs.writeFileSync(file, jsonl(disk));
        emit('agent_settled');
        assert.notEqual(JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId, request.requestId,
          'genuine rewrite invalidates translation and immediately recovers');
        return;
      }
      for (let n = 151; n <= 166; n++) {
        append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } }); emit('agent_settled');
        assert.equal(JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId, request.requestId,
          'nineteen later real prompts do not re-arm exhausted work');
        if (secondTrim || sameSessionAbort) assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen);
      }
      append({ type: 'message', message: { role: 'user', content: 'prompt 167' } }); emit('agent_settled');
      const nextId = JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId;
      assert.notEqual(nextId, request.requestId, 'twentieth later real prompt re-arms exhausted work');
      const next = JSON.parse(fs.readFileSync(join(paths.cacheDir, `memory-capture.fixture.${nextId}.vars`), 'utf8'));
      assert.equal(next.promptCount, secondTrim ? 68 : 104);
      if (secondTrim || sameSessionAbort) {
        assert.match(next.transcript, /prompt 148/); assert.match(next.transcript, /prompt 167/);
      }
      return;
    }
    if (order === 'serviced-companion-window') {
      fs.writeFileSync(companionNote, '# Edited within the already-serviced window');
      emit('agent_settled');
      assert.equal(launches('vault-extract').length, 1, 'own trim does not recheck a serviced companion window');
    }
    if (order === 'trim-before-capture' || order === 'serviced-companion-window' || secondTrim || sameSessionAbort) {
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen, 'trim cannot mutate frozen request');
      assert.equal(fs.readFileSync(countFile, 'utf8'), secondTrim ? '28' : '64');
      publish();
    } else if (order === 'published-before-native-success') {
      emit('agent_settled');
      assert.equal(fs.readFileSync(countFile, 'utf8'), '64', 'published 147 is not committed coverage');
      assert.equal(JSON.parse(fs.readFileSync(progressFile, 'utf8')).promptCount, 64);
      assert.match(fs.readFileSync(oldNote, 'utf8'), /captured_prompt_count: 64\n/);
      assert.match(fs.readFileSync(oldNote, 'utf8'), /fixture_metadata: keep exactly\n---\nPrevious capture body\n$/);
      assert.equal(fs.readFileSync(note, 'utf8'), publishedNote, 'unaccepted publication is untouched');
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen);
      assert.equal(JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId, request.requestId);
      assert.ok(launches('memory-capture').length > 1, 'failed native work retries the existing request');
      assert.ok(launches('memory-capture').every(item => item.requestId === request.requestId));
      return;
    } else if (order === 'capture-failed') {
      append({ type: 'custom_message', customType: 'subagent-notification', content: '<tool-use-id>memory-call</tool-use-id><status>Error</status>' });
      emit('agent_settled');
      assert.equal(fs.readFileSync(countFile, 'utf8'), '64', 'failed 147 range is not captured');
      assert.equal(fs.readFileSync(varsFile, 'utf8'), frozen);
      assert.ok(!fs.existsSync(note));
      return;
    }
    emit('agent_settled');
    assert.equal(fs.readFileSync(countFile, 'utf8'), secondTrim ? '48' : '84');
    assert.match(fs.readFileSync(note, 'utf8'), secondTrim ? /captured_prompt_count: 48\n/ : /captured_prompt_count: 84\n/);
    if (secondTrim || sameSessionAbort) {
      const captured = secondTrim ? 48 : 84;
      const disk = parseSessionEntries(fs.readFileSync(file, 'utf8'));
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      assert.equal(progress.promptCount, captured);
      assert.equal(progress.transcriptFingerprint, realUserPromptFingerprint(disk, captured));
      assert.equal(disk.filter(e => e.message?.role === 'user').length - captured, 3, '148..150 remain uncaptured');
    }
    assert.match(fs.readFileSync(note, 'utf8'), /fixture_metadata: keep exactly\n/);
    assert.ok(fs.readFileSync(note, 'utf8').endsWith('# Captured immutable body\n' + request.transcript));
    assert.ok(!fs.existsSync(activeFile), 'no immediate duplicate capture');
    assert.equal(launches('memory-capture').length, 1);
    if (order === 'serviced-companion-window') assert.equal(launches('vault-extract').length, 1,
      'own-translated finalization does not recheck the serviced window');
    for (let n = 151; n <= 166; n++) { append({ type: 'message', message: { role: 'user', content: `prompt ${n}` } }); emit('agent_settled'); }
    assert.ok(!fs.existsSync(activeFile), 'nineteen new prompts remain below the shared trigger');
    if (order === 'serviced-companion-window') assert.equal(launches('vault-extract').length, 1);
    append({ type: 'message', message: { role: 'user', content: 'prompt 167' } }); emit('agent_settled');
    const nextId = JSON.parse(fs.readFileSync(activeFile, 'utf8')).requestId;
    const next = JSON.parse(fs.readFileSync(join(paths.cacheDir, `memory-capture.fixture.${nextId}.vars`), 'utf8'));
    assert.equal(next.promptCount, secondTrim ? 68 : 104);
    if (order === 'serviced-companion-window') {
      assert.equal(launches('vault-extract').length, 2, 'next genuine twenty-prompt crossing checks the changed Vault');
      const vault = launches('vault-extract').at(-1);
      const vaultVars = vault.request.prompt.match(/^VARS_FILE=(.+)$/m)[1];
      assert.ok(JSON.parse(fs.readFileSync(vaultVars, 'utf8')).changedFiles.includes(companionNote));
    }
    assert.match(next.transcript, /prompt 148/); assert.match(next.transcript, /prompt 167/);
    assert.doesNotMatch(next.transcript, /prompt 147/);
  });
}
