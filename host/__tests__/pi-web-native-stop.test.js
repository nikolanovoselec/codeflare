import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const extensionUrl = new URL('../../image/pi-web/handoff-extension.ts', import.meta.url);
// Exercise the real extension against Pi's public extension boundary without a TUI or installed image.
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const home = mkdtempSync(join(tmpdir(), 'native-pi-stop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, 'workspace');
  const agentDir = join(home, '.pi', 'agent');
  const id = 'native-conversation';
  const path = join(agentDir, 'sessions', `--${cwd.slice(1).replaceAll('/', '-')}--`, `timestamp_${id}.jsonl`);
  const binding = { id, cwd, path };
  const header = { type: 'session', id, cwd, version: 3, timestamp: '2026-01-01T00:00:00.000Z' };
  const dir = join(home, 'pi-web');
  for (const directory of [cwd, dir, dirname(path)]) mkdirSync(directory, { recursive: true });
  const transcript = JSON.stringify(header) + '\n';
  writeFileSync(path, transcript);

  const env = {
    HOME: home, PI_CODING_AGENT_DIR: agentDir, CODEFLARE_RUNTIME_ROOT: home, HERDR_ENV: '0',
    CODEFLARE_PI_GENERATION: '7', CODEFLARE_PI_TERMINAL_TICKET: 'terminal-ticket',
    CODEFLARE_PI_TERMINAL_PID: String(process.pid), SESSION_ID: 'fixture123',
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }

  const url = new URL(extensionUrl);
  url.searchParams.set('fixture', home);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === url.href && specifier === '@earendil-works/pi-coding-agent') {
        return { url: 'data:text/javascript,export class CustomEditor {}', shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const { default: install } = await import(url).finally(() => hooks.deregister());

  const owner = (phase, overrides = {}) => writeFileSync(join(dir, 'owner.json'), JSON.stringify({
    generation: 7, terminalTicket: 'terminal-ticket', surface: 'terminal', binding, phase,
    ...(phase !== 'active' && { target: 'chat', requestId: 'switch-7' }), ...overrides,
  }));
  const receipt = () => JSON.parse(readFileSync(join(dir, 'terminal.json'), 'utf8'));
  let draft = 'unsent draft';
  let queued = [];
  let running = false;
  let aborted = false;
  let closed = false;
  let editor;
  const submitted = [];
  let submission;
  let pending = 0;
  const preflightKey = Symbol.for('codeflare.pi.nativePromptPending');
  globalThis[preflightKey] = () => pending > 0;
  t.after(() => { delete globalThis[preflightKey]; });
  let handleSubmission = () => {};
  let factory = () => ({});
  const handlers = new Map();
  const emit = (name, details) => handlers.get(name)?.(details, context);
  const context = {
    mode: 'tui',
    sessionManager: {
      getHeader: () => header, getCwd: () => cwd, getSessionFile: () => path, getSessionId: () => id, getLeafId: () => null,
    },
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent(next) {
        factory = next;
        editor = factory({ getFocusedComponent: () => editor, hasOverlay: () => false }, {}, {});
        editor.onSubmit = (value) => {
          submitted.push(value);
          // Native editor dispatch returns synchronously; Pi awaits the actual input separately.
          pending++;
          submission = Promise.resolve(handleSubmission(value)).finally(() => { pending--; });
        };
      },
      onTerminalInput: () => () => {},
      setEditorText: (value) => { draft = value; },
      getEditorText: () => draft,
    },
    isIdle: () => !running,
    hasPendingMessages: () => queued.length > 0,
    abort() {
      if (running) aborted = true; // Pi 1.5.2 latches this during before_agent_start, too.
      draft = [...queued, draft].join('\n\n');
      queued = [];
    },
    shutdown() {
      closed = true;
      emit('session_shutdown', { reason: 'quit' });
    },
  };
  owner('active');
  install({ on: (event, handler) => handlers.set(event, handler) });
  emit('session_start', { reason: 'startup' });
  emit('resources_discover');
  return {
    owner, receipt, binding, emit,
    tick: () => t.mock.timers.tick(250),
    async submit(text) {
      const previous = submission;
      await editor.onSubmit(text);
      if (submission !== previous) await submission;
    },
    handleSubmission: handler => { handleSubmission = handler; },
    get submitted() { return submitted; },
    get draft() { return draft; },
    get closed() { return closed; },
    queue: (text) => queued.push(text),
    begin() { running = true; aborted = false; emit('before_agent_start'); },
    finish() { running = false; return aborted ? 'aborted' : 'replied'; },
    readTranscript: () => readFileSync(path, 'utf8'), transcript,
  };
}

test('REQ-AGENT-272 AC3+AC6: stopping fences the terminal and aborts the admitted pre-stream turn before release', async (t) => {
  const f = await fixture(t);
  const source = f.receipt();
  let start;
  f.handleSubmission(async () => {
    f.emit('input', { source: 'interactive', text: 'already admitted' });
    await new Promise(resolve => { start = resolve; });
    f.begin();
  });
  const admitted = f.submit('already admitted');
  f.owner('stopping');
  f.tick();
  assert.equal(f.receipt().idle, false, 'an admitted input hook can look idle to Pi');
  assert.equal(f.receipt().stopRequested, undefined, 'an abort before the run exists would not stop it');
  await f.submit('not admitted');
  assert.deepEqual(f.submitted, ['already admitted']);
  assert.equal(f.draft, 'not admitted');

  f.queue('queued follow-up');
  start();
  await admitted;
  assert.equal(f.finish(), 'aborted');
  f.tick();
  const settled = f.receipt();
  for (const key of ['generation', 'pid', 'startTime', 'instance', 'ticket', 'id', 'cwd', 'path']) {
    assert.equal(settled[key], source[key], `settlement must identify the same writer: ${key}`);
  }
  assert.equal(settled.stopRequested, 'switch-7');
  assert.equal(settled.idle, true);
  assert.equal(f.closed, false, 'stop evidence must not close the source writer');
  f.owner('releasing');
  f.tick();
  assert.equal(f.closed, true);
  assert.equal(f.receipt().releaseReady, 'switch-7');
  assert.equal(f.receipt().released, true);
  assert.equal(f.receipt().stopRequested, undefined, 'abort receipt belongs only to stopping');
  assert.equal(f.receipt().draft, 'queued follow-up\n\nnot admitted');
  assert.equal(f.readTranscript(), f.transcript);
});

test('REQ-AGENT-272 AC3: agent_start catches the exact switch between polls when a before_agent_start hook unblocks', async (t) => {
  const f = await fixture(t);
  f.begin();
  f.queue('queued follow-up');
  for (const mismatch of [
    { generation: 6 }, { terminalTicket: 'stale-ticket' }, { binding: { ...f.binding, id: 'different' } },
    { target: 'terminal' }, { surface: 'chat' }, { requestId: undefined },
  ]) {
    f.owner('stopping', mismatch);
    f.tick();
    assert.equal(f.draft, 'unsent draft');
    assert.equal(f.receipt().stopRequested, undefined);
  }
  f.owner('stopping');
  f.emit('agent_start');
  assert.equal(f.receipt().stopRequested, 'switch-7');
  assert.equal(f.receipt().idle, false, 'dispatch proves neither settlement nor release');
  assert.equal(f.finish(), 'aborted');
  f.tick();
  assert.equal(f.receipt().idle, true);
  assert.equal(f.draft, 'queued follow-up\n\nunsent draft');
});

test('REQ-AGENT-272: a consumed interactive input blocks release only until its hook returns', async (t) => {
  const f = await fixture(t);
  let finishInput;
  f.handleSubmission(async () => {
    f.emit('input', { source: 'interactive', text: 'handled locally' });
    await new Promise(resolve => { finishInput = resolve; });
    // The extension consumes this input; no before_agent_start is emitted.
  });
  const submitted = f.submit('handled locally');
  f.owner('stopping');
  f.tick();
  assert.equal(f.receipt().idle, false);
  assert.equal(f.receipt().stopRequested, undefined);
  finishInput();
  await submitted;
  f.tick();
  assert.equal(f.receipt().idle, true);
  assert.equal(f.receipt().stopRequested, 'switch-7');
  f.owner('releasing');
  f.tick();
  assert.equal(f.closed, true);
  assert.equal(f.receipt().released, true);
  assert.equal(f.readTranscript(), f.transcript);
});

test('REQ-AGENT-272: normal native quit records exact retirement without forging a switch receipt', async (t) => {
  const f = await fixture(t);
  const source = f.receipt();
  f.emit('session_shutdown', { reason: 'quit' });
  const retired = f.receipt();
  assert.equal(retired.quit, true);
  assert.equal(retired.released, undefined);
  assert.equal(retired.releaseReady, undefined);
  for (const key of ['pid', 'startTime', 'generation', 'instance', 'ticket', 'id', 'cwd', 'path', 'leaf']) {
    assert.equal(retired[key], source[key], `native quit identifies the exact writer and branch: ${key}`);
  }
  assert.equal(f.readTranscript(), f.transcript);
});
