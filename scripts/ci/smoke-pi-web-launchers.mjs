// Non-deploy CI only: real launchers at the private owner/ticket boundary.
// The separate Host/TUI smoke owns the end-to-end switch and stock Chat writer.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createPiWebRuntime } from '../../host/dist/pi-web-runtime.js';
import { managedPiPackage } from '../../host/dist/pi-web-services.js';
import { handlePrewarmOrphanExpiry } from '../../host/dist/prewarm-readiness.js';

const run = promisify(execFile);
const piPackage = managedPiPackage();
const { SessionManager } = await import(pathToFileURL(join(piPackage, 'dist/index.js')).href);
const piCli = join(piPackage, 'dist/bundle/cli.js');
const isPi = ({ argv }) => argv?.some(arg => arg === '/usr/local/bin/pi' || arg === piCli);
const writer = '/usr/local/bin/codeflare-terminal-writer';
const launcher = '/usr/local/bin/codeflare-herdr-terminal';
const herdr = '/usr/local/bin/herdr';
const sessionId = 'launchsmoke';
const name = `cf-${sessionId}`;
const history = 'Saved launcher history';
const provider = 'launcher-fixture';
const model = 'launcher-model';
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const identity = ({ id, cwd, path }) => ({ id, cwd, path });

function alive({ pid, startTime }) {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] !== 'Z' && fields[19] === startTime;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function startPty(command, cwd, env) {
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', `stty rows 40 cols 120; exec ${command}`, '/dev/null'], {
    cwd, env: { ...env, TERM: 'xterm-256color', SHELL: '/bin/bash' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '', closed = false;
  const record = chunk => { log = (log + chunk).slice(-16_384); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.on('error', error => record(error.message));
  const done = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  return {
    output: () => log,
    live: () => !closed && child.exitCode === null && child.signalCode === null,
    async stop() {
      child.kill('SIGTERM');
      if (!await Promise.race([done.then(() => true), delay(5000, false, { ref: false })])) {
        child.kill('SIGKILL');
        await done;
      }
      child.stdin.end();
    },
    async until(label, probe, ms = 15_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && this.live()) {
        const value = await probe();
        if (value) return value;
        await delay(75);
      }
      throw new Error(`${label}: ${closed ? 'PTY exited' : 'timed out'}\n${log.slice(-4000)}`);
    },
  };
}

async function qualify(mode) {
  const home = mkdtempSync('/tmp/pwl-'); // Keep Herdr's named Unix socket paths short.
  const workspace = join(home, 'workspace');
  const cwd = mode === 'herdr' ? '/home/user/workspace' : workspace;
  const agent = join(home, '.pi/agent');
  const sessionDir = join(agent, 'sessions', `--${cwd.slice(1).replaceAll('/', '-')}--`);
  const sessionFile = join(home, '.codeflare/herdr/sessions', name, 'session.json');
  let generation = 6, runtimeRoot, runtimeDir, env, ownerPath, reportPath, bootDone, pty;

  function boot() {
    generation++;
    runtimeRoot = join(home, `r${generation}`);
    runtimeDir = join(runtimeRoot, 'pi-web');
    ownerPath = join(runtimeDir, 'owner.json');
    reportPath = join(runtimeDir, 'terminal.json');
    bootDone = join(runtimeRoot, 'herdr', sessionId, 'bootstrap.done');
    mkdirSync(runtimeDir, { recursive: true });
    env = { ...process.env, HOME: home, CODEFLARE_RUNTIME_ROOT: runtimeRoot, CODEFLARE_PI_SURFACE: 'chat',
      CODEFLARE_PI_GENERATION: String(generation), SESSION_ID: sessionId, TAB_CONFIG: '[{"id":"1","command":"pi"}]' };
    pty = startPty(mode === 'herdr' ? launcher : writer, cwd, env);
  }

  const control = (...args) => run(herdr, args, { cwd, timeout: 2000, env: { ...env,
    HERDR_SESSION: name, HERDR_CONFIG_PATH: '/etc/codeflare/herdr/config.toml', HERDR_DISABLE_SOUND: '1',
    XDG_CONFIG_HOME: join(runtimeRoot, 'herdr-config'), XDG_STATE_HOME: join(runtimeRoot, 'herdr', sessionId, 'state'),
  } });
  const snapshot = async () => JSON.parse((await control('api', 'snapshot')).stdout).result.snapshot;
  const foreground = async pane => JSON.parse((await control('pane', 'process-info', '--pane', pane)).stdout)
    .result.process_info.foreground_processes ?? [];
  const readyPane = () => pty.until('Herdr topology ready', async () => existsSync(bootDone) && (await snapshot()).focused_pane_id);
  const waiting = pane => pty.until('managed wrapper is live in the correct Herdr pane', async () =>
    (await foreground(pane)).some(({ argv }) => argv?.some(arg => basename(arg) === basename(writer))));
  const stopHerdr = () => run(launcher, ['stop'], { cwd, env, timeout: 7000 });
  async function stopRuntime() {
    await pty.stop();
    if (mode === 'herdr') await stopHerdr();
    pty = undefined;
  }

  function publish(fields) {
    writeFileSync(`${ownerPath}.next`, JSON.stringify({ ...fields, generation }));
    renameSync(`${ownerPath}.next`, ownerPath);
  }

  async function noTicket(pane) {
    // Span more than two wrapper polls with no owner grant; the live terminal
    // must not start native Pi, including a CLI that does not load our extension.
    for (let i = 0; i < 4; i++) {
      await delay(175);
      assert.ok(pty.live(), `${mode} primary exited before it had a ticket`);
      assert.equal(existsSync(reportPath), false, 'Chat-first must not have a Terminal writer');
      if (mode === 'classic') assert.equal(pty.output().trim(), '', 'Classic must not show a Pi TUI before a ticket');
      else assert.ok(!(await foreground(pane)).some(isPi), 'Herdr must not run Pi before a ticket');
    }
  }

  let binding, leaf, saved, inode;
  async function openExact(pane) {
    const grant = { surface: null, phase: 'opening', target: 'terminal', requestId: randomUUID(),
      terminalTicket: randomUUID(), binding };
    publish(grant);
    const native = await pty.until(`${mode} opens the ticket's exact native transcript`, () => {
      const value = existsSync(reportPath) && json(reportPath);
      return value && value.ticket === grant.terminalTicket && value.idle && !value.released && alive(value) && value;
    });
    assert.deepEqual(identity(native), binding);
    assert.deepEqual([native.generation, native.leaf], [generation, leaf]);
    if (mode === 'herdr') {
      assert.ok((await foreground(pane)).some(({ pid }) => pid === native.pid), 'exact Pi must run in the saved pane');
    } else await pty.until('Classic renders saved history', () => pty.output().includes(history));
    assert.equal(statSync(binding.path).ino, inode);
    assert.equal(read(binding.path), saved, 'opening must not replace, replay, or rewrite the saved conversation');
    assert.deepEqual(readdirSync(sessionDir).filter(file => file.endsWith('.jsonl')), [basename(binding.path)]);
    return { grant, native };
  }

  try {
    mkdirSync(cwd, { recursive: true });
    if (workspace !== cwd) symlinkSync(cwd, workspace); // The shipped Herdr config has a fixed initial cwd.
    mkdirSync(agent, { recursive: true });
    // No prompts are submitted, so no model server or credentials are needed.
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-fixture-not-a-secret', models: [{ id: model }],
    } } }));

    // REQ-AGENT-272 AC1/AC2: Chat-first has no competing writer and the
    // same live primary still consumes an exact ticket after orphan expiry.
    boot();
    const pane = mode === 'herdr' ? await readyPane() : undefined;
    if (pane) await waiting(pane);
    else await pty.until('Classic prewarm PTY emitted its startup byte', () => pty.output().includes('\r'));
    await noTicket(pane);
    assert.ok(!existsSync(sessionDir) || !readdirSync(sessionDir).some(file => file.endsWith('.jsonl')),
      'Chat-first must not create a Terminal conversation');
    assert.equal(handlePrewarmOrphanExpiry(mode, mode === 'classic' || existsSync(bootDone), {
      disposeDataListener() {}, clearReadinessPoll() {}, deleteSession: () => { void pty.stop(); },
    }, pty.live()), 'retained');

    const seed = SessionManager.create(cwd, sessionDir);
    seed.appendModelChange(provider, model);
    seed.appendThinkingLevelChange('off');
    leaf = seed.appendMessage({ role: 'user', content: history, timestamp: Date.now() });
    binding = { id: seed.getSessionId(), cwd, path: seed.getSessionFile() };
    saved = read(binding.path);
    inode = statSync(binding.path).ino;
    const { grant, native } = await openExact(pane);

    if (mode === 'classic') {
      const requestId = randomUUID();
      publish({ ...grant, surface: 'terminal', phase: 'releasing', target: 'chat', requestId });
      await pty.until('Classic quits Pi without losing its PTY', () => {
        const end = json(reportPath);
        return end.instance === native.instance && end.released && end.releaseReady === requestId && !alive(native);
      });
      publish(grant); // A consumed ticket must not reopen Pi, even after the previous child exited.
      await delay(700);
      assert.equal(json(reportPath).released, true);
      const reopened = await openExact(pane);
      assert.notEqual(reopened.native.instance, native.instance);
      console.log('PI_WEB_CLASSIC_LAUNCHER_OK');
      return;
    }

    // Move focus away from the managed primary before saving. A restore that
    // injects into the focused shell instead of restoring the role cannot pass.
    await control('pane', 'split', pane, '--direction', 'right', '--focus', '--cwd', cwd);
    const secondary = (await snapshot()).focused_pane_id;
    assert.ok(secondary && secondary !== pane);
    await stopRuntime();
    await ptylessExit(native);
    console.log('PI_WEB_HERDR_FRESH_LAUNCHER_OK');

    boot();
    assert.equal(await readyPane(), secondary, 'restored focus must remain on the other pane');
    await waiting(pane);
    await noTicket(pane);
    const restored = await openExact(pane);
    assert.notEqual(restored.native.instance, native.instance);
    await stopRuntime();
    await ptylessExit(restored.native);
    console.log('PI_WEB_HERDR_MANAGED_RESTORE_OK');

    // Age the real saved topology to the pre-ticket format. Keep the native
    // path Herdr recorded; only remove the newer custom resume argv.
    const legacy = json(sessionFile);
    const panes = legacy.workspaces.flatMap(ws => ws.tabs.flatMap(tab => Object.values(tab.panes)));
    assert.ok(panes.some(entry => entry.agent_session?.value === binding.path), 'Herdr did not save the native session reference');
    for (const entry of panes) delete entry.agent_resume;
    writeFileSync(sessionFile, JSON.stringify(legacy));
    boot();
    await readyPane();
    await pty.until('legacy Herdr resumes the native Pi in the original pane', async () =>
      (await foreground(pane)).some(process => isPi(process) && process.argv.includes(binding.path)));
    assert.equal(existsSync(reportPath), false, 'legacy Pi is not a ticket-managed writer');
    const runtime = createPiWebRuntime({ sessionId, generation, initialSurface: 'chat', terminalMode: 'herdr',
      cwd, home, runtimeDir, cloneRestored: () => existsSync(bootDone) });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const refused = runtime.initialize();
      void refused.catch(() => {});
      await pty.until('Host refuses a competing Chat writer for legacy Herdr', () => runtime.legacyHerdr, 5000);
      await refused;
      assert.deepEqual([runtime.status().phase, runtime.status().surface, runtime.status().chatUrl, runtime.ready],
        ['failed', 'terminal', undefined, false]);
    } finally {
      await runtime.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    await stopRuntime();
    console.log('PI_WEB_HERDR_LEGACY_RESTORE_OK');
  } finally {
    if (pty) {
      await pty.stop();
      if (mode === 'herdr') await stopHerdr().catch(error => console.error(`Herdr cleanup: ${error.message}`));
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function ptylessExit(native) {
  for (let i = 0; i < 40 && alive(native); i++) await delay(75);
  assert.equal(alive(native), false, 'the named Herdr runtime must stop its previous Pi');
}

await qualify('classic');
await qualify('herdr');
