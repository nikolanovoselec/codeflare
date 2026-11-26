// CI only: use the locked stock services and managed CLI in the isolated Node image.
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createActivityTracker } from '../../host/dist/activity-tracker.js';
import { createPiWebProxy } from '../../host/dist/pi-web-proxy.js';
import { createPiWebRuntime } from '../../host/dist/pi-web-runtime.js';
import { PI_WEB_PORT } from '../../host/dist/pi-web-services.js';

const [, , mode, ...extraArgs] = process.argv;
assert.ok(extraArgs.length === 0 && (mode === undefined || mode === 'handoff' || mode === 'handoff-retry'),
  'Usage: node smoke-pi-web-host-handoff.mjs [handoff|handoff-retry]');
const retryOnly = mode === 'handoff-retry';

const WebSocket = createRequire(new URL('../../host/dist/pi-web-proxy.js', import.meta.url))('ws');
const stock = `http://127.0.0.1:${PI_WEB_PORT}`;
const nativeFetch = globalThis.fetch;
const nativeHttpRequest = http.request;
const generation = 7;
const sessionId = 'handoffsmoke';
const prefix = `/api/pi-web/${sessionId}`;
const appPrefix = `${prefix}/g/${generation}`;
const provider = 'handoff-fixture';
const model = 'handoff-text';
const seed = 'Keep this exact saved question.';
const reply = 'Keep this exact saved reply.';
const held = 'Do not wait for a normal reply to this input.';
const nativePrompt = 'Park this Terminal turn until it is interrupted.';
const handled = 'Hold and consume this native input.';
const text = (content) => typeof content === 'string' ? content : content?.map(({ text }) => text).join('');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const identity = ({ id, cwd, path }) => ({ id, cwd, path });
const messages = (transcript) => transcript.trimEnd().split('\n').map(line => JSON.parse(line))
  .filter(({ type }) => type === 'message').map(({ message }) => message);

async function until(label, probe, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function request(origin, path, expected = 200, body, headers = {}, timeoutMs = 8000) {
  const response = await nativeFetch(origin + path, {
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { ...headers,
      ...(body !== undefined && { 'Content-Type': 'application/json', Origin: origin }) },
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
  });
  const result = await response.text();
  assert.equal(response.status, expected, `${path}: ${result.slice(0, 400)}`);
  return JSON.parse(result);
}

async function reopenTerminal(cwd, owner, released, readSwitch, exercise) {
  // Consume the exact issued ticket in a real PTY, without depending on the
  // full Classic launcher or Herdr pane setup in this minimal image.
  assert.ok(existsSync('/usr/bin/script'), 'isolated image must provide the script PTY driver');
  const terminalPath = join(process.env.CODEFLARE_RUNTIME_ROOT, 'pi-web/terminal.json');
  const cli = spawn('/usr/bin/script', ['-q', '-e', '-c',
    'export CODEFLARE_PI_TERMINAL_PID=$$; exec node --import /opt/codeflare/pi-web/native-preflight.mjs /usr/local/bin/pi --extension /opt/codeflare/pi-web/handoff-extension.ts --session "$CODEFLARE_PI_TERMINAL_SESSION_PATH"',
    '/dev/null'], { cwd, env: { ...process.env, TERM: 'xterm-256color', SHELL: '/bin/sh',
    CODEFLARE_PI_TERMINAL_TICKET: owner.terminalTicket, CODEFLARE_PI_TERMINAL_SESSION_PATH: owner.binding.path,
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(cli, 'close');
  void done.catch(() => {});
  let output = '';
  for (const stream of [cli.stdout, cli.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16_384); });
  cli.stdin.on('error', () => {}); // An early CLI exit is reported with its TTY output.
  try {
    await until('native TUI opens the exact saved branch', async () => {
      if (cli.exitCode !== null) throw new Error('native Pi exited before opening');
      return (await readSwitch()).phase === 'complete' && output.includes(reply);
    });
    const terminal = json(terminalPath);
    assert.deepEqual(identity(terminal), owner.binding);
    assert.equal(terminal.ticket, owner.terminalTicket);
    assert.equal(terminal.leaf, released.leaf);
    const result = await exercise(cli.stdin, terminal);
    assert.deepEqual(await Promise.race([done, delay(5000, undefined, { ref: false })]), [0, null], 'native TUI must quit normally');
    return result;
  } catch (error) {
    cli.kill(); // Failure cleanup only; the successful switch must quit Pi itself.
    throw new Error(`Native Terminal handoff failed: ${output.slice(-4000)}`, { cause: error });
  } finally { cli.stdin.end(); }
}

async function qualify(ambiguous) {
  const exerciseStartupWaits = !ambiguous && !retryOnly;
  const home = mkdtempSync('/tmp/pi-web-host-handoff-');
  const cwd = join(home, 'workspace');
  const agentDir = join(home, '.pi/agent');
  const runtimeRoot = join(home, 'run');
  const runtimeDir = join(runtimeRoot, 'pi-web');
  const extensions = join(agentDir, 'extensions');
  const parked = join(home, 'parked');
  const resume = join(home, 'resume');
  const nativeParked = join(home, 'native-parked');
  const nativeResume = join(home, 'native-resume');
  const startupQuestionSeen = join(home, 'startup-question');
  const startupAnswer = join(home, 'startup-answer');
  const startupQuestion = 'Continue the original startup?';
  const owner = () => json(join(runtimeDir, 'owner.json'));
  const chat = () => json(join(runtimeDir, 'chat.json'));
  const terminal = () => json(join(runtimeDir, 'terminal.json'));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, CODEFLARE_RUNTIME_ROOT: runtimeRoot,
    CODEFLARE_PI_GENERATION: String(generation), CODEFLARE_PI_SURFACE: 'chat', SESSION_ID: sessionId });

  const calls = [];
  let nativeStream;
  const modelServer = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const prompt = text(input.messages.findLast(({ role }) => role === 'user')?.content);
      calls.push(prompt);
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(input.model, model);
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'handoff-completion',
        object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (prompt === seed) res.end(chunk({ role: 'assistant', content: reply }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      else if (prompt === held) res.write(chunk({ role: 'assistant' }, null)); // Only native Abort can end this turn.
      else if (prompt === nativePrompt) {
        nativeStream = 'parked';
        res.once('close', () => { nativeStream = 'closed'; });
        res.write(chunk({ role: 'assistant' }, null));
      } else res.destroy();
    } catch { res.destroy(); }
  });
  let profileRestored = false;
  const runtime = createPiWebRuntime({ sessionId, generation, initialSurface: 'chat', terminalMode: 'classic',
    cwd, home, runtimeDir, profileRestored: () => profileRestored, cloneRestored: () => false });
  const activity = createActivityTracker();
  const lastInput = () => activity.getActivityInfo(null).lastInputAt;
  const proxy = createPiWebProxy({ sessionId, runtime, recordInput: activity.recordInput });
  let refuseFirstFrame = exerciseStartupWaits;
  const server = createServer((req, res) => {
    if (refuseFirstFrame && req.method === 'GET' && req.url?.startsWith(`${appPrefix}/?`)) {
      refuseFirstFrame = false;
      res.writeHead(503).end();
      return;
    }
    void proxy.handle(req, res);
  });
  let refuseSessionEvents = false;
  server.on('upgrade', (req, socket, head) => {
    if (refuseSessionEvents && req.url?.startsWith(`${appPrefix}/api/machines/local/sessions/`)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    proxy.upgrade(req, socket, head);
  });
  let startupEvents;
  const occupiedGateway = createServer((_req, res) => res.writeHead(503).end());
  const startupLogs = [];
  const info = console.info;
  let packageListHoldMs;
  console.info = (...args) => { startupLogs.push(args.join(' ')); info(...args); };
  globalThis.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (String(input) === `${stock}/api/pi-packages` && response.ok && packageListHoldMs === undefined) {
      const holdStartedAt = performance.now();
      await delay(300);
      packageListHoldMs = performance.now() - holdStartedAt;
    }
    return response;
  };
  const nativeSpawn = childProcess.spawn;
  function restoreSpawn() {
    if (!ambiguous) return;
    childProcess.spawn = nativeSpawn;
    syncBuiltinESMExports();
  }
  try {
    if (ambiguous) {
      // Keep the real listener and private HTTP path; discard only gateway stdout.
      childProcess.spawn = (command, args, options) => nativeSpawn(command, args,
        command.endsWith('/@jmfederico/pi-web/dist/bin/pi-web-server.sh') && Array.isArray(options?.stdio)
          ? { ...options, stdio: [options.stdio[0], 'ignore', options.stdio[2]] } : options);
      syncBuiltinESMExports();
    }
    mkdirSync(cwd);
    mkdirSync(extensions, { recursive: true });
    const modelOrigin = await listen(modelServer);
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model }));
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: {
      api: 'openai-completions', baseUrl: `${modelOrigin}/v1`, apiKey: 'local-fixture-not-a-secret', models: [{ id: model }],
    } } }));
    // Only public Pi hooks are added; the image-owned handoff extension
    // still registers and writes all native ownership evidence itself.
    const commandReceipt = join(home, 'slash-command-receipt');
    writeFileSync(join(extensions, 'held-input.ts'), `
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
export default function (pi) {
  pi.registerCommand('codeflare-fixture', {
    description: 'Record a harmless fixture argument',
    handler: async (args, ctx) => {
      const receipt = ${JSON.stringify(commandReceipt)};
      writeFileSync(receipt + '.tmp', JSON.stringify({ args, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }));
      renameSync(receipt + '.tmp', receipt);
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (${!exerciseStartupWaits} || ctx.mode !== 'rpc' || existsSync(${JSON.stringify(startupQuestionSeen)})) return;
    writeFileSync(${JSON.stringify(startupQuestionSeen)}, 'waiting');
    const answer = await ctx.ui.confirm(${JSON.stringify(startupQuestion)}, 'Packaged startup fixture');
    writeFileSync(${JSON.stringify(startupAnswer)}, answer ? 'yes' : 'no');
  });
  pi.on('input', async (event, ctx) => {
    if (ctx.mode === 'tui' && event.text === ${JSON.stringify(handled)}) {
      writeFileSync(${JSON.stringify(nativeParked)}, 'held');
      while (!existsSync(${JSON.stringify(nativeResume)})) await delay(25);
      return { action: 'handled' };
    }
    if (ctx.mode !== 'rpc' || event.text !== ${JSON.stringify(held)}) return;
    writeFileSync(${JSON.stringify(parked)}, ctx.sessionManager.getSessionId());
    while (!existsSync(${JSON.stringify(resume)})) await delay(25);
    return { action: '${ambiguous ? 'handled' : 'continue'}' };
  });
}
`);
    const origin = await listen(server);
    const api = (path, expected, body, timeoutMs) => request(origin, (path.startsWith('/_') ? prefix : appPrefix) + path, expected, body, {
      'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'http', 'x-codeflare-pi-generation': String(generation),
    }, timeoutMs);
    const boot = runtime.initialize();
    void boot.catch(() => {});
    const readSwitch = () => api(`/_switch?generation=${generation}`);
    assert.equal((await readSwitch()).chatUrl, undefined, 'do not expose Chat before profile restore');
    assert.equal(runtime.binding, undefined, 'do not bind a transcript before profile restore');
    const preRestoreHealth = await nativeFetch(`${stock}/api/sessiond/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    assert.ok(!preRestoreHealth?.ok, 'stock services must not become ready before profile restore');
    await preRestoreHealth?.body?.cancel();
    const readProfile = () => ({
      settings: readFileSync(join(agentDir, 'settings.json'), 'utf8'),
      models: readFileSync(join(agentDir, 'models.json'), 'utf8'),
      extensions: readdirSync(extensions).sort(),
      fixtureExtension: readFileSync(join(extensions, 'held-input.ts'), 'utf8'),
    });
    const restoredProfile = ambiguous ? readProfile() : undefined;
    if (ambiguous) {
      occupiedGateway.listen(PI_WEB_PORT, '127.0.0.1');
      await once(occupiedGateway, 'listening');
    }
    const restoreTime = performance.now();
    let failedBinding;
    async function verifyOccupiedGatewayPreservesProfile() {
      const failed = await until('failed initial service boot', async () => {
        const state = await readSwitch();
        return state.phase === 'failed' ? state : undefined;
      }, 35_000);
      assert.ok(failed.requestId, 'failed startup must have a retryable handoff identity');
      assert.equal(existsSync(join(runtimeDir, 'defaults.json')), false,
        'a known gateway port conflict must fail before preparing the stock services');
      assert.deepEqual(readProfile(), restoredProfile, 'an occupied gateway must not change restored Pi settings, models or extensions');
      return failed.requestId;
    }
    if (ambiguous) {
      const warnings = [];
      const warn = console.warn;
      let requestId;
      console.warn = (...args) => warnings.push(args.join(' '));
      try {
        profileRestored = true;
        requestId = await verifyOccupiedGatewayPreservesProfile();
      } finally {
        console.warn = warn;
      }
      const prefix = '[pi-web] service boot failed ';
      const records = warnings.filter(line => line.startsWith(prefix));
      assert.equal(records.length, 1);
      const { elapsedMs, ...record } = JSON.parse(records[0].slice(prefix.length));
      assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
      assert.deepEqual(record, { operation: 'port-probe', errno: 'EADDRINUSE' });
      failedBinding = identity(runtime.binding);
      await close(occupiedGateway);
      await api('/_switch', 202, { generation, requestId, target: 'chat' });
    } else {
      profileRestored = true;
    }
    let beforeUrl = restoreTime;
    const chatUrl = await until('Chat deep link', async () => {
      const requestedAt = performance.now();
      const state = await readSwitch();
      if (!state.chatUrl) beforeUrl = requestedAt;
      if (state.phase === 'failed' || state.phase === 'uncertain') {
        await boot;
        throw new Error(`Chat failed to publish its deep link (${state.phase})`);
      }
      return state.chatUrl;
    }, 35_000);
    const afterUrl = performance.now();
    const { id, path } = runtime.binding;
    assert.equal((await request(stock, '/api/sessiond/health')).activeSessions, 0, 'service preparation must not acquire a writer');
    if (failedBinding) assert.deepEqual(identity(runtime.binding), failedBinding, 'retry preserves the original transcript');
    else console.log(`Chat-first profile release to deep link: ${Math.round(performance.now() - restoreTime)} ms`);
    const deepLink = new URL(chatUrl, origin);
    assert.equal(deepLink.pathname, `${appPrefix}/`);
    const params = deepLink.searchParams;
    assert.equal(params.get('session'), id);
    const browserHeaders = {
      'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'http', 'x-codeflare-pi-generation': String(generation),
    };
    if (exerciseStartupWaits) {
      // The dashboard can remain on Ready beyond the writer-confirmation budget.
      await delay(26_000);
      const firstFrame = await nativeFetch(deepLink, { headers: browserHeaders });
      assert.equal(firstFrame.status, 503, 'first navigation fails before reaching the Host proxy');
      await firstFrame.arrayBuffer();
      const stillWaiting = await readSwitch();
      assert.equal(stillWaiting.chatUrl, chatUrl, 'reload can use the same deep link');
      assert.equal((await request(stock, '/api/sessiond/health')).activeSessions, 0);
    }
    const beforeAdmission = performance.now();
    const app = await nativeFetch(deepLink, { headers: browserHeaders });
    const afterAdmission = performance.now();
    assert.equal(app.status, 200);
    const entry = (await app.text()).match(/<script[^>]+src="(\.\/assets\/[^"]+\.js)"/);
    assert.ok(entry, 'stock HTML must retain its relative client entry');
    const asset = await nativeFetch(new URL(entry[1], deepLink), { headers: browserHeaders });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('Content-Type') ?? '', /javascript/);
    await asset.arrayBuffer();
    const manifest = await api('/pi-web-plugins/manifest.json');
    const chromePlugin = manifest.plugins.find(({ id }) => id === 'codeflare-chrome');
    assert.ok(chromePlugin, 'scoped Chat exposes the presentation plugin');
    const pluginUrl = new URL(`${appPrefix}${chromePlugin.module}`, origin);
    const pluginModule = await nativeFetch(pluginUrl, { headers: browserHeaders });
    assert.equal(pluginModule.status, 200);
    await pluginModule.arrayBuffer();
    const footerSheet = await nativeFetch(new URL('./footer.css', pluginUrl), { headers: browserHeaders });
    assert.equal(footerSheet.status, 200, 'module-relative stylesheet is served through the generation scope');
    assert.match(footerSheet.headers.get('Content-Type') ?? '', /text\/css/);
    await footerSheet.arrayBuffer();
    const catalog = `/api/plugin-catalog/projects/${encodeURIComponent(params.get('project'))}/workspaces/${encodeURIComponent(params.get('workspace'))}/sessions/${encodeURIComponent(id)}`;
    const ref = `/api/sessions/${encodeURIComponent(id)}`;
    const query = new URLSearchParams({ cwd });
    const snapshot = (timeoutMs) => api(`${ref}/transcript-snapshot?${query}`, 200, undefined, timeoutMs);
    const health = () => request(stock, '/api/sessiond/health');
    const writer = async () => {
      const row = await request(stock, catalog);
      assert.deepEqual({ id: row.id, cwd: row.cwd, archived: row.archived }, { id, cwd, archived: false });
      return row.runtime;
    };
    // The pinned naming namespace has no disable flag. Dismiss only its bundled
    // package from the disposable profile before the first writer can load it.
    const naming = '/opt/codeflare/pi-web/node_modules/@jmfederico/pi-web/dist/pi-packages/session-naming';
    assert.equal((await request(stock, '/api/pi-packages/remove', 200, { scope: 'user', source: naming })).removed, true);
    const connectEvents = () => {
      const eventsUrl = new URL(`${appPrefix}/api/machines/local/sessions/${encodeURIComponent(id)}/events?${query}`, origin);
      eventsUrl.protocol = 'ws:';
      return new WebSocket(eventsUrl, { headers: browserHeaders, handshakeTimeout: 5000 });
    };
    const startupDialogIds = new Set();
    if (exerciseStartupWaits) {
      startupEvents = connectEvents();
      startupEvents.on('message', data => {
        const event = JSON.parse(data.toString());
        if (event.type === 'dialog.opened' && event.dialog.title === startupQuestion) {
          startupDialogIds.add(event.dialog.dialogId);
        }
      });
      await once(startupEvents, 'open', { signal: AbortSignal.timeout(5000) });
    }
    const firstSnapshot = snapshot(60_000);
    void firstSnapshot.catch(() => {});
    let beforeWriter;
    if (exerciseStartupWaits) {
      await until('original Pi startup question entered', () => existsSync(startupQuestionSeen));
      const question = await until('stock startup status exposes the original question', async () => {
        const status = await api(`${ref}/status?${query}`);
        assert.equal(status.sessionId, id);
        return status.pendingDialogs?.find(dialog => dialog.title === startupQuestion);
      });
      await until('scoped Chat stream delivers the original startup question', () => startupDialogIds.has(question.dialogId));
      const waiting = await until('Host exposes the native startup question to the browser', async () => {
        const state = await readSwitch();
        return state.startupQuestion === true && state;
      });
      assert.equal(waiting.phase, 'opening', 'a live startup question is not composer readiness');
      // Exceed the ordinary attachment deadline. A human answer is not a stalled launch.
      await delay(26_000);
      const stillWaiting = await readSwitch();
      assert.equal(stillWaiting.phase, 'opening');
      assert.equal(stillWaiting.requestId, waiting.requestId);
      assert.equal(stillWaiting.chatUrl, chatUrl);
      assert.equal(runtime.ready, false);
      await api(`${ref}/prompt`, 409, { cwd, text: 'Do not admit new work during the startup question.' });
      assert.deepEqual(calls, [], 'waiting for a startup answer must not admit a turn');
      assert.equal(owner().terminalTicket, undefined, 'settling a startup question cannot grant a Terminal writer');
      beforeWriter = performance.now();
      const closed = await api(`${ref}/dialogs/answer`, 200, { cwd, dialogId: question.dialogId, value: true });
      assert.equal(closed.result, 'closed');
      await until('original Pi extension receives the answer', () => existsSync(startupAnswer));
      assert.equal(readFileSync(startupAnswer, 'utf8'), 'yes');
      startupEvents.close();
    }
    assert.equal((await firstSnapshot).status.sessionId, id);
    await until('image-managed Chat writer ready', () => runtime.ready);
    const afterWriter = performance.now();
    await boot;
    restoreSpawn();
    console.info = info;
    globalThis.fetch = nativeFetch;
    const timings = (name, fields, missingField) => {
      const prefix = `[pi-web] ${name} `;
      const rows = startupLogs.filter(line => line.startsWith(prefix));
      assert.equal(rows.length >= 1, true, `record ${name}`);
      const record = JSON.parse(rows.at(-1).slice(prefix.length));
      assert.deepEqual(Object.keys(record).sort(), [...fields].sort(), 'timing record contains only bounded milestones');
      for (const key of fields) {
        if (key === missingField) assert.equal(record[key], null, 'discarding the gateway marker must not block startup');
        else assert.ok(Number.isSafeInteger(record[key]) && record[key] >= 0, key);
      }
      return record;
    };
    function verifyStockListenTimings() {
      const services = timings('service boot timing', ['launchMs', 'gatewayListenMs', 'sessiondListenMs', 'healthyMs', 'listedMs', 'readyMs'],
        ambiguous ? 'gatewayListenMs' : undefined);
      assert.ok(services.launchMs <= services.healthyMs && services.healthyMs <= services.listedMs && services.listedMs <= services.readyMs);
      if (!ambiguous) assert.ok(services.gatewayListenMs > 0 && services.gatewayListenMs <= services.readyMs, 'observe the stock gateway listen marker');
      assert.ok(services.sessiondListenMs > 0 && services.sessiondListenMs <= services.readyMs, 'observe the stock daemon listen marker');
      assert.ok(packageListHoldMs > 0, 'hold the stock package-list response during service boot');
      assert.ok(services.listedMs - services.healthyMs >= Math.floor(packageListHoldMs),
        'the package-list milestone, not pair health, must include the controlled response wait');
    }
    verifyStockListenTimings();
    const chatTiming = timings('Chat open timing', ['serviceWaitMs', 'projectWorkspaceMs', 'frameAdmissionMs', 'writerReceiptMs']);
    if (exerciseStartupWaits) {
      const within = (elapsedMs, lower, upper, phase) => {
        assert.ok(elapsedMs >= Math.floor(lower) && elapsedMs <= Math.ceil(upper),
          `${phase}: ${elapsedMs}ms outside observed interval [${lower}, ${upper}]ms`);
      };
      within(chatTiming.frameAdmissionMs, beforeAdmission - afterUrl, afterAdmission - beforeUrl, 'URL to admission');
      within(chatTiming.writerReceiptMs, beforeWriter - afterAdmission, afterWriter - beforeAdmission, 'admission to writer confirmation');
    }
    assert.notEqual((await readSwitch()).startupQuestion, true);
    const source = chat();
    assert.deepEqual(identity(source), { id, cwd, path });
    assert.equal(owner().terminalTicket, undefined, 'Chat-first startup must not grant a native Terminal ticket');

    let busyChecks = 0;
    let stop;
    let nativePid, processAtChatOpen;
    const aborts = [];
    // Observe the real private control HTTP calls used by the coordinator.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (nativePid && processAtChatOpen === undefined && url.origin === stock && url.pathname === '/api/projects') {
        // Sample before the Host's first target-open request, not after the deep link appears.
        try { processAtChatOpen = readFileSync(`/proc/${nativePid}/stat`, 'utf8'); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; processAtChatOpen = ''; }
      }
      const closing = url.origin === stock && url.pathname === `${ref}/stop`;
      if (closing) stop = { beforeStop: owner() };
      const response = await nativeFetch(input, init);
      if (url.origin !== stock || !response.ok) return response;
      if (url.pathname === `${ref}/abort`) aborts.push({ ...await response.clone().json(), body: JSON.parse(init.body),
        parked: !existsSync(resume) });
      if (url.pathname === catalog && (await response.clone().json()).runtime === 'busy') busyChecks++;
      if (closing) stop.stopped = (await response.clone().json()).stopped;
      return response;
    };
    {
      // Decorate a real response at the local transport boundary, as the
      // fixture must not change the pinned stock artifact or its policies.
      http.request = (options, receive) => {
        if (options.hostname === '127.0.0.1' && options.port === PI_WEB_PORT && options.path === '/api/projects') {
          return nativeHttpRequest(options, response => {
            response.headers['content-security-policy'] = ["default-src 'none'", 'sandbox'];
            response.headers['x-frame-options'] = ['SAMEORIGIN', 'DENY'];
            receive(response);
          });
        }
        if (!ambiguous || options.path !== `${ref}/prompt` || options.method !== 'POST') {
          return nativeHttpRequest(options, receive);
        }
        // Lose only the browser proxy's prompt acknowledgment, after the genuine stock call accepts it.
        const upstream = nativeHttpRequest(options, response => {
          void (async () => {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            assert.equal(response.statusCode, 200);
            assert.equal(JSON.parse(Buffer.concat(chunks)).accepted, true);
            receive(Object.assign(Readable.from(['{']), { statusCode: response.statusCode, headers: response.headers }));
          })().catch(error => upstream.destroy(error));
        });
        return upstream;
      };
    }
    const preview = await nativeFetch(`${origin}${appPrefix}/api/projects`, { headers: browserHeaders });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.headers.get('Content-Security-Policy')?.split(',').map(policy => policy.trim()),
      ["default-src 'none'", 'sandbox']);
    assert.equal(preview.headers.get('X-Frame-Options'), 'DENY');
    await preview.arrayBuffer();
    const prompt = (message, status = 200) => api(`${ref}/prompt`, status, { cwd, text: message });
    const attachment = bytes => ({ kind: 'file', mimeType: 'application/octet-stream', name: 'fixture.bin', data: bytes.toString('base64') });
    const uploadFolder = 'attachment-smoke';
    const upload = (status, attachments, overrides = {}, route = ref) => api(`${route}/attachments`, status,
      { cwd, folder: uploadFolder, attachments, ...overrides });
    const command = (status, text, bodyCwd = cwd, route = ref) =>
      api(`${route}/commands/run`, status, { cwd: bodyCwd, text });
    if (!ambiguous && !retryOnly) {
      const beforeCommand = lastInput();
      await until('clock advances past prior input', () => Date.now() > (beforeCommand ?? 0));
      await command(409, '/codeflare-fixture wrong-session', cwd, `${ref}-wrong`);
      await command(400, '/codeflare-fixture wrong-workspace', `${cwd}/other`);
      await command(409, ' /clone ');
      await command(409, '/fork');
      assert.equal((await command(200, '/codeflare-unknown-fixture-command')).type, 'unsupported');
      assert.equal(lastInput(), beforeCommand, 'rejected and unsupported commands are not user input');
      assert.equal(existsSync(commandReceipt), false);
      assert.equal((await command(200, '/codeflare-fixture hello there')).type, 'done');
      assert.ok((lastInput() ?? 0) > (beforeCommand ?? 0), 'accepted command advances the idle input clock');
      await until('Pi extension processes scoped slash command', () => existsSync(commandReceipt));
      assert.deepEqual(JSON.parse(readFileSync(commandReceipt, 'utf8')), { args: 'hello there', id, cwd });
      const first = Buffer.alloc(6_000_000, 0x31);
      const second = Buffer.alloc(4_000_000, 0x32);
      const batch = [attachment(first), attachment(second)];
      const oversized = [...batch, attachment(Buffer.from('!'))];
      await upload(413, oversized);
      await upload(400, Array.from({ length: 17 }, () => attachment(Buffer.from('small'))));
      // Stay below the decoded limit but exceed the bounded JSON envelope.
      await upload(413, [attachment(Buffer.from('small'))], { folder: 'a'.repeat(14 * 1024 * 1024) });
      await upload(400, [batch[0], { ...batch[1], data: '!' }]);
      await upload(400, [batch[0]], { cwd: dirname(cwd) });
      await upload(409, [batch[0]], {}, '/api/sessions/another-conversation');
      assert.equal(existsSync(join(cwd, uploadFolder)), false, 'rejected batches do not write even the first file');
      const { attachments } = await upload(200, batch);
      assert.deepEqual(attachments.map(({ size }) => size), [first.length, second.length]);
      for (const [index, { path: file }] of attachments.entries()) {
        assert.equal(dirname(file), uploadFolder);
        assert.deepEqual(readFileSync(join(cwd, file)), [first, second][index]);
      }
      // The existing non-upload reader can close the socket on overflow.
      const hugePrompt = await nativeFetch(`${origin}${appPrefix}${ref}/prompt`, {
        method: 'POST', headers: { ...browserHeaders, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, text: 'x'.repeat(1024 * 1024) }), signal: AbortSignal.timeout(8000),
      }).catch(error => {
        if (error.cause?.code !== 'UND_ERR_SOCKET' && error.cause?.code !== 'ECONNRESET') throw error;
        return undefined;
      });
      if (hugePrompt) {
        assert.equal(hugePrompt.status, 503);
        await hugePrompt.arrayBuffer();
      }
    }
    if (!ambiguous) {
      assert.equal((await prompt(seed)).accepted, true);
      await until('normal saved Chat reply', async () => await writer() === 'idle' &&
        text(messages(readFileSync(path, 'utf8')).at(-1)?.content) === reply);
      assert.deepEqual(calls, [seed]);
    }
    const saved = readFileSync(path, 'utf8');
    const requestId = randomUUID();
    assert.equal((await prompt(held, ambiguous ? 503 : 200)).accepted, ambiguous ? undefined : true);
    await until('accepted native input hook is parked', () => existsSync(parked));
    assert.equal(readFileSync(parked, 'utf8'), id);
    const status = await api(`${ref}/status?${query}`);
    assert.equal(status.sessionId, id);
    assert.equal(status.persisted, true);
    assert.deepEqual([status.isStreaming, status.isCompacting, status.isBashRunning, status.pendingMessageCount,
      status.pendingDialogs?.length ?? 0], [false, false, false, 0, 0], 'ordinary status looks idle during a real input hook');
    assert.equal(await writer(), 'busy');

    if (ambiguous) {
      writeFileSync(resume, '');
      await until('stock writer really returns to idle', async () => await writer() === 'idle');
    }
    // REQ-AGENT-272 AC2/AC3/AC6: only the real switch may stop and transfer the writer.
    await api('/_switch', 202, { generation, requestId, target: 'terminal' });
    if (ambiguous) {
      await until('ambiguous dispatch refuses transfer', async () => (await readSwitch()).phase === 'failed');
      assert.equal((await readSwitch()).surface, 'chat');
      assert.equal(await writer(), 'idle');
      assert.equal((await health()).activeSessions, 1);
      assert.equal(owner().terminalTicket, undefined);
      assert.equal(stop, undefined);
      assert.notEqual(chat().released, true);
      assert.equal(readFileSync(path, 'utf8'), saved);
      assert.deepEqual(calls, []);
      console.log('PI_WEB_HOST_AMBIGUOUS_DISPATCH_BLOCKED');
      return;
    }

    await until('automatic stock Abort and repeated held-work checks', () => aborts.length > 0 && busyChecks >= 2);
    assert.deepEqual(aborts[0], { aborted: true, body: { cwd }, parked: true });
    assert.equal((await readSwitch()).phase, 'stopping');
    assert.equal(owner().terminalTicket, undefined, 'never grant Terminal a ticket while Chat still owns work');
    assert.equal(stop, undefined);
    assert.notEqual(chat().released, true);
    assert.equal((await health()).activeSessions, 1);
    assert.deepEqual(calls, [seed], 'the parked request has not reached the model');
    await prompt('New prompt after the switch fence', 409);
    const beforeFencedCommand = lastInput();
    await command(409, '/codeflare-fixture fenced');
    assert.equal(lastInput(), beforeFencedCommand);
    await upload(409, [attachment(Buffer.from('fenced'))], { folder: 'fenced-attachment' });
    assert.equal(existsSync(join(cwd, 'fenced-attachment')), false);

    writeFileSync(resume, '');
    const ticket = await until('Terminal ticket after native Chat release', () => {
      const current = owner();
      return current.terminalTicket && current;
    }, 20_000);
    assert.equal(ticket.phase, 'opening');
    assert.equal(ticket.requestId, requestId);
    assert.equal(ticket.target, 'terminal');
    assert.equal(stop?.stopped, true, 'stock itself must acknowledge writer close');
    assert.equal(stop.beforeStop.terminalTicket, undefined);
    assert.ok(aborts.some(attempt => !attempt.parked && attempt.aborted), 'native Abort must stop the turn as it becomes cancellable');
    const released = chat();
    assert.equal(released.released, true);
    assert.equal(released.releaseReady, requestId);
    for (const key of ['pid', 'startTime', 'instance']) assert.equal(released[key], source[key]);
    assert.deepEqual(identity(released), identity(source));
    assert.deepEqual(ticket.binding, identity(released));
    assert.equal((await health()).activeSessions, 0);
    assert.equal(await writer(), 'not-hosted', 'read-only catalog must not reacquire the writer');
    assert.equal(readFileSync(join(home, '.codeflare/classic/sessions', `cf-${sessionId}`, 'agent-session-id'), 'utf8'), `${id}\n`);
    const transcript = readFileSync(path, 'utf8');
    const inode = statSync(path).ino;
    assert.ok(transcript.startsWith(saved), 'release preserves the previous transcript bytes');

    const { leaf, expectedCalls } = await reopenTerminal(cwd, ticket, released, readSwitch, async (stdin, native) => {
      assert.equal((await readSwitch()).surface, 'terminal');
      assert.equal(statSync(path).ino, inode);
      assert.ok(readFileSync(path, 'utf8').startsWith(transcript));
      assert.deepEqual(readdirSync(dirname(path)).filter(file => file.endsWith('.jsonl')), [basename(path)]);
      assert.ok(calls.length === 1 || calls.length === 2 && calls[1] === held, 'no new prompt or replay on Terminal');
      await api(`${ref}/transcript-snapshot?${query}`, 409);
      assert.equal((await health()).activeSessions, 0, 'stale Chat cannot reopen the transcript');

      // REQ-AGENT-272 AC2/AC3/AC6: drive the same live TUI, with no manual Abort or quit.
      const expectedCalls = [...calls, nativePrompt];
      stdin.write(`\x1b[200~${nativePrompt}\x1b[201~\r`);
      await until('native Terminal turn is parked at the model', () => nativeStream === 'parked' && terminal().idle === false);
      nativePid = native.pid;
      const returnId = randomUUID();
      await api('/_switch', 202, { generation, requestId: returnId, target: 'chat' });
      const opening = await until('Chat target opens after Terminal release', async () => {
        const state = await readSwitch();
        assert.ok(!['failed', 'uncertain'].includes(state.phase), `Terminal → Chat switch: ${state.phase}`);
        return state.chatUrl && state;
      }, 20_000);
      assert.deepEqual([opening.phase, opening.requestId, opening.chatUrl], ['opening', returnId, chatUrl]);
      assert.notEqual(processAtChatOpen, undefined, 'observe the first Host Chat open request');
      const fields = processAtChatOpen.slice(processAtChatOpen.lastIndexOf(')') + 2).split(' ');
      assert.ok(fields[0] === 'Z' || fields[19] !== native.startTime, 'the exact CLI must exit before Host opens Chat');
      await until('native Abort disconnects the parked stream', () => nativeStream === 'closed');
      const ended = terminal();
      for (const key of ['pid', 'startTime', 'instance', 'ticket']) assert.equal(ended[key], native[key]);
      assert.deepEqual([ended.released, ended.releaseReady, ended.idle], [true, returnId, true]);
      assert.deepEqual(identity(ended), { id, cwd, path });
      assert.ok(ended.leaf, 'the interrupted turn has a saved branch');
      assert.equal(messages(readFileSync(path, 'utf8')).at(-1)?.stopReason, 'aborted');
      return { leaf: ended.leaf, expectedCalls };
    });
    assert.equal((await health()).activeSessions, 0, 'Chat has not acquired a writer before the snapshot');
    const returned = await snapshot();
    assert.equal(returned.status.sessionId, id);
    assert.equal(returned.partial, null);
    const history = returned.page.messages.map(message => text(message.content));
    assert.ok(history.includes(reply) && history.includes(nativePrompt), 'Chat shows the saved Terminal branch');
    await until('return to Chat completes', async () => {
      const state = await readSwitch();
      return state.phase === 'complete' && state.surface === 'chat';
    });
    const reopened = chat();
    assert.deepEqual({ ...identity(reopened), leaf: reopened.leaf }, { id, cwd, path, leaf });
    assert.equal(statSync(path).ino, inode);
    assert.ok(readFileSync(path, 'utf8').startsWith(transcript));
    assert.deepEqual(calls, expectedCalls, 'Chat must not replay the interrupted Terminal turn');
    console.log('PI_WEB_HOST_HANDOFF_OK');
    if (mode !== 'handoff') await qualifyRetry(expectedCalls, ticket.terminalTicket, reopened);

    async function qualifyRetry(expectedCalls, previousTicket, reopened) {
      await api('/_switch', 202, { generation, requestId: randomUUID(), target: 'terminal' });
      const nextTicket = await until('native opening before Chat startup retry', () => {
        const current = owner();
        return current.phase === 'opening' && current.target === 'terminal' && current.terminalTicket &&
          current.terminalTicket !== previousTicket && current;
      });
      const retryId = randomUUID();
      await reopenTerminal(cwd, nextTicket, reopened, readSwitch, async stdin => {
        stdin.write(`\x1b[200~${handled}\x1b[201~\r`);
        await until('native input hook entered', () => existsSync(nativeParked));
        await api('/_switch', 202, { generation, requestId: retryId, target: 'chat' });
        await until('native preflight is fenced', async () => (await readSwitch()).phase === 'stopping');
        await delay(600);
        assert.equal((await readSwitch()).phase, 'stopping', 'a held native input cannot pass for idle');
        assert.notEqual(terminal().released, true);
        writeFileSync(nativeResume, '');
        await until('handled input allows the original switch to open Chat', async () => (await readSwitch()).chatUrl);
      });
      // Load the frame document but not its client: attachment starts the
      // deadline, yet no transcript request produces a writer receipt.
      const retryFrame = await nativeFetch(deepLink, { headers: browserHeaders });
      assert.equal(retryFrame.status, 200);
      await retryFrame.arrayBuffer();
      await until('missing startup receipt reaches a retry-safe outcome', async () => {
        const state = await readSwitch();
        return state.phase === 'failed' && state.requestId === retryId && state.surface === null;
      }, 40_000);
      await assert.rejects(() => nativeFetch(`${stock}/api/sessiond/health`, { signal: AbortSignal.timeout(2000) }),
        'the previous stock service must be gone before retry');
      await api('/_switch', 202, { generation, requestId: retryId, target: 'chat' });
      await until('same attempt offers Chat again', async () => (await readSwitch()).chatUrl);
      // An HTTP snapshot does not imply live delivery. Fail just the event
      // upgrade, then verify that a new snapshot can follow a successful join.
      refuseSessionEvents = true;
      const rejectedEvents = connectEvents();
      await assert.rejects(once(rejectedEvents, 'open', { signal: AbortSignal.timeout(6000) }), /503/);
      const readBrowserSnapshot = () => api(`/api/machines/local/sessions/${encodeURIComponent(id)}/transcript-snapshot?${query}`);
      const offlineSnapshot = await readBrowserSnapshot();
      assert.equal(offlineSnapshot.status.sessionId, id);
      refuseSessionEvents = false;
      const liveEvents = connectEvents();
      try {
        await once(liveEvents, 'open', { signal: AbortSignal.timeout(6000) });
        const catchUp = await readBrowserSnapshot();
        assert.equal(catchUp.status.sessionId, id);
        assert.ok(catchUp.seq >= offlineSnapshot.seq, 'catch-up must not regress the transcript watermark');
      } finally { liveEvents.terminate(); }
      await until('same attempt confirms a single recovered Chat writer', async () => {
        const state = await readSwitch();
        return state.phase === 'complete' && state.requestId === retryId && state.surface === 'chat';
      });
      assert.equal((await health()).activeSessions, 1);
      assert.deepEqual(calls, expectedCalls, 'handled input and startup retry never reach the model');
      console.log('PI_WEB_HOST_CHAT_STARTUP_RETRY_OK');

      const resumeReceipt = chat();
      // Model the retiring Herdr wrapper independently of its Pi child. The
      // qualification process keeps this registration live across the rapid return.
      const wrapperPath = join(runtimeDir, 'wrapper.json');
      const wrapperStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      writeFileSync(wrapperPath, JSON.stringify({ generation, pid: process.pid,
        startTime: wrapperStat.slice(wrapperStat.lastIndexOf(')') + 2).split(' ')[19], pane: 'classic' }));
      await api('/_switch', 202, { generation, requestId: randomUUID(), target: 'terminal' });
      const quitTicket = await until('native ticket before ordinary quit', () => {
        const current = owner();
        return current.phase === 'opening' && current.target === 'terminal' && current.terminalTicket !== nextTicket.terminalTicket && current;
      });
      await reopenTerminal(cwd, quitTicket, resumeReceipt, readSwitch, async (stdin, native) => {
        stdin.write('\x04');
        await until('ordinary quit carries exact native evidence', () => {
          const ended = terminal();
          return ended.instance === native.instance && ended.ticket === native.ticket && ended.quit === true;
        });
      });
      assert.equal((await readSwitch()).surface, 'terminal', 'ordinary quit does not open Chat by itself');
      await api('/_switch', 202, { generation, requestId: randomUUID(), target: 'chat' });
      await until('verified ordinary quit permits Chat to open the exact transcript', async () => (await readSwitch()).chatUrl);
      assert.equal((await snapshot()).status.sessionId, id);
      await until('post-quit Chat is the confirmed writer', async () => (await readSwitch()).surface === 'chat');
      assert.deepEqual(calls, expectedCalls);
      const rapidReturn = randomUUID();
      await api('/_switch', 202, { generation, requestId: rapidReturn, target: 'terminal' });
      await until('rapid return stays retryable while the old wrapper is retiring', async () => {
        const state = await readSwitch();
        assert.equal(owner().terminalTicket, quitTicket.terminalTicket, 'retiring wrapper must never receive a grant');
        return state.phase === 'failed' && state.requestId === rapidReturn;
      });
      assert.equal((await health()).activeSessions, 0);
      console.log('PI_WEB_HOST_NATIVE_QUIT_OK');
    }
  } finally {
    restoreSpawn();
    startupEvents?.terminate();
    globalThis.fetch = nativeFetch;
    http.request = nativeHttpRequest;
    console.info = info;
    writeFileSync(resume, '');
    writeFileSync(nativeResume, '');
    await Promise.all([proxy.close(), close(server), close(modelServer), close(occupiedGateway)]);
    rmSync(home, { recursive: true, force: true });
  }
}

await qualify(false);
if (!retryOnly) await qualify(true);
