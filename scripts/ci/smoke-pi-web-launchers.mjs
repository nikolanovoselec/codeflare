// Non-deploy CI only: real launchers at the private owner/ticket boundary.
// The separate Host/TUI smoke owns the end-to-end switch and stock Chat writer.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
// Pi replaces its process title once initialized, so the original argv can vanish.
const isPi = ({ name, argv }) => name === 'pi' || argv?.some(arg => arg === '/usr/local/bin/pi' || arg === piCli);
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
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', `stty rows 40 cols 120; ${command}`, '/dev/null'], {
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
    write: text => child.stdin.write(text),
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
  const managedAv = ['codeflare-terminal-writer', '--tui-mode', 'fullscreen'];
  const savedPanes = saved => saved.workspaces.flatMap(ws => ws.tabs.flatMap(tab => Object.values(tab.panes)));
  const savedPane = (saved, id) => {
    const [workspace, pane] = id.split(':p');
    // These fixtures use the first two public pane numbers in one workspace.
    const ws = saved.workspaces.find(entry => entry.id === workspace);
    const raw = Object.keys(ws.public_pane_numbers).find(key => ws.public_pane_numbers[key] === Number(pane));
    return ws.tabs.find(tab => tab.panes[raw])?.panes[raw];
  };
  const savedPrimary = saved => savedPanes(saved).filter(entry => entry.agent_session?.value === binding.path);
  function sameNativeRegistration(session) {
    return !!binding && session?.source === 'herdr:pi' && session.agent === 'pi'
      && session.kind === 'path' && session.value === binding.path;
  }
  function hasManagedRole(entry) {
    const role = entry.agent_resume;
    if (JSON.stringify(role?.argv) !== JSON.stringify(managedAv)) return false;
    return role.source === 'codeflare:terminal-writer' && role.agent === 'codeflare-terminal-writer'
      || role.source === 'herdr:pi' && role.agent === 'pi' && sameNativeRegistration(entry.agent_session);
  }
  async function parkedOnOriginalPane(pane) {
    const owner = await readPane(pane);
    if (owner.pane_id !== pane || !(owner.agent === 'codeflare-terminal-writer' && !owner.agent_session
      || (owner.agent === 'pi' || owner.agent == null) && sameNativeRegistration(owner.agent_session))) return false;
    const wrapper = json(join(runtimeDir, 'wrapper.json'));
    return wrapper.generation === generation && wrapper.pane === pane && alive(wrapper)
      && (await foreground(pane)).some(({ pid }) => pid === wrapper.pid);
  }
  const countSavedRoles = () => existsSync(sessionFile) && savedPanes(json(sessionFile)).filter(hasManagedRole).length;
  const readPane = async pane => JSON.parse((await control('pane', 'get', pane)).stdout).result.pane;
  async function parkEvidence(pane, native, requestId) {
    const current = existsSync(reportPath) && json(reportPath);
    const owner = await readPane(pane).catch(() => undefined);
    const processes = await foreground(pane).catch(() => []);
    const roles = existsSync(sessionFile) ? savedPanes(json(sessionFile)).filter(entry => entry.agent_resume) : [];
    return {
      released: current?.instance === native?.instance && current?.released === true,
      matchingRelease: !!requestId && current?.releaseReady === requestId,
      nativeAlive: native && alive(native),
      pane: owner?.pane_id,
      paneAgent: owner?.agent,
      hasNativeIdentity: !!owner?.agent_session,
      exactNativeIdentity: sameNativeRegistration(owner?.agent_session),
      foreground: processes.map(({ pid, name }) => ({ pid, name })),
      roles: roles.map(entry => ({ source: entry.agent_resume.source, agent: entry.agent_resume.agent, managed: hasManagedRole(entry) })),
      report: (existsSync(join(runtimeDir, 'herdr-park.log')) ? read(join(runtimeDir, 'herdr-park.log')) : pty.output())
        .match(/Codeflare: Herdr [^\r\n\x1b]*/g)?.slice(-4),
    };
  }

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
    pty = startPty(mode === 'herdr' ? `exec ${launcher}` : `${writer}; exec /bin/bash --noprofile --norc -i`, cwd, env);
  }

  const control = (...args) => run(herdr, args, { cwd, timeout: 2000, env: { ...env,
    HERDR_SESSION: name, HERDR_CONFIG_PATH: '/etc/codeflare/herdr/config.toml', HERDR_DISABLE_SOUND: '1',
    XDG_CONFIG_HOME: join(runtimeRoot, 'herdr-config'), XDG_STATE_HOME: join(runtimeRoot, 'herdr', sessionId, 'state'),
  } });
  const snapshot = async () => JSON.parse((await control('api', 'snapshot')).stdout).result.snapshot;
  const foreground = async pane => JSON.parse((await control('pane', 'process-info', '--pane', pane)).stdout)
    .result.process_info.foreground_processes ?? [];
  async function waitForPaneProcess(pane, label, matches) {
    // Pinned Herdr publishes the restored topology before it allocates the
    // deferred pane PTY. process-info calls that case pane_not_found too.
    assert.equal((await readPane(pane)).pane_id, pane, 'the original pane must exist in the restored topology');
    return pty.until(label, async () => {
      try { return (await foreground(pane)).some(matches); }
      catch (error) {
        let code;
        try { code = JSON.parse(error.stderr)?.error?.code; } catch { /* Not a Herdr API rejection. */ }
        if (code !== 'pane_not_found') throw error;
        assert.equal((await readPane(pane)).pane_id, pane, 'the original pane must remain in the restored topology');
        return false;
      }
    });
  }
  const readyPane = () => pty.until('Herdr topology ready', async () => existsSync(bootDone) && (await snapshot()).focused_pane_id);
  const waiting = pane => waitForPaneProcess(pane, 'managed wrapper is live in the correct Herdr pane',
    ({ argv }) => argv?.some(arg => basename(arg) === basename(writer)));
  const stopHerdr = () => run(launcher, ['stop'], { cwd, env, timeout: 7000 });
  async function stopRuntime() {
    // Match Host Session.kill(): let the named server save its live panes
    // before tearing down the attached client PTY.
    if (mode === 'herdr') await stopHerdr();
    await pty.stop();
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

  let binding, leaf, saved, inode, host;
  const claimPath = ticket => join(runtimeDir, 'terminal-tickets', String(generation), ticket);
  // Match the launcher's exclusive claim before it forks a native writer.
  const claim = (ticket, pid) => writeFileSync(claimPath(ticket), `${pid}\n`, { flag: 'wx', mode: 0o600 });
  async function registerHeldReentry(pane, retiredTicket, pid) {
    // Controlled private-protocol fixture: the registered process is alive
    // but does not claim the ticket, like a wrapper held before its next poll.
    const stat = read(`/proc/${pid}/stat`);
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const path = join(runtimeDir, 'wrapper.json');
    writeFileSync(`${path}.next`, JSON.stringify({ generation, pid, startTime, pane, rearmTicket: retiredTicket }));
    renameSync(`${path}.next`, path);
    const interrupted = await pty.until('Host publishes a grant while the registered wrapper is held', () => {
      const owner = json(ownerPath);
      return owner.phase === 'opening' && owner.terminalTicket !== retiredTicket && owner;
    });
    assert.equal(existsSync(claimPath(interrupted.terminalTicket)), false);
    return interrupted.terminalTicket;
  }
  async function openExact(pane, host) {
    const grant = host ? json(ownerPath) : { surface: null, phase: 'opening', target: 'terminal', requestId: randomUUID(),
      terminalTicket: randomUUID(), binding };
    if (!host) publish(grant);
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
    let oldShellSnapshot;
    if (pane) {
      await waiting(pane);
      await pty.until('fresh parked wrapper is saved before any native ticket', () => countSavedRoles() === 1);
      oldShellSnapshot = { data: read(sessionFile), mtime: statSync(sessionFile).mtime };
    } else await pty.until('Classic prewarm PTY emitted its startup byte', () => pty.output().includes('\r'));
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
    if (mode === 'herdr') {
      const bindingDir = join(home, '.codeflare/herdr/sessions', name);
      mkdirSync(bindingDir, { recursive: true });
      writeFileSync(join(bindingDir, 'agent-session-id'), `${binding.id}\n`);
      host = createPiWebRuntime({ sessionId, generation, initialSurface: 'terminal', terminalMode: 'herdr',
        cwd, home, runtimeDir, profileRestored: () => true, cloneRestored: () => existsSync(bootDone) });
      await host.initialize();
    }
    const { grant, native } = await openExact(pane, host);

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
      const bindingDir = join(home, '.codeflare/classic/sessions', name);
      mkdirSync(bindingDir, { recursive: true });
      writeFileSync(join(bindingDir, 'agent-session-id'), `${binding.id}\n`);
      host = createPiWebRuntime({ sessionId, generation, initialSurface: 'terminal', terminalMode: 'classic',
        cwd, home, runtimeDir, profileRestored: () => true, cloneRestored: () => true });
      await host.initialize();
      const reopened = await openExact(pane, host);
      assert.notEqual(reopened.native.instance, native.instance);
      pty.write('\x04'); // Native Ctrl+D on the empty editor, not a switch command.
      await pty.until('ordinary Pi quit leaves the same Classic PTY usable', () => {
        const end = json(reportPath);
        return end.instance === reopened.native.instance && end.quit && !alive(reopened.native);
      });
      const shellProbe = join(home, 'shell-cwd');
      pty.write(`printf '%s\\n' "$PWD" > '${shellProbe}'\r`);
      await pty.until('Classic shell executes a command after ordinary Pi quit', () =>
        existsSync(shellProbe) && read(shellProbe).trim() === cwd);
      assert.equal(host.status().surface, 'terminal');
      assert.equal(json(ownerPath).terminalTicket, reopened.grant.terminalTicket, 'observing status does not relaunch Pi');
      const held = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      const exited = new Promise(resolve => held.once('close', resolve));
      let revoked;
      try { revoked = await registerHeldReentry('classic', reopened.grant.terminalTicket, held.pid); }
      finally { held.kill(); await exited; }
      await pty.until('interrupted unclaimed re-entry leaves Terminal selected', () =>
        host.status().phase === 'active' && host.status().surface === 'terminal', 25_000);
      assert.equal(json(reportPath).instance, reopened.native.instance, 'no writer started during the interruption');
      assert.throws(() => claim(revoked, process.pid), { code: 'EEXIST' }, 'a delayed claimant cannot use the revoked grant');
      pty.write('codeflare-terminal-writer\r');
      await pty.until('explicit wrapper re-entry earns a fresh one-use ticket', () =>
        json(ownerPath).terminalTicket !== reopened.grant.terminalTicket);
      const restarted = await openExact(pane, host);
      assert.notEqual(restarted.grant.terminalTicket, revoked, 'the previous grant cannot be reused');
      assert.notEqual(restarted.native.instance, reopened.native.instance);
      await pty.until('ordinary re-entry confirms Terminal without acquiring Chat', () =>
        host.status().phase === 'complete' && host.status().surface === 'terminal' && !host.status().chatUrl);
      const wrapper = json(join(runtimeDir, 'wrapper.json'));
      pty.write('\x04');
      await pty.until('normal quit removes the writer and its wrapper before another registration', () => {
        const end = json(reportPath);
        return end.instance === restarted.native.instance && end.quit && !alive(restarted.native) && !alive(wrapper);
      });
      const claimed = await registerHeldReentry('classic', restarted.grant.terminalTicket, process.pid);
      claim(claimed, process.pid); // The claim wins, but no writer receipt follows.
      const uncertain = await pty.until('a claimed grant without a writer receipt stays unconfirmed', () => {
        const state = host.status();
        return state.phase === 'uncertain' && state;
      }, 25_000);
      await assert.rejects(host.handoff.switchTo({ generation, target: 'chat', requestId: randomUUID() }));
      const retry = await host.handoff.switchTo({ generation, target: 'terminal', requestId: uncertain.requestId });
      assert.equal(retry.phase, 'uncertain');
      assert.equal(json(ownerPath).terminalTicket, claimed, 'no replacement grant can be issued');
      assert.equal(read(claimPath(claimed)), `${process.pid}\n`, 'Host never overwrites a claimant’s receipt');
      assert.equal(json(reportPath).instance, restarted.native.instance);
      // This claimed ticket has no writer receipt, so normal Stop must fail closed.
      const retirement = host.close();
      host = undefined;
      await assert.rejects(retirement, { message: 'Could not retire the unconfirmed Pi writer' });
      console.log('PI_WEB_CLASSIC_LAUNCHER_OK');
      return;
    }

    // Move focus away from the managed primary before saving. A restore that
    // injects into the focused shell instead of restoring the role cannot pass.
    await control('pane', 'split', pane, '--direction', 'right', '--focus', '--cwd', cwd);
    const secondary = (await snapshot()).focused_pane_id;
    assert.ok(secondary && secondary !== pane);
    console.log('PI_WEB_HERDR_FRESH_LAUNCHER_OK');
    const legacy = await pty.until('Herdr saves the exact native session reference before retirement', () => {
      if (!existsSync(sessionFile)) return false;
      const saved = json(sessionFile);
      return savedPrimary(saved).length === 1 && saved;
    }, 8000);
    const stopping = host.close();
    void stopping.catch(() => {});
    try {
      await pty.until('the exact native writer releases and exits', () => {
        const retired = json(reportPath);
        return retired.instance === native.instance && retired.released === true && !alive(native);
      });
      await stopping;
      await pty.until('the saved role belongs to the parked wrapper in the original pane', () => parkedOnOriginalPane(pane));
    } catch (error) {
      throw new Error(`Herdr Stop parked-role evidence: ${JSON.stringify(await parkEvidence(pane, native))}`, { cause: error });
    }
    assert.equal(host.status().chatUrl, undefined, 'normal Stop must not open Chat');
    assert.equal(countSavedRoles(), 1, 'the parked wrapper role must be saved before named Stop');
    await stopRuntime();
    assert.equal(countSavedRoles(), 1, 'named Stop must preserve the exact managed resume command');

    boot();
    assert.equal(await readyPane(), secondary, 'restored focus must remain on the other pane');
    assert.equal(existsSync(join(runtimeDir, 'legacy-herdr')), false, 'the saved managed role must not be classified as legacy');
    await waiting(pane);
    await noTicket(pane);
    const restored = await openExact(pane);
    assert.notEqual(restored.native.instance, native.instance);
    const requestId = randomUUID();
    publish({ ...restored.grant, surface: 'terminal', phase: 'releasing', target: 'chat', requestId });
    try {
      await pty.until('restored native writer releases and exits', () => {
        const retired = json(reportPath);
        return retired.instance === restored.native.instance && retired.releaseReady === requestId
          && retired.released === true && !alive(restored.native);
      });
      await pty.until('restored Herdr retains the managed role after writer exit', async () =>
        countSavedRoles() === 1 && await parkedOnOriginalPane(pane), 20_000);
    } catch (error) {
      throw new Error(`Herdr repark evidence: ${JSON.stringify(await parkEvidence(pane, restored.native, requestId))}`, { cause: error });
    }
    const parkedWrapper = json(join(runtimeDir, 'wrapper.json'));
    await control('pane', 'send-keys', pane, 'ctrl+c');
    await pty.until('parked launcher returns to its original shell', () => !alive(parkedWrapper));
    // Queue real re-entry in the pane's shell so it runs as soon as the
    // retiring wrapper returns, without waiting for the park receipt.
    const nativeCommand = 'codeflare-terminal-writer --tui-mode fullscreen';
    await control('pane', 'run', pane, `${nativeCommand}; ${nativeCommand}`);
    publish({ surface: 'terminal', phase: 'active', terminalTicket: 'initial', binding });
    const beforeStop = await openExact(pane, true);
    const oldWrapper = json(join(runtimeDir, 'wrapper.json'));
    await control('pane', 'send-keys', pane, 'ctrl+d');
    const parkedReceipt = join(runtimeDir, 'herdr-parked.json');
    let freshWrapper;
    try {
      freshWrapper = await pty.until('immediate re-entry waits in the original pane without blocking the current park', async () => {
        const end = json(reportPath);
        const wrapper = json(join(runtimeDir, 'wrapper.json'));
        const parked = await readPane(pane);
        const saved = savedPane(json(sessionFile), pane);
        return end.instance === beforeStop.native.instance && end.quit && !alive(beforeStop.native) && !alive(oldWrapper)
          && wrapper.rearmTicket === beforeStop.grant.terminalTicket && wrapper.pane === pane && alive(wrapper)
          && parked.pane_id === pane && parked.agent === 'codeflare-terminal-writer' && !parked.agent_session
          && existsSync(parkedReceipt) && json(parkedReceipt).instance === beforeStop.native.instance
          && statSync(sessionFile).mtimeMs >= statSync(reportPath).mtimeMs
          && saved && hasManagedRole(saved) && saved.agent_session == null && wrapper;
      }, 22_000);
    } catch (error) {
      throw new Error(`Herdr quit park evidence: ${JSON.stringify(await parkEvidence(pane, beforeStop.native))}`, { cause: error });
    }
    const currentSnapshot = read(sessionFile);
    const wrongPaneSnapshot = JSON.parse(currentSnapshot);
    const original = savedPane(wrongPaneSnapshot, pane);
    savedPane(wrongPaneSnapshot, secondary).agent_resume = original.agent_resume;
    delete original.agent_resume;
    renameSync(parkedReceipt, `${parkedReceipt}.held`);
    let pending, closing, initialized;
    // Hold the real same-pane re-entry before it can consume the new grant.
    process.kill(freshWrapper.pid, 'SIGSTOP');
    try {
      host = createPiWebRuntime({ sessionId, generation, initialSurface: 'terminal', terminalMode: 'herdr',
        cwd, home, runtimeDir, profileRestored: () => true, cloneRestored: () => existsSync(bootDone) });
      initialized = host.initialize();
      void initialized.catch(() => {});
      pending = await pty.until('the held re-entry receives a new grant', () => {
        const owner = json(ownerPath);
        return owner.phase === 'opening' && owner.terminalTicket !== beforeStop.grant.terminalTicket && owner.terminalTicket;
      });
      assert.equal(existsSync(claimPath(pending)), false);
      closing = host.close();
      void closing.catch(() => {});
      const assertPending = async label => assert.equal(await Promise.race([closing.then(() => true), delay(400, false)]), false, label);
      await pty.until('Stop fences the unused grant before waiting for current park evidence', () => existsSync(claimPath(pending)));
      await assertPending('a fresh snapshot cannot satisfy Stop without the current quit receipt');
      writeFileSync(sessionFile, oldShellSnapshot.data);
      utimesSync(sessionFile, oldShellSnapshot.mtime, oldShellSnapshot.mtime);
      assert.ok(statSync(sessionFile).mtimeMs < statSync(reportPath).mtimeMs);
      renameSync(`${parkedReceipt}.held`, parkedReceipt);
      await assertPending('a current quit receipt cannot make a pre-quit snapshot fresh');
      writeFileSync(sessionFile, JSON.stringify(wrongPaneSnapshot));
      await assertPending('a fresh snapshot cannot satisfy Stop with the role in the wrong pane');
    } finally {
      if (existsSync(`${parkedReceipt}.held`)) renameSync(`${parkedReceipt}.held`, parkedReceipt);
      writeFileSync(sessionFile, currentSnapshot);
      if (alive(freshWrapper)) process.kill(freshWrapper.pid, 'SIGCONT');
    }
    await Promise.all([closing, initialized]);
    assert.throws(() => claim(pending, process.pid), { code: 'EEXIST' }, 'Stop fences the revoked grant against a late claim');
    assert.equal(json(reportPath).instance, beforeStop.native.instance, 'Stop must not start a pending re-entry');
    assert.equal(host.status().chatUrl, undefined, 'Stop must not open the alternate writer');
    await stopRuntime();
    assert.equal(countSavedRoles(), 1, 'Stop during re-entry preserves the unique saved role');
    assert.ok(hasManagedRole(savedPane(json(sessionFile), pane)), 'named Stop preserves the role in the original pane');
    console.log('PI_WEB_HERDR_MANAGED_RESTORE_OK');

    // Feed a genuine saved native session without the newer wrapper role to
    // exercise the legacy launch path separately.
    for (const entry of savedPanes(legacy)) delete entry.agent_resume;
    writeFileSync(sessionFile, JSON.stringify(legacy));
    boot();
    await readyPane();
    await waitForPaneProcess(pane, 'legacy Herdr runs native Pi in the original pane', isPi);
    await pty.until('live native Pi registers the exact legacy transcript', async () => {
      const { agents } = await snapshot();
      return agents.some(agent => agent.pane_id === pane && agent.agent === 'pi'
        && agent.screen_detection_skipped === true && sameNativeRegistration(agent.agent_session));
    });
    assert.equal(existsSync(reportPath), false, 'legacy Pi is not a ticket-managed writer');
    const runtime = createPiWebRuntime({ sessionId, generation, initialSurface: 'chat', terminalMode: 'herdr',
      cwd, home, runtimeDir, profileRestored: () => true, cloneRestored: () => existsSync(bootDone) });
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
    try {
      if (mode === 'classic') await host?.close();
    } finally {
      if (pty) {
        await pty.stop();
        if (mode === 'herdr') await stopHerdr().catch(error => console.error(`Herdr cleanup: ${error.message}`));
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
}

const mode = process.argv[2];
if (mode !== 'classic' && mode !== 'herdr') throw new Error('Select a launcher mode: classic or herdr');
await qualify(mode);
