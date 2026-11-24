// Built-image smoke, not a local test. RED unobserved: the packaged services only run in CI.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const WEB_ROOT = process.env.CODEFLARE_PI_WEB_SMOKE_ROOT ?? '/opt/codeflare/pi-web';
const WEB_PACKAGE = '@jmfederico/pi-web';
const WEB_DIST = join(WEB_ROOT, 'node_modules', WEB_PACKAGE, 'dist');
const PI = process.env.CODEFLARE_PI_WEB_SMOKE_CLI ?? '/usr/local/bin/pi';
const PI_PACKAGE_DIR = process.env.CODEFLARE_PI_WEB_SMOKE_PI_PACKAGE ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';
const PROVIDER = 'handoff-fixture';
const MODEL = 'handoff-text';
const TURNS = [
  ['Native → Chat\nKeep this exact.', 'Native reply: α.'],
  ['Chat → Native\nKeep this exact too.', 'Chat reply: β.'],
];

const run = promisify(execFile);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const parseTranscript = (raw) => raw.trimEnd().split('\n').map((line) => JSON.parse(line));
const chatMessages = (messages) => messages.filter(({ role }) => role === 'user' || role === 'assistant');
const text = (content) => typeof content === 'string' ? content : content.map((block) => block.text).join('');
const visible = (messages) => chatMessages(messages).map(({ role, content }) => [role, text(content)]);
const expected = (turns) => turns.flatMap(([prompt, reply]) => [['user', prompt], ['assistant', reply]]);
const durableChat = (entries) => entries.filter(({ type, message }) =>
  type === 'message' && (message.role === 'user' || message.role === 'assistant'));
const looksIdle = ({ isStreaming, isCompacting, isBashRunning, pendingMessageCount, pendingDialogs }) =>
  isStreaming === false && isCompacting === false && isBashRunning === false && pendingMessageCount === 0 && !pendingDialogs?.length;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await promisify(server.close.bind(server))();
}

// The only model endpoint is a loopback SSE fixture. No Pi events or session files are mocked.
let modelRequests = 0;
const modelServer = createServer(async (req, res) => {
  modelRequests++;
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { model, messages } = JSON.parse(raw);
    const prompt = messages.findLast(({ role }) => role === 'user');
    const turn = TURNS.find(([input]) => input === text(prompt.content));
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || model !== MODEL || !turn) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Unexpected smoke model request"}');
      return;
    }
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
      id: 'handoff-completion', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: turn[1] }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Invalid smoke model request"}');
  }
});

function launch(file, args, { env, cwd }, rpc = false) {
  const child = spawn(file, args, { env, cwd, stdio: [rpc ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let log = '';
  const record = (chunk) => { log = (log + chunk).slice(-8192); };
  if (!rpc) child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.on('error', (error) => record(error.message));
  // Resolve on close (including a failed spawn) without leaving an unhandled exit rejection.
  const done = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return {
    child, done, log: () => log,
    async stop() {
      child.kill('SIGTERM');
      if (await Promise.race([done, delay(5000, null, { ref: false })]) === null) {
        child.kill('SIGKILL');
        await done;
      }
    },
  };
}

async function reopenNative(sessionFile, options) {
  const native = launch(PI, ['--mode', 'rpc', '--session', sessionFile], options, true);
  const lines = createInterface({ input: native.child.stdout });
  const commands = ['get_state', 'get_messages', 'get_entries'];
  try {
    const read = async () => {
      const responses = {};
      native.child.stdin.on('error', () => {}); // Early exit is reported by missing responses and stderr.
      for (const type of commands) native.child.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
      for await (const line of lines) {
        const response = JSON.parse(line);
        if (response.type !== 'response' || !commands.includes(response.id)) continue;
        assert.equal(response.success, true, `native RPC ${response.id}: ${response.error ?? ''}`);
        responses[response.id] = response.data;
        if (commands.every((command) => responses[command] !== undefined)) break;
      }
      assert.equal(Object.keys(responses).length, commands.length, 'native Pi must reopen and read the session');
      native.child.stdin.end();
      assert.deepEqual(await native.done, { code: 0, signal: null }, 'native Pi must exit after EOF');
      return responses;
    };
    return await Promise.race([read(), delay(15_000, undefined, { ref: false }).then(() => {
      throw new Error('native Pi reopen timed out');
    })]);
  } catch (error) {
    throw new Error(`Native Pi reopen failed: ${native.log()}`, { cause: error });
  } finally {
    lines.close();
    await native.stop();
  }
}

async function waitFor(label, probe, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`, { cause: lastError });
}

// Opt-in on the CI Chrome runner, using its integrity-verified locked SDK tree.
async function probeStartupRefresh({ url, options, ref, cwd, id, title, status, answer, confirmed }) {
  const { CHROME_SDK_ROOT: sdk, CI_CHROMIUM_EXECUTABLE: chrome } = process.env;
  assert.ok(sdk && chrome, 'browser refresh probe needs the existing CI Chrome executable and locked SDK');
  const { puppeteer } = await import(pathToFileURL(join(sdk, 'out/Default/gen/src/third_party/index.js')).href);
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true, env: options.env, timeout: 15_000, protocolTimeout: 20_000,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--no-sandbox'], // Same disposable CI runner as browser-run-timeouts; no user profile.
  });
  try {
    const page = await browser.newPage();
    const findConfirm = async (sessionId, title, dialogId) => {
      const chat = document.querySelector('pi-web-app')?.shadowRoot?.querySelector('chat-view');
      if (chat?.sessionId !== sessionId) return false;
      const card = chat.shadowRoot?.querySelector('extension-dialog-card.open-dialog-card');
      if (!card?.dialog || (dialogId && card.dialog.dialogId !== dialogId)) return false;
      const heading = card.shadowRoot?.querySelector('.open-card h2');
      if (heading?.textContent !== title || !heading.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      // Include clipping by the stock transcript scroller, not just the HTML/CSS state.
      const inView = await new Promise((resolve) => {
        const observer = new IntersectionObserver(([{ intersectionRect }]) => {
          observer.disconnect();
          resolve(intersectionRect.width > 0 && intersectionRect.height > 0);
        });
        observer.observe(heading);
      });
      return inView && card.isConnected ? card : false;
    };
    const navigation = { waitUntil: 'domcontentloaded', timeout: 15_000 };
    assert.ok((await page.goto(url.href, navigation))?.ok(), 'stock Chat deep link must load');
    const before = await page.waitForFunction(findConfirm, { timeout: 12_000 }, id, title).catch((cause) => {
      throw new Error('No refresh evidence: the original stock Chat did not show the fixture confirm', { cause });
    });
    const dialogId = await before.evaluate((card) => card.dialog.dialogId);
    assert.ok(dialogId, 'the original Chat must show the native startup question');
    const readParked = async () => {
      const state = await status(); // Independent Node HTTP request; never feeds Chrome state.
      assert.equal(state.sessionId, id);
      assert.equal(state.persisted, true);
      assert.equal(state.pendingDialogs?.length, 1);
      const [dialog] = state.pendingDialogs;
      assert.equal(dialog.dialogId, dialogId);
      assert.equal(dialog.kind, 'confirm');
      assert.equal(dialog.title, title);
      assert.equal(dialog.runScoped, false);
      return dialog;
    };
    const parked = await readParked();

    const [, reloaded] = await Promise.all([
      page.waitForRequest((request) => {
        const target = new URL(request.url());
        return request.method() === 'GET' && target.origin === url.origin &&
          target.pathname === `${ref}/transcript-snapshot` && target.searchParams.get('cwd') === cwd;
      }, { timeout: 15_000 }),
      page.reload(navigation),
    ]);
    assert.ok(reloaded?.ok(), 'stock Chat must load again on refresh');
    const requireReloadedChat = () => page.waitForFunction((id, cwd) => {
      const chat = document.querySelector('pi-web-app')?.shadowRoot?.querySelector('chat-view');
      return performance.getEntriesByType('navigation')[0]?.type === 'reload' &&
        chat?.sessionId === id && chat.sessionCwd === cwd && chat.checkVisibility();
    }, { timeout: 5000 }, id, cwd);
    await requireReloadedChat();
    // Cover stock pi-web's 10s transcript fetch deadline, not just first paint.
    const observationMs = 12_000;
    const visible = await page.waitForFunction(findConfirm, { timeout: observationMs }, id, title, dialogId).catch((error) => {
      if (error.name !== 'TimeoutError') throw error;
      return null;
    });
    await requireReloadedChat();
    assert.deepEqual(await readParked(), parked, 'stock /status must still return the same parked confirm after refresh');

    if (visible) {
      const button = (await visible.evaluateHandle((card) => card.shadowRoot.querySelector('button.primary-action:enabled'))).asElement();
      assert.ok(button, 'the refreshed confirm must have an enabled answer control');
      await button.click();
    } else {
      // Finish the fixture only after recording absence in a loaded Chat. An API answer is not browser evidence.
      assert.equal((await answer(dialogId)).result, 'closed');
    }
    await waitFor('native session_start receives the diagnostic answer', async () => (await readFile(confirmed, 'utf8')) === id, 5000);
    return { visibleBeforeRefresh: true, visibleAfterRefresh: visible !== null, samePendingDialogViaStatus: true,
      diagnosticAnswerVia: visible ? 'browser' : 'api', observationMs };
  } finally {
    await browser.close();
  }
}

async function main() {
  const pin = (await readJson(join(WEB_ROOT, 'package.json'))).dependencies[WEB_PACKAGE];
  const installed = await readJson(join(WEB_DIST, '..', 'package.json'));
  assert.equal(installed.name, WEB_PACKAGE);
  assert.equal(installed.version, pin, 'image must contain the exactly pinned stock pi-web');
  const piPackage = await readJson(join(PI_PACKAGE_DIR, 'package.json'));
  assert.equal(await realpath(PI), await realpath(join(PI_PACKAGE_DIR, piPackage.bin.pi)),
    'stock pi-web must use the SDK that owns the packaged native CLI');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-smoke-')));
  const processes = [];
  try {
    const cwd = join(home, 'workspace');
    const agentDir = join(home, '.pi', 'agent');
    const sessions = join(agentDir, 'sessions');
    await mkdir(cwd);
    await mkdir(agentDir, { recursive: true });

    const modelPort = await listen(modelServer);
    const reserve = createServer();
    const webPort = await listen(reserve);
    await close(reserve);
    const origin = `http://127.0.0.1:${webPort}`;
    const env = {
      // Allowlist the environment; don't inherit model credentials, proxy vars, Git config, or real user state.
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
      PI_WEB_PI_PACKAGE_DIR: PI_PACKAGE_DIR, PI_WEB_RUNTIME: 'node',
      PI_WEB_HOST: '127.0.0.1', PI_WEB_PORT: String(webPort),
      PI_WEB_DATA_DIR: join(home, '.pi-web'), PI_WEB_SESSIOND_SOCKET: join(home, 'sessiond.sock'),
      PI_WEB_PLUGINS: JSON.stringify({ git: { enabled: false } }),
    };
    const options = { env, cwd };
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
      [PROVIDER]: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        apiKey: 'local-fixture-not-a-secret', models: [{ id: MODEL }] },
    } }));

    const confirmTitle = 'Resume the Pi handoff smoke transcript?';
    const confirmed = join(agentDir, 'startup-confirmed');
    const inputParked = join(agentDir, 'input-parked');
    const inputRelease = join(agentDir, 'input-release');
    const extensions = join(agentDir, 'extensions');
    await mkdir(extensions);
    await writeFile(join(extensions, 'handoff-fixture.ts'), `
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export default function (pi) {
  if (process.env.CODEFLARE_PI_WEB_SMOKE_FIXTURE !== '1') return;
  pi.on('session_start', async (_event, ctx) => {
    if (await ctx.ui.confirm(${JSON.stringify(confirmTitle)}, 'Continue without a model turn.')) {
      await writeFile(${JSON.stringify(confirmed)}, ctx.sessionManager.getSessionId());
    }
  });
  pi.on('input', async (event, ctx) => {
    if (event.text !== ${JSON.stringify(TURNS[1][0])}) return;
    await writeFile(${JSON.stringify(inputParked)}, ctx.sessionManager.getSessionId());
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await access(${JSON.stringify(inputRelease)});
        return { action: 'continue' };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(50);
    }
    return { action: 'handled' }; // Never start the turn on timeout.
  });
}
`);

    const request = async (path, body, signal = AbortSignal.timeout(5000)) => {
      const response = await fetch(new URL(path, origin), {
        signal, redirect: 'error',
        ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response;
    };
    const api = async (path, body, signal) => (await request(path, body, signal)).json();
    const health = () => api('/api/sessiond/health');
    const start = async () => {
      const pair = ['pi-web-sessiond.sh', 'pi-web-server.sh'].map((name) => {
        const process = launch(join(WEB_DIST, 'bin', name), [], name === 'pi-web-sessiond.sh'
          ? { cwd, env: { ...env, CODEFLARE_PI_WEB_SMOKE_FIXTURE: '1' } } : options);
        processes.push({ name, ...process });
        return process;
      });
      const ready = await waitFor('stock web/API → private sessiond socket', async () => {
        const status = await health();
        return status.ok && status.version.available && status;
      });
      assert.equal(ready.version.piVersion, piPackage.version);
      assert.equal(ready.activeSessions, 0);
      return pair;
    };

    // Only dismiss the exact shipped user-scope Workflows registration, then prove it stays gone across restart.
    const [daemon, web] = await start();
    const source = join(WEB_DIST, 'pi-packages', 'workflows');
    const packages = async () => (await api('/api/pi-packages')).packages.map(({ scope, source }) => `${scope}:${source}`).sort();
    const beforeRemoval = await packages();
    assert.ok(beforeRemoval.includes(`user:${source}`), 'stock sessiond must register the shipped Workflows package');
    assert.equal((await api('/api/pi-packages/remove', { source, scope: 'user' })).removed, true);
    await web.stop();
    await daemon.stop();
    await start();
    assert.deepEqual(await packages(), beforeRemoval.filter((entry) => entry !== `user:${source}`));
    const { plugins } = await api('/pi-web-plugins/manifest.json');
    const ids = plugins.map(({ id }) => id);
    assert.ok(ids.includes('files') && ids.includes('pi-web.terminal'), 'keep the stock Files and required Terminal plugins');
    assert.ok(!ids.includes('git') && !ids.includes('workflows'), 'stock browser manifest must not advertise Git or Workflows');

    const query = new URLSearchParams({ cwd });
    const browserApi = '/api/machines/local';
    const catalog = () => api(`${browserApi}/sessions?${query}`);
    const sessionFiles = async () => (await readdir(sessions, { recursive: true })).filter((name) => name.endsWith('.jsonl')).sort();

    // REQ-AGENT-272 AC2/AC3 prerequisite: qualify the stock API startup path for a known row, not UI rendering.
    const resumeWithConfirm = async (id) => {
      const ref = `${browserApi}/sessions/${encodeURIComponent(id)}`;
      const socket = new WebSocket(`ws://127.0.0.1:${webPort}${browserApi}/events`);
      socket.binaryType = 'arraybuffer'; // The stock WS bridge can forward JSON as binary frames.
      const decoder = new TextDecoder();
      let joined = false;
      let waiting;
      socket.addEventListener('message', ({ data }) => {
        const event = JSON.parse(typeof data === 'string' ? data : decoder.decode(data));
        if (event.type === 'machine.status') joined = true;
        if (event.type === 'status.update' && event.status.sessionId === id && event.status.pendingDialogs?.length) {
          waiting = event.status;
        }
      });
      const abort = new AbortController();
      try {
        // Wait for the daemon's join frame, not just the web/API upgrade, before opening the row.
        await waitFor('stock global WS joined private sessiond', () => joined, 5000);
        const callsBefore = modelRequests;
        let settled = false;
        const pending = api(`${ref}/transcript-snapshot?${query}&media=reference`, undefined,
          AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).finally(() => { settled = true; });
        const answer = async () => {
          await waitFor(`startup confirm for ${id}`, () => waiting || settled, 10_000);
          assert.equal(waiting?.persisted, true, 'stock global status must show the known persisted ref during startup');
          const [dialog] = waiting.pendingDialogs;
          assert.equal(waiting.pendingDialogs.length, 1);
          assert.equal(dialog.kind, 'confirm');
          assert.equal(dialog.title, confirmTitle);
          assert.equal(dialog.runScoped, false);
          // The stock daemon counts the bound runtime before its awaited
          // session_start hook completes. Confirm the exact parked dialog, not
          // readiness from a process count.
          const parkedStatus = await api(`${ref}/status?${query}`);
          assert.equal(parkedStatus.sessionId, id);
          assert.deepEqual(parkedStatus.pendingDialogs?.map(({ dialogId }) => dialogId), [dialog.dialogId]);
          assert.equal((await health()).activeSessions, 1, 'only the bound runtime may own this startup');
          assert.equal(settled, false, 'transcript snapshot must still be pending when answering');
          const { result, outcome, sessionStatus } = await api(`${ref}/dialogs/answer`, { cwd, dialogId: dialog.dialogId, value: true });
          assert.equal(result, 'closed');
          assert.equal(outcome.dialogId, dialog.dialogId);
          assert.equal(outcome.reason, 'answered');
          assert.equal(outcome.answer, true);
          assert.equal(sessionStatus.sessionId, id);
        };
        const [state] = await Promise.all([pending, answer()]);
        assert.equal(await readFile(confirmed, 'utf8'), id, 'native session_start must receive the confirmed answer');
        assert.equal(state.status.sessionId, id);
        assert.equal(state.status.persisted, true);
        assert.equal(state.status.pendingDialogs?.length ?? 0, 0);
        assert.equal((await health()).activeSessions, 1, 'the same ref must finish normal startup after answering');
        assert.equal(modelRequests, callsBefore, 'resuming a known ref must not start a model turn');
        return state;
      } finally {
        abort.abort();
        socket.close();
      }
    };

    // Pi defers the first write until a turn. Materialize only its own header at its own fresh path.
    const { SessionManager, getDefaultSessionDir } = await import(pathToFileURL(join(PI_PACKAGE_DIR, 'dist/core/session-manager.js')).href);
    const empty = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
    const emptyHeader = empty.getHeader();
    const emptyFile = empty.getSessionFile();
    assert.equal(emptyHeader.type, 'session');
    assert.equal(emptyHeader.cwd, cwd);
    assert.equal(emptyHeader.id, empty.getSessionId());
    await writeFile(emptyFile, `${JSON.stringify(emptyHeader)}\n`, { flag: 'wx', mode: 0o600 });
    const [emptyRow, ...otherRows] = await catalog();
    assert.deepEqual(otherRows, []);
    assert.ok(emptyRow, 'stock browser catalog must list the native header-only transcript before startup');
    assert.equal(emptyRow.id, emptyHeader.id);
    assert.equal(emptyRow.path, emptyFile);
    assert.equal(emptyRow.cwd, cwd);
    assert.equal(emptyRow.persisted, true);
    assert.equal(emptyRow.messageCount, 0);

    const project = await api('/api/projects', { path: cwd });
    const { workspaces } = await api(`/api/projects/${encodeURIComponent(project.id)}/workspaces`);
    const workspace = workspaces.find(({ path, isMain }) => path === cwd && isMain);
    assert.ok(workspace, 'stock browser workspace catalog must resolve the canonical cwd');
    const page = `/?${new URLSearchParams({ project: project.id, workspace: workspace.id, session: emptyRow.id, view: 'chat' })}`;
    const html = await (await request(page)).text();
    const asset = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\.\/assets\/[^" ]+)"/u)?.[1];
    assert.ok(asset, 'stock Chat entry must identify a relative browser bundle');
    const js = await request(asset);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    await js.body.cancel();

    const emptyState = await resumeWithConfirm(emptyRow.id);
    assert.deepEqual(emptyState.page.messages, []);
    assert.equal(emptyState.partial, null);
    assert.deepEqual(await api(`${browserApi}/sessions/${encodeURIComponent(emptyRow.id)}/stop`, { cwd }), { stopped: true });
    assert.equal((await health()).activeSessions, 0);
    // Pi can append model/thinking metadata during startup, but not a conversation turn.
    const [resumedHeader, ...emptyEntries] = parseTranscript(await readFile(emptyFile, 'utf8'));
    assert.deepEqual(resumedHeader, JSON.parse(JSON.stringify(emptyHeader)));
    assert.ok(emptyEntries.every(({ type }) => type !== 'message'), 'the empty resume must not write messages');
    const emptyRelative = relative(sessions, emptyFile);
    assert.deepEqual(await sessionFiles(), [emptyRelative], 'the empty resume must not create a replacement transcript');
    console.log(JSON.stringify({ result: 'PI_WEB_STARTUP_CONFIRM_OK', ref: 'header-only' }));

    // REQ-AGENT-272 AC2: native CLI creates the populated transcript and exits before the browser API opens it.
    const print = run(PI, ['--print', TURNS[0][0]], { ...options, timeout: 15_000, killSignal: 'SIGKILL' });
    print.child.stdin.end(); // Pi reads non-TTY stdin to EOF before executing --print.
    await print;
    const files = await sessionFiles();
    assert.equal(files.length, 2, 'native Pi must create exactly one additional transcript');
    assert.ok(files.includes(emptyRelative), 'native Pi must leave the empty transcript in place');
    const file = join(sessions, files.find((name) => name !== emptyRelative));
    const before = await readFile(file, 'utf8');
    const [header, ...oldEntries] = parseTranscript(before);
    assert.equal(header.type, 'session');
    assert.equal(header.cwd, cwd);
    assert.ok(header.id, 'the native file must have a session identity');
    assert.notEqual(header.id, emptyRow.id);
    assert.deepEqual(visible(durableChat(oldEntries).map(({ message }) => message)), expected(TURNS.slice(0, 1)));
    const row = (await catalog()).find(({ id }) => id === header.id);
    assert.equal(row?.path, file, 'stock browser catalog must list the populated native transcript');
    assert.equal(row.cwd, cwd);
    assert.equal(row.persisted, true);

    const ref = `/api/sessions/${encodeURIComponent(header.id)}`;
    const snapshot = () => api(`${ref}/transcript-snapshot?${query}`);
    const checkSnapshot = (state, entries, turns) => {
      assert.equal(state.status.sessionId, header.id);
      assert.equal(state.status.persisted, true);
      assert.equal(state.partial, null);
      assert.deepEqual(visible(state.page.messages), expected(turns));
      assert.deepEqual(chatMessages(state.page.messages).map(({ entryId }) => entryId), durableChat(entries).map(({ id }) => id));
    };
    checkSnapshot(await resumeWithConfirm(row.id), oldEntries, TURNS.slice(0, 1));
    console.log(JSON.stringify({ result: 'PI_WEB_STARTUP_CONFIRM_OK', ref: 'persisted' }));
    assert.ok(!(await api(`${ref}/commands?${query}`)).some(({ name }) => name === 'worktree'), 'no /worktree in Chat');

    // REQ-AGENT-272 AC3 prerequisite: accepted work can be busy before streaming starts.
    const preview = () => api('/api/sessions/cleanup/preview', { archiveIdleDays: 0, projectCwds: [cwd] });
    const callsBefore = modelRequests;
    assert.equal((await api(`${ref}/prompt`, { cwd, text: TURNS[1][0] })).accepted, true);
    await waitFor('native input hook parked before agent_start', async () => (await readFile(inputParked, 'utf8')) === header.id, 5000);
    const parkedStatus = await api(`${ref}/status?${query}`);
    assert.equal(parkedStatus.sessionId, header.id);
    assert.ok(looksIdle(parkedStatus), 'ordinary status must appear idle while the input hook is parked');
    const parkedPreview = await preview();
    assert.ok(parkedPreview.skippedBusySessionIds?.includes(header.id),
      'read-only cleanup preview must classify the exact parked session as busy');
    assert.equal(modelRequests, callsBefore, 'the held input must not reach the model before external release');
    await writeFile(inputRelease, '', { flag: 'wx' });

    const settled = await waitFor('stock browser turn persisted and qualified idle', async () => {
      const state = await snapshot();
      if (!looksIdle(state.status) || chatMessages(state.page.messages).length !== 4) return;
      const ready = await preview();
      assert.ok(!ready.skippedBusySessionIds?.includes(header.id), 'the released turn must no longer be busy');
      assert.equal(ready.totals.archiveCount, parkedPreview.totals.archiveCount + 1,
        'the same preview must now count the formerly held session as eligible');
      return state;
    });
    assert.deepEqual(await api(`${ref}/stop`, { cwd }), { stopped: true });
    assert.equal((await health()).activeSessions, 0, 'stock stop must release the writer before native reopen');
    // No snapshot, commands or other implicit open after stock stop.
    const after = await readFile(file, 'utf8');
    assert.ok(after.startsWith(before), 'Chat must append to the exact native file, without rewriting its history');
    const [, ...entries] = parseTranscript(after);
    checkSnapshot(settled, entries, TURNS);
    const native = await reopenNative(file, options);
    assert.equal(native.get_state.sessionId, header.id);
    assert.equal(native.get_state.sessionFile, file);
    assert.deepEqual(visible(native.get_messages.messages), expected(TURNS));
    assert.deepEqual(native.get_entries.entries, entries);
    assert.equal(native.get_entries.leafId, entries.at(-1).id);
    assert.deepEqual(await sessionFiles(), files, 'handoff must not create a replacement transcript');
    assert.equal(await readFile(file, 'utf8'), after, 'native reopen must not modify the transcript');
    console.log(JSON.stringify({ result: 'PI_WEB_HANDOFF_SMOKE_OK', piWebVersion: installed.version }));

    if (process.env.CODEFLARE_PI_WEB_SMOKE_BROWSER_REFRESH === '1') {
      // Separate from the API startup control: Chrome itself reopens the stopped, known fixture row.
      await rm(confirmed);
      const emptyRef = `${browserApi}/sessions/${encodeURIComponent(emptyRow.id)}`;
      const callsBeforeRefresh = modelRequests;
      const evidence = await probeStartupRefresh({
        url: new URL(page, origin), options, ref: emptyRef, cwd, id: emptyRow.id, title: confirmTitle, confirmed,
        status: () => api(`${emptyRef}/status?${query}`),
        answer: (dialogId) => api(`${emptyRef}/dialogs/answer`, { cwd, dialogId, value: true }),
      });
      assert.deepEqual(await api(`${emptyRef}/stop`, { cwd }), { stopped: true });
      assert.equal((await health()).activeSessions, 0);
      assert.equal(modelRequests, callsBeforeRefresh, 'refreshing the fixture must not start a model turn');
      assert.deepEqual(await sessionFiles(), files, 'refreshing the fixture must not create another transcript');
      console.log(JSON.stringify({ result: 'PI_WEB_STARTUP_REFRESH_DIAGNOSTIC', piWebVersion: installed.version, ...evidence }));
    }
  } catch (error) {
    for (const process of processes) console.error(`${process.name}: ${process.log()}`);
    throw error;
  } finally {
    for (const process of processes.reverse()) await process.stop();
    await close(modelServer);
    await rm(home, { recursive: true, force: true });
  }
}

await main();
