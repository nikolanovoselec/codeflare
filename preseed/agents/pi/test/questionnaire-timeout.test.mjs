import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, TuiMainScreen } from '@earendil-works/pi-tui';
import { patchQuestionnaireTimeout } from '../../../../scripts/patch-rpiv-question-timeout.mjs';

const installed = dirname(fileURLToPath(import.meta.resolve('@juicesharp/rpiv-ask-user-question')));
const archives = {
  '2.12.0': 'f407893638f1893a3730444f467b4edc1924cf2d206ae584f7525e1e8ae860f6',
  '2.13.8': '1c27ed656cf56b0af7eb45d1e4240fc3c9e3e064a05880f15acc380893159cd5',
};
const artifacts = ['package.json', 'ask-user-question.ts', 'state/questionnaire-session.ts', 'codeflare-question-timeout.mjs'];
function pristine(t, version) {
  // Keep authentic package bytes beside the installation so unchanged host peers resolve.
  const root = mkdtempSync(join(dirname(installed), '.codeflare-questionnaire-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = fileURLToPath(new URL(`../../../../host/__fixtures__/rpiv-ask-user-question-${version}.tgz`, import.meta.url));
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), archives[version],
    'reviewed npm archive integrity contract');
  execFileSync('tar', ['-xzf', archive, '-C', root, '--strip-components=1', '--no-same-owner']);
  return root;
}
function artifactSnapshot(root) {
  return artifacts.map(name => {
    const path = join(root, name);
    return existsSync(path) ? { bytes: readFileSync(path), symlink: lstatSync(path).isSymbolicLink() } : null;
  });
}
const question = (multiSelect = false) => ({ question: 'Which implementation?', header: 'Approach', multiSelect,
  options: [{ label: 'Small change (Recommended)', description: 'Preserve existing ownership.' },
    { label: 'Different approach', description: 'Use the alternative implementation.' }] });
const params = { questions: [question()] };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Only the terminal/native-dialog host and the platform clock are substituted.
// The package, schema, questionnaire session, reducer, renderer and SDK tool are real.
function host(mode, { deferMount = false } = {}) {
  const terminal = { columns: 120, rows: 40, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new TuiMainScreen(terminal);
  const foreground = 'accent border borderAccent borderMuted success error warning muted dim text thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode';
  const background = 'selectedBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg';
  const colors = keys => Object.fromEntries(keys.split(' ').map(key => [key, '']));
  const theme = new Theme(colors(foreground), colors(background), 'truecolor');
  const view = { active: false, component: undefined, dialog: undefined, pending: undefined };
  const mounts = [];
  const listeners = new Set();
  const deferred = [];
  let mountRequested;
  function refresh() {
    const top = mounts.at(-1);
    view.active = mounts.length > 0;
    view.component = top?.component;
    view.pending = top?.finish;
  }
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
    waitForMount: () => deferred.length ? Promise.resolve() : new Promise(resolve => { mountRequested = resolve; }),
    mount() { assert.ok(deferred.length, 'the host must have a deferred custom screen'); deferred.shift()(); },
    hasOverlay: () => tui.hasOverlay(),
    showOverlay() { return tui.showOverlay({ render: () => ['Existing host overlay'], invalidate() {} }); },
    render() { assert.ok(view.component); return view.component.render(120); },
    answer(value) { assert.ok(view.pending, 'a real host dialog must be waiting'); view.pending(value); },
    choose(index) {
      assert.equal(view.dialog?.kind, 'select', 'native choices must answer a select dialog');
      const offered = view.dialog.options[index];
      assert.equal(typeof offered, 'string', 'native choices must use an offered option');
      this.answer(offered);
    },
    key(data) {
      assert.ok(view.active && view.component);
      for (const listener of listeners) if (listener(data)?.consume) return;
      const top = [...mounts].reverse().find(mount => !mount.handle?.isHidden());
      assert.ok(top, 'a visible custom screen must own input');
      top.component.handleInput(data);
    },
    ui: { theme, notify() {}, setStatus() {},
      onTerminalInput(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      custom(factory, options) {
        if (mode !== 'tui') return Promise.resolve(undefined);
        return new Promise((resolve, reject) => {
          const mount = { component: undefined, handle: undefined, finished: false, finish: undefined };
          mount.finish = value => {
            if (mount.finished) return;
            mount.finished = true;
            const index = mounts.indexOf(mount);
            if (index >= 0) mounts.splice(index, 1);
            if (mount.handle) mount.handle.hide();
            else if (mount.component) tui.removeChild(mount.component);
            mount.component?.dispose?.();
            refresh();
            resolve(value);
          };
          const show = () => {
            try {
              mount.component = factory(tui, theme, getKeybindings(), mount.finish);
              // Like Pi, discard a factory that resolved before it mounted (inline yield).
              if (mount.finished) return;
              if (options?.overlay) {
                mount.handle = tui.showOverlay(mount.component, options.overlayOptions);
                options.onHandle?.(mount.handle);
              } else {
                tui.addChild(mount.component);
                tui.setFocus(mount.component);
              }
              mounts.push(mount);
              refresh();
              publish(mount.component.render(120));
            } catch (error) { reject(error); }
          };
          if (deferMount) {
            deferred.push(show); mountRequested?.(); mountRequested = undefined;
          } else show();
        });
      },
      select(title, options, opts) { return dialog('select', title, options, opts); },
      input(title, placeholder, opts) { return dialog('input', title, placeholder, opts); },
    },
  };
}

async function questionnaireFixture(t, version, mode = 'tui', options) {
  const root = pristine(t, version);
  const home = mkdtempSync(join(tmpdir(), 'pi-questionnaire-timeout-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  patchQuestionnaireTimeout(root);
  const prepared = artifactSnapshot(root);
  patchQuestionnaireTimeout(root);
  assert.deepEqual(artifactSnapshot(root), prepared, 'repeat preparation preserves the generated-artifact contract');
  const agentDir = join(home, '.pi/agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [root] }));
  const settingsManager = SettingsManager.create(home, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.deepEqual(resourceLoader.getExtensions().warnings ?? [], []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: home, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: SessionManager.inMemory(home), tools: ['ask_user_question'] });
  t.after(() => session.dispose());
  initTheme('dark', false);
  const display = host(mode, options);
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

for (const version of Object.keys(archives)) {
  describe(`authentic questionnaire ${version}`, () => {
    const fixture = (t, mode = 'tui', options) => questionnaireFixture(t, version, mode, options);

    it('REQ-AGENT-218 AC1: the five-minute deadline starts at the mounted questionnaire, not the queued host request', { timeout: 20000 }, async t => {
      const f = await fixture(t, 'tui', { deferMount: true }); clock(t);
      const result = f.execute(); const state = observe(result);
      await f.display.waitForMount();
      t.mock.timers.tick(600000); await turn();
      assert.equal(state.settled, false);
      assert.equal(f.display.view.active, false, 'the host has not shown the questionnaire yet');
      f.display.mount(); await f.display.wait();
      t.mock.timers.tick(299999); await turn(); assert.equal(state.settled, false);
      t.mock.timers.tick(1); await turn();
      assert.equal(state.settled, true);
      automatic(await result, 'Small change (Recommended)');
      assert.equal(f.display.view.active, false);
    });

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
          else if (action === 'option') f.display.choose(1);
          else { f.display.choose(2); await f.display.wait(); f.display.answer('My own answer'); }
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
          else f.display.choose(1);
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
        else { f.display.choose(1); await f.display.wait(); }
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
        else { f.display.choose(1); await f.display.wait(); }
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
          if (version === '2.13.8') {
            f.display.key('\x1b[B'); f.display.key('Also retain the audit log'); f.display.key('\r');
          } else {
            // The public Tab navigation commits the current multi-select answer.
            f.display.key('\t');
          }
        } else {
          f.display.answer(version === '2.13.8' ? '1,2; Also retain the audit log' : '1,2');
          await f.display.wait();
        }
        t.mock.timers.tick(300000); await turn();
        const answers = (await result).details.answers;
        assert.deepEqual(answers[0].selected, ['Small change (Recommended)', 'Different approach']);
        assert.equal(answers[0].answer, version === '2.13.8' ? 'Also retain the audit log' : null);
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
      second.display.choose(1);
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

    if (version === '2.13.8') {
      it('inline yield remounts visibly over an existing overlay and releases the slot after timeout', { timeout: 20000 }, async t => {
        const f = await fixture(t, 'tui', { deferMount: true }); clock(t);
        const background = f.display.showOverlay();
        t.after(() => background.hide());
        const result = f.execute(); const state = observe(result);
        await f.display.waitForMount(); f.display.mount(); // The inline factory yields without displaying questions.
        await f.display.waitForMount();
        t.mock.timers.tick(600000); await turn();
        assert.equal(state.settled, false, 'yielding the slot must not start the questionnaire deadline');
        assert.equal(f.display.view.active, false);
        f.display.mount(); await f.display.wait();
        assert.match(f.display.render().join('\n'), /Which implementation\?/);
        assert.equal(background.isFocused(), false, 'the visible questionnaire owns focus above the host overlay');
        t.mock.timers.tick(299999); await turn();
        assert.equal(state.settled, false);
        t.mock.timers.tick(1); await turn();
        automatic(await result, 'Small change (Recommended)');
        assert.equal(f.display.view.active, false);
        assert.equal(background.isFocused(), true, 'completion restores the existing host overlay');
        assert.equal(background.isHidden(), false);
        background.hide();
        const next = f.execute(); await f.display.waitForMount(); f.display.mount(); await f.display.wait();
        assert.equal(f.display.hasOverlay(), false, 'the released slot accepts another inline questionnaire');
        f.display.key('\x1b'); assert.equal((await next).details.cancelled, true);
      });

      it('concurrent inline and overlay questionnaires keep independent deadlines and release their input ownership', { timeout: 20000 }, async t => {
        const f = await fixture(t); clock(t);
        const first = f.execute(); await f.display.wait();
        assert.equal(f.display.hasOverlay(), false);
        t.mock.timers.tick(200000);
        const second = f.execute(); const secondState = observe(second); await f.display.wait();
        assert.equal(f.display.hasOverlay(), true, 'the second questionnaire must not replace the occupied inline screen');
        f.display.key('\x1d'); f.display.key('\x1d'); // Hide and reopen through native terminal input.
        t.mock.timers.tick(100000); await turn();
        automatic(await first, 'Small change (Recommended)');
        assert.equal(secondState.settled, false);
        assert.match(f.display.render().join('\n'), /Which implementation\?/);
        t.mock.timers.tick(199999); await turn(); assert.equal(secondState.settled, false);
        t.mock.timers.tick(1); await turn();
        automatic(await second, 'Small change (Recommended)');
        assert.equal(f.display.view.active, false);
        assert.equal(f.display.hasOverlay(), false);
        const next = f.execute(); await f.display.wait();
        assert.equal(f.display.hasOverlay(), false);
        f.display.key('\x1d');
        assert.match(f.display.render().join('\n'), /expand/i, 'a retired overlay listener cannot consume the next inline screen’s collapse key');
        f.display.key('\x1d');
        assert.match(f.display.render().join('\n'), /Which implementation\?/);
        f.display.key('\x1b'); assert.equal((await next).details.cancelled, true);
      });

      for (const ending of ['timeout', 'abort']) {
        it(`RPC custom-input cancellation returns to choices without resetting the deadline (${ending})`, { timeout: 20000 }, async t => {
          const f = await fixture(t, 'rpc'); clock(t);
          const controller = new AbortController();
          const result = f.execute(params, controller.signal); const state = observe(result);
          const initialChoices = [...(await f.display.wait()).options]; t.mock.timers.tick(200000);
          f.display.choose(2); await f.display.wait();
          f.display.answer(undefined);
          const choices = await f.display.wait();
          assert.equal(choices.kind, 'select');
          assert.deepEqual(choices.options, initialChoices, 'cancelling custom input restores the offered choices');
          t.mock.timers.tick(99999); await turn(); assert.equal(state.settled, false);
          if (ending === 'abort') controller.abort(); else t.mock.timers.tick(1);
          await turn(); assert.equal(state.settled, true);
          const value = await result;
          if (ending === 'timeout') automatic(value, 'Small change (Recommended)');
          else {
            assert.equal(value.details.cancelled, true);
            assert.deepEqual(value.details.answers, []);
            assert.notEqual(value.details.automatic, true);
          }
          assert.equal(f.display.view.active, false);
        });
      }

      it('ordinary partial submit retains unanswered questions without automatic answers', { timeout: 20000 }, async t => {
        const f = await fixture(t); clock(t);
        const result = f.execute({ questions: [question(), { ...question(), header: 'Second', question: 'Which next step?' }] });
        await f.display.wait(); t.mock.timers.tick(200000);
        f.display.key('\x1b[B'); f.display.key('\r'); // Complete the first question.
        f.display.key('\t'); f.display.key('\r'); // Skip the second and submit from review.
        const value = await result;
        assert.equal(value.details.cancelled, false);
        assert.notEqual(value.details.automatic, true);
        assert.deepEqual(value.details.unanswered, [1]);
        assert.equal(value.details.answers.length, 1);
        assert.equal(value.details.answers[0].answer, 'Different approach');
        assert.notEqual(value.details.answers[0].automatic, true);
        assert.match(value.content.map(item => item.text ?? '').join('\n'), /unanswered: "Which next step\?"/);
        t.mock.timers.tick(300000); await turn();
        assert.equal(f.display.view.active, false);
        assert.deepEqual(value.details.unanswered, [1]);
      });
    }

    for (const damage of ['version', 'identity', 'version/source', 'entry', 'layout', 'patched-layout',
      ...artifacts.map(path => `symlink:${path}`)]) {
      it(`REQ-AGENT-220 AC1: source allowlist rejects ${damage} drift without source or helper writes`, t => {
        const root = pristine(t, version);
        const manifest = join(root, 'package.json');
        const source = join(root, damage === 'entry' ? 'ask-user-question.ts' : 'state/questionnaire-session.ts');
        const helper = join(root, 'codeflare-question-timeout.mjs');
        if (damage === 'patched-layout') patchQuestionnaireTimeout(root);
        // Cover both an absent helper and an existing destination that must not be overwritten.
        if (damage !== 'version') writeFileSync(helper, 'existing helper must survive rejected preparation\n');
        if (['version', 'identity', 'version/source'].includes(damage)) {
          const value = JSON.parse(readFileSync(manifest));
          if (damage === 'identity') value.name = '@unrelated/questionnaire';
          else value.version = damage === 'version' ? '0.0.0' : version === '2.12.0' ? '2.13.8' : '2.12.0';
          writeFileSync(manifest, JSON.stringify(value));
        } else if (damage.startsWith('symlink:')) {
          const path = join(root, damage.slice('symlink:'.length));
          renameSync(path, `${path}.target`); symlinkSync(`${path}.target`, path);
        } else writeFileSync(source, readFileSync(source, 'utf8') + '\n// unexpected source drift\n');
        const before = artifactSnapshot(root);
        assert.throws(() => patchQuestionnaireTimeout(root), /identity|version|source|layout|unsafe/i);
        assert.deepEqual(artifactSnapshot(root), before,
          'source allowlist and symlink defenses reject before mutating any installed source or helper artifact');
      });
    }
  });
}
