// Built-image smoke, not a local test. RED unobserved: the packaged services only run in CI.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
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
const modelServer = createServer(async (req, res) => {
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

    const request = async (path, body) => {
      const response = await fetch(new URL(path, origin), {
        signal: AbortSignal.timeout(5000), redirect: 'error',
        ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response;
    };
    const api = async (path, body) => (await request(path, body)).json();
    const health = () => api('/api/sessiond/health');
    const start = async () => {
      const pair = ['pi-web-sessiond.sh', 'pi-web-server.sh'].map((name) => {
        const process = launch(join(WEB_DIST, 'bin', name), [], options);
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

    // REQ-AGENT-272 AC2: native CLI creates the file and exits before the browser API can open it.
    await run(PI, ['--print', TURNS[0][0]], { ...options, timeout: 15_000, killSignal: 'SIGKILL' });
    const sessionFiles = async () => (await readdir(sessions, { recursive: true })).filter((name) => name.endsWith('.jsonl'));
    const files = await sessionFiles();
    assert.equal(files.length, 1, 'native Pi must create exactly one transcript');
    const file = join(sessions, files[0]);
    const before = await readFile(file, 'utf8');
    const [header, ...oldEntries] = parseTranscript(before);
    assert.equal(header.type, 'session');
    assert.equal(header.cwd, cwd);
    assert.ok(header.id, 'the native file must have a session identity');
    assert.deepEqual(visible(durableChat(oldEntries).map(({ message }) => message)), expected(TURNS.slice(0, 1)));

    const project = await api('/api/projects', { path: cwd });
    const { workspaces } = await api(`/api/projects/${encodeURIComponent(project.id)}/workspaces`);
    const workspace = workspaces.find(({ path, isMain }) => path === cwd && isMain);
    assert.ok(workspace, 'stock browser workspace catalog must resolve the canonical cwd');
    const page = `/?${new URLSearchParams({ project: project.id, workspace: workspace.id, session: header.id, view: 'chat' })}`;
    const html = await (await request(page)).text();
    const asset = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\.\/assets\/[^" ]+)"/u)?.[1];
    assert.ok(asset, 'stock Chat entry must identify a relative browser bundle');
    const js = await request(asset);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    await js.body.cancel();

    const query = new URLSearchParams({ cwd });
    const catalog = await api(`/api/sessions?${query}`);
    assert.deepEqual(catalog.map(({ id, path, cwd }) => ({ id, path, cwd })), [{ id: header.id, path: file, cwd }]);
    const ref = `/api/sessions/${encodeURIComponent(header.id)}`;
    const snapshot = () => api(`${ref}/transcript-snapshot?${query}`);
    const checkSnapshot = (state, entries, turns) => {
      assert.equal(state.status.sessionId, header.id);
      assert.equal(state.status.persisted, true);
      assert.equal(state.partial, null);
      assert.deepEqual(visible(state.page.messages), expected(turns));
      assert.deepEqual(chatMessages(state.page.messages).map(({ entryId }) => entryId), durableChat(entries).map(({ id }) => id));
    };
    checkSnapshot(await snapshot(), oldEntries, TURNS.slice(0, 1));
    assert.ok(!(await api(`${ref}/commands?${query}`)).some(({ name }) => name === 'worktree'), 'no /worktree in Chat');
    assert.equal((await api(`${ref}/prompt`, { cwd, text: TURNS[1][0] })).accepted, true);
    const settled = await waitFor('stock browser turn persisted and settled', async () => {
      const state = await snapshot();
      const { isStreaming, isCompacting, isBashRunning, pendingMessageCount, pendingDialogs } = state.status;
      return !isStreaming && !isCompacting && !isBashRunning && pendingMessageCount === 0 && !pendingDialogs?.length
        && chatMessages(state.page.messages).length === 4 && state;
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
