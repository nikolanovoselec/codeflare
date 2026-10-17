import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, TuiMainScreen } from '@earendil-works/pi-tui';
import { patchQuestionnaireTimeout } from '../../../../scripts/patch-rpiv-question-timeout.mjs';

const installed = dirname(fileURLToPath(import.meta.resolve('@juicesharp/rpiv-ask-user-question')));
const question = (multiSelect = false) => ({ question: 'Which implementation?', header: 'Approach', multiSelect,
  options: [{ label: 'Small change (Recommended)', description: 'Preserve existing ownership.' },
    { label: 'Different approach', description: 'Use the alternative implementation.' }] });
const params = { questions: [question()] };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Only the terminal/native-dialog host and the platform clock are substituted.
// The package, schema, questionnaire session, reducer, renderer and SDK tool are real.
function host(mode) {
  const terminal = { columns: 120, rows: 40, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new TuiMainScreen(terminal);
  const foreground = 'accent border borderAccent borderMuted success error warning muted dim text thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode';
  const background = 'selectedBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg';
  const colors = keys => Object.fromEntries(keys.split(' ').map(key => [key, '']));
  const theme = new Theme(colors(foreground), colors(background), 'truecolor');
  const view = { active: false, component: undefined, dialog: undefined, pending: undefined };
  const opened = [];
  const next = [];
  const publish = value => { if (next.length) next.shift()(value); else opened.push(value); };
  const wait = () => opened.length ? Promise.resolve(opened.shift()) : new Promise(resolve => next.push(resolve));
  function dialog(kind, title, options, opts) {
    return new Promise(resolve => {
      view.active = true;
      const finish = answer => {
        opts?.signal?.removeEventListener('abort', abort);
        view.active = false;
        if (view.pending === finish) view.pending = undefined;
        resolve(answer);
      };
      const abort = () => finish(undefined);
      view.pending = finish;
      view.dialog = { kind, title, options, timeout: opts?.timeout };
      opts?.signal?.addEventListener('abort', abort, { once: true });
      if (opts?.signal?.aborted) finish(undefined);
      publish(view.dialog);
    });
  }
  return { view, wait,
    answer(value) { assert.ok(view.pending, 'a real host dialog must be waiting'); view.pending(value); },
    key(data) { assert.ok(view.active && view.component); view.component.handleInput(data); },
    ui: { theme, notify() {}, setStatus() {}, onTerminalInput() { return () => {}; },
      custom(factory, options) {
        if (mode !== 'tui') return Promise.resolve(undefined);
        return new Promise((resolve, reject) => {
          const finish = value => { view.active = false; view.pending = undefined; resolve(value); };
          view.pending = finish;
          try {
            view.component = factory(tui, theme, getKeybindings(), finish);
            view.active = true;
            options?.onHandle?.({ isHidden: () => false, isFocused: () => true, setHidden() {} });
            publish(view.component.render(120));
          } catch (error) { reject(error); }
        });
      },
      select(title, options, opts) { return dialog('select', title, options, opts); },
      input(title, placeholder, opts) { return dialog('input', title, placeholder, opts); },
    },
  };
}

async function fixture(t, mode = 'tui', prepare = true) {
  // Keep the copy beside the real installation so its unchanged host peers resolve.
  const root = mkdtempSync(join(dirname(installed), '.codeflare-questionnaire-'));
  const home = mkdtempSync(join(tmpdir(), 'pi-questionnaire-timeout-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  cpSync(installed, root, { recursive: true });
  if (prepare) { patchQuestionnaireTimeout(root); patchQuestionnaireTimeout(root); }
  const agentDir = join(home, '.pi/agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [root] }));
  const settingsManager = SettingsManager.create(home, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: home, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: SessionManager.inMemory(home), tools: ['ask_user_question'] });
  t.after(() => session.dispose());
  initTheme('dark', false);
  const display = host(mode);
  // A legacy dialog host advertises TUI mode but cannot render custom components.
  await session.bindExtensions({ mode: mode === 'rpc' ? 'rpc' : 'tui', uiContext: mode === 'none' ? undefined : display.ui });
  const tool = session.agent.state.tools.find(item => item.name === 'ask_user_question');
  assert.ok(tool, 'actual pinned package must register the SDK-wrapped tool');
  let sequence = 0;
  return { root, display, execute: (input = params, signal) => tool.execute(`question-${++sequence}`, input, signal) };
}

function observe(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}
function clock(t) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); }
function automatic(result, expected) {
  assert.equal(result.details.cancelled, false);
  assert.equal(result.details.automatic, true);
  assert.equal(result.details.answers[0].answer, expected);
  assert.equal(result.details.answers[0].automatic, true);
  assert.match(result.content.map(item => item.text ?? '').join('\n'), /automatic.*not.*authoriz/is);
}

for (const mode of ['tui', 'rpc', 'legacy']) {
  it(`REQ-AGENT-218 AC1/AC4 / REQ-AGENT-220 AC2: ${mode} selects option one only after five unanswered minutes`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); clock(t);
    const result = f.execute(); const state = observe(result);
    await f.display.wait();
    t.mock.timers.tick(299999); await turn(); assert.equal(state.settled, false);
    t.mock.timers.tick(1); await turn();
    assert.equal(state.settled, true, 'five-minute deadline must release the SDK tool');
    automatic(await result, 'Small change (Recommended)');
    assert.equal(f.display.view.active, false, 'host wait must be released, not just raced');
  });

  for (const action of ['option', 'custom', 'cancel', 'abort']) {
    it(`REQ-AGENT-218 AC2 / REQ-AGENT-219 AC1/AC4: ${mode} preserves ${action} before timeout and isolates the next invocation`, { timeout: 20000 }, async t => {
      const f = await fixture(t, mode); clock(t);
      const controller = new AbortController();
      const first = f.execute(params, controller.signal); await f.display.wait();
      t.mock.timers.tick(299999);
      if (action === 'abort') controller.abort();
      else if (mode === 'tui') {
        if (action === 'cancel') f.display.key('\x1b');
        else {
          f.display.key('\x1b[B');
          if (action === 'custom') { f.display.key('\x1b[B'); f.display.key('My own answer'); }
          f.display.key('\r');
        }
      } else if (action === 'cancel') f.display.answer(undefined);
      else if (action === 'option') f.display.answer('2. Different approach');
      else { f.display.answer('3. Type something.'); await f.display.wait(); f.display.answer('My own answer'); }
      const state = observe(first); await turn();
      assert.equal(state.settled, true, `${action} must finish without waiting for timeout`);
      const result = await first;
      assert.notEqual(result.details.automatic, true);
      if (action === 'cancel' || action === 'abort') assert.equal(result.details.cancelled, true);
      else assert.equal(result.details.answers[0].answer, action === 'custom' ? 'My own answer' : 'Different approach');
      assert.equal(f.display.view.active, false);
      const second = f.execute(); const secondState = observe(second); await f.display.wait();
      t.mock.timers.tick(1); await turn(); assert.equal(secondState.settled, false, 'prior deadline cannot finish a new questionnaire');
      if (mode === 'tui') { f.display.key('\x1b[B'); f.display.key('\r'); }
      else f.display.answer('2. Different approach');
      assert.equal((await second).details.answers[0].answer, 'Different approach');
      t.mock.timers.tick(600000); await turn(); assert.equal(f.display.view.active, false);
    });
  }

  it(`REQ-AGENT-218 AC3: ${mode} retains completed answers and defaults only unanswered questions on one deadline`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); clock(t);
    const mixed = { questions: [question(), { ...question(true), question: 'Which checks?', header: 'Checks' }] };
    const result = f.execute(mixed); await f.display.wait();
    t.mock.timers.tick(200000);
    if (mode === 'tui') { f.display.key('\x1b[B'); f.display.key('\r'); }
    else { f.display.answer('2. Different approach'); await f.display.wait(); }
    t.mock.timers.tick(100000); await turn();
    assert.equal((await result).details.answers[0].answer, 'Different approach');
    assert.notEqual((await result).details.answers[0].automatic, true);
    assert.deepEqual((await result).details.answers[1].selected, ['Small change (Recommended)']);
    assert.equal((await result).details.answers[1].automatic, true);
    assert.equal((await result).details.automatic, true);
    assert.equal(f.display.view.active, false);
    const next = f.execute(); await f.display.wait();
    if (mode === 'tui') f.display.key('\x1b'); else f.display.answer(undefined);
    assert.equal((await next).details.cancelled, true, 'timed-out invocation cannot influence its successor');
  });

  it(`REQ-AGENT-219 AC1/AC5: ${mode} abort preserves completed answers without defaulting unanswered questions`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); clock(t);
    const controller = new AbortController();
    const result = f.execute({ questions: [question(), { ...question(), question: 'Which next step?', header: 'Next step' }] }, controller.signal);
    await f.display.wait();
    if (mode === 'tui') { f.display.key('\x1b[B'); f.display.key('\r'); }
    else { f.display.answer('2. Different approach'); await f.display.wait(); }
    controller.abort();
    const value = await result;
    assert.equal(value.details.cancelled, true);
    assert.equal(value.details.answers.length, 1);
    assert.equal(value.details.answers[0].answer, 'Different approach');
    assert.notEqual(value.details.automatic, true);
    t.mock.timers.tick(300000); await turn(); assert.equal(f.display.view.active, false);
  });

  it(`REQ-AGENT-219 AC2/AC3: ${mode} never manufactures answers for aborted or invalid questions`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); clock(t);
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.execute(params, controller.signal)).details.cancelled, true);
    assert.equal(f.display.view.active, false);
    const result = await f.execute({ questions: [] });
    assert.equal(result.details.cancelled, true); assert.ok(result.details.error);
    t.mock.timers.tick(300000); await turn();
    assert.notEqual(result.details.automatic, true); assert.equal(f.display.view.active, false);
  });
}

it('REQ-AGENT-218 AC3: TUI timeout preserves completed and currently edited notes', { timeout: 20000 }, async t => {
  const f = await fixture(t); clock(t);
  const result = f.execute({ questions: [question(), { ...question(), header: 'Second', question: 'Which next step?' }] });
  await f.display.wait();
  f.display.key('n'); f.display.key('Keep the security guard'); f.display.key('\r');
  f.display.key('\x1b[B'); f.display.key('\r');
  f.display.key('n'); f.display.key('Retain this pending note');
  t.mock.timers.tick(300000); await turn();
  const answers = (await result).details.answers;
  assert.equal(answers[0].answer, 'Different approach');
  assert.equal(answers[0].notes, 'Keep the security guard');
  assert.equal(answers[1].notes, 'Retain this pending note');
  assert.equal(answers[1].automatic, true);
  assert.equal(f.display.view.active, false);
});

for (const mode of ['tui', 'rpc']) {
  it(`REQ-AGENT-218 AC3: ${mode} preserves manual multiple selections while defaulting another question`, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode); clock(t);
    const result = f.execute({ questions: [question(true), { ...question(), header: 'Second', question: 'Which next step?' }] });
    await f.display.wait();
    if (mode === 'tui') {
      f.display.key(' '); f.display.key('\x1b[B'); f.display.key(' ');
      // The public Tab navigation commits the current multi-select answer.
      f.display.key('\t');
    } else { f.display.answer('1,2'); await f.display.wait(); }
    t.mock.timers.tick(300000); await turn();
    const answers = (await result).details.answers;
    assert.deepEqual(answers[0].selected, ['Small change (Recommended)', 'Different approach']);
    assert.notEqual(answers[0].automatic, true);
    assert.equal(answers[1].automatic, true);
    assert.equal(f.display.view.active, false);
  });
}

it('REQ-AGENT-219 AC4: independent SDK sessions retain independent deadlines', { timeout: 20000 }, async t => {
  const first = await fixture(t, 'rpc'); const second = await fixture(t, 'rpc'); clock(t);
  const one = first.execute(); await first.display.wait(); t.mock.timers.tick(200000);
  const two = second.execute(); const secondState = observe(two); await second.display.wait();
  t.mock.timers.tick(100000); await turn(); automatic(await one, 'Small change (Recommended)');
  assert.equal(secondState.settled, false);
  second.display.answer('2. Different approach');
  assert.equal((await two).details.answers[0].answer, 'Different approach');
  t.mock.timers.tick(300000); await turn();
  assert.equal(first.display.view.active, false); assert.equal(second.display.view.active, false);
});

it('REQ-AGENT-219 AC3: absent UI remains an error, not automatic approval', async t => {
  const f = await fixture(t, 'none'); clock(t);
  const result = await f.execute();
  assert.equal(result.details.error, 'no_ui');
  t.mock.timers.tick(300000); await turn(); assert.notEqual(result.details.automatic, true);
});

for (const damage of ['version', 'layout']) {
  it(`REQ-AGENT-220 AC1: source allowlist rejects ${damage} drift without partially patching the package`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'questionnaire-patch-drift-'));
    t.after(() => rmSync(root, { recursive: true, force: true })); cpSync(installed, root, { recursive: true });
    const manifest = join(root, 'package.json'); const first = join(root, 'ask-user-question.ts');
    const source = damage === 'layout' ? join(root, 'state/questionnaire-session.ts') : first;
    if (damage === 'version') writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest)), version: '0.0.0' }));
    else writeFileSync(source, readFileSync(source, 'utf8') + '\n// unexpected layout\n');
    const before = readFileSync(source); const firstBefore = readFileSync(first);
    assert.throws(() => patchQuestionnaireTimeout(root), /version|source|layout/i);
    assert.deepEqual(readFileSync(source), before, 'source allowlist is an atomic installed-artifact contract');
    assert.deepEqual(readFileSync(first), firstBefore, 'a rejected later artifact must not leave the entry tool partially prepared');
  });
}
