// CI only: use the locked stock services and managed CLI in the isolated Node image.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createPiWebProxy } from '../../host/dist/pi-web-proxy.js';
import { createPiWebRuntime } from '../../host/dist/pi-web-runtime.js';
import { PI_WEB_PORT } from '../../host/dist/pi-web-services.js';

const stock = `http://127.0.0.1:${PI_WEB_PORT}`;
const nativeFetch = globalThis.fetch;
const nativeHttpRequest = http.request;
const generation = 7;
const sessionId = 'handoffsmoke';
const prefix = `/api/pi-web/${sessionId}`;
const provider = 'handoff-fixture';
const model = 'handoff-text';
const seed = 'Keep this exact saved question.';
const reply = 'Keep this exact saved reply.';
const held = 'Do not wait for a normal reply to this input.';
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

async function request(origin, path, expected = 200, body, headers = {}) {
  const response = await nativeFetch(origin + path, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { ...headers,
      ...(body !== undefined && { 'Content-Type': 'application/json', Origin: origin }) },
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
  });
  const result = await response.text();
  assert.equal(response.status, expected, `${path}: ${result.slice(0, 400)}`);
  return JSON.parse(result);
}

async function reopenTerminal(cwd, owner, released, readSwitch) {
  // Consume the exact issued ticket in a real PTY, without depending on the
  // full Classic launcher or Herdr pane setup in this minimal image.
  assert.ok(existsSync('/usr/bin/script'), 'isolated image must provide the script PTY driver');
  const terminalPath = join(process.env.CODEFLARE_RUNTIME_ROOT, 'pi-web/terminal.json');
  const cli = spawn('/usr/bin/script', ['-q', '-e', '-c',
    'export CODEFLARE_PI_TERMINAL_PID=$$; exec /usr/local/bin/pi --extension /opt/codeflare/pi-web/handoff-extension.ts --session "$CODEFLARE_PI_TERMINAL_SESSION_PATH"',
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
  } catch (error) {
    throw new Error(`Native Terminal handoff failed: ${output.slice(-4000)}`, { cause: error });
  } finally {
    cli.stdin.write('\x04'); // Native exit on an empty editor; not used to establish Chat release.
    try {
      assert.deepEqual(await Promise.race([done, delay(5000, undefined, { ref: false })]), [0, null], 'native TUI must quit normally');
    } finally { cli.stdin.end(); }
  }
}

async function qualify(ambiguous) {
  const home = mkdtempSync('/tmp/pi-web-host-handoff-');
  const cwd = join(home, 'workspace');
  const agentDir = join(home, '.pi/agent');
  const runtimeRoot = join(home, 'run');
  const runtimeDir = join(runtimeRoot, 'pi-web');
  const extensions = join(agentDir, 'extensions');
  const parked = join(home, 'parked');
  const resume = join(home, 'resume');
  const owner = () => json(join(runtimeDir, 'owner.json'));
  const chat = () => json(join(runtimeDir, 'chat.json'));
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, CODEFLARE_RUNTIME_ROOT: runtimeRoot,
    CODEFLARE_PI_GENERATION: String(generation), CODEFLARE_PI_SURFACE: 'chat', SESSION_ID: sessionId });

  const calls = [];
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
      else res.destroy();
    } catch { res.destroy(); }
  });
  const runtime = createPiWebRuntime({ sessionId, generation, initialSurface: 'chat', terminalMode: 'classic',
    cwd, home, runtimeDir, cloneRestored: () => true });
  const proxy = createPiWebProxy({ sessionId, runtime, recordInput() {} });
  const server = createServer((req, res) => { void proxy.handle(req, res); });
  try {
    mkdirSync(cwd);
    mkdirSync(extensions, { recursive: true });
    const modelOrigin = await listen(modelServer);
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: model }));
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: {
      api: 'openai-completions', baseUrl: `${modelOrigin}/v1`, apiKey: 'local-fixture-not-a-secret', models: [{ id: model }],
    } } }));
    // Only a public input hook is added; the image-owned handoff extension
    // still registers and writes all native ownership evidence itself.
    writeFileSync(join(extensions, 'held-input.ts'), `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
export default function (pi) {
  pi.on('input', async (event, ctx) => {
    if (ctx.mode !== 'rpc' || event.text !== ${JSON.stringify(held)}) return;
    writeFileSync(${JSON.stringify(parked)}, ctx.sessionManager.getSessionId());
    while (!existsSync(${JSON.stringify(resume)})) await delay(25);
    return { action: '${ambiguous ? 'handled' : 'continue'}' };
  });
}
`);
    const origin = await listen(server);
    const api = (path, expected, body) => request(origin, prefix + path, expected, body, {
      'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'http', 'x-codeflare-pi-generation': String(generation),
    });
    const boot = runtime.initialize();
    void boot.catch(() => {});
    const readSwitch = () => api(`/_switch?generation=${generation}`);
    const chatUrl = await until('Chat deep link', async () => {
      const state = await readSwitch();
      if (state.phase === 'failed') await boot;
      return state.chatUrl;
    }, 35_000);
    const { id, path } = runtime.binding;
    const params = new URL(chatUrl, origin).searchParams;
    assert.equal(params.get('session'), id);
    const catalog = `/api/plugin-catalog/projects/${encodeURIComponent(params.get('project'))}/workspaces/${encodeURIComponent(params.get('workspace'))}/sessions/${encodeURIComponent(id)}`;
    const ref = `/api/sessions/${encodeURIComponent(id)}`;
    const query = new URLSearchParams({ cwd });
    const snapshot = () => api(`${ref}/transcript-snapshot?${query}`);
    const health = () => request(stock, '/api/sessiond/health');
    const writer = async () => {
      const row = await request(stock, catalog);
      assert.deepEqual({ id: row.id, cwd: row.cwd, archived: row.archived }, { id, cwd, archived: false });
      return row.runtime;
    };
    assert.equal((await snapshot()).status.sessionId, id);
    await until('image-managed Chat writer ready', () => runtime.ready);
    await boot;
    const source = chat();
    assert.deepEqual(identity(source), { id, cwd, path });

    let busyChecks = 0;
    let stop;
    const aborts = [];
    // Observe the real private control HTTP calls used by the coordinator.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
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
    if (ambiguous) {
      // Lose only the browser proxy's prompt acknowledgment, after the
      // genuine stock HTTP call proves it was accepted by the daemon.
      http.request = (url, options, receive) => {
        if (url.origin !== stock || url.pathname !== `${ref}/prompt` || options.method !== 'POST') {
          return nativeHttpRequest(url, options, receive);
        }
        const upstream = nativeHttpRequest(url, options, response => {
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
    const prompt = (message, status = 200) => api(`${ref}/prompt`, status, { cwd, text: message });
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

    await reopenTerminal(cwd, ticket, released, readSwitch);
    assert.equal((await readSwitch()).surface, 'terminal');
    assert.equal(statSync(path).ino, inode);
    assert.ok(readFileSync(path, 'utf8').startsWith(transcript));
    assert.deepEqual(readdirSync(dirname(path)).filter(file => file.endsWith('.jsonl')), [basename(path)]);
    assert.ok(calls.length === 1 || calls.length === 2 && calls[1] === held, 'no new prompt or replay on Terminal');
    await api(`${ref}/transcript-snapshot?${query}`, 409);
    assert.equal((await health()).activeSessions, 0, 'stale Chat cannot reopen the transcript');
    console.log('PI_WEB_HOST_HANDOFF_OK');
  } finally {
    globalThis.fetch = nativeFetch;
    http.request = nativeHttpRequest;
    writeFileSync(resume, '');
    await Promise.all([proxy.close(), close(server), close(modelServer)]);
    rmSync(home, { recursive: true, force: true });
  }
}

await qualify(false);
await qualify(true);
