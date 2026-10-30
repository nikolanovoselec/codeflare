// Managed-primary configuration/identity glue; never installed in user settings,
// managed extensions, IDEs or SDK resource lists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

/** Public Dashboard configuration only. The managed launcher calls this BEFORE
 * starting Pi, so even module-load config readers see autoStart:false. The Host
 * still starts the private transport; no HOME, Pi setting or lifecycle changes.
 */
export function preparePrimaryDashboard(home = os.homedir()) {
  let temporary;
  try {
    const agentRoot = path.join(home, '.pi');
    const directory = path.join(agentRoot, 'dashboard');
    for (const dir of [agentRoot, directory]) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unsafe configuration directory');
    }
    const file = path.join(directory, 'config.json');
    let config = {};
    let mode = 0o600;
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (descriptor !== undefined) {
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Unsafe configuration file');
        mode = stat.mode & 0o600;
        config = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration object');
        if (config.autoStart === false) {
          if ((stat.mode & 0o777) !== mode) fs.fchmodSync(descriptor, mode);
          return;
        }
      } finally { fs.closeSync(descriptor); }
    }
    // Atomic replacement retains restrictive owner permissions and never
    // truncates an existing document if parsing or writing fails.
    temporary = fs.mkdtempSync(path.join(directory, '.codeflare-'));
    const pending = path.join(temporary, 'config.json');
    fs.writeFileSync(pending, `${JSON.stringify({ ...config, autoStart: false }, null, 2)}\n`, { mode, flag: 'wx' });
    fs.renameSync(pending, file);
  } catch {
    // JSON parser/I/O errors can contain document values or private paths.
    throw new Error('Codeflare: private Chat startup configuration could not be prepared');
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const ownsProcess = env => /^\d+$/.test(env.CODEFLARE_CHAT_PRIMARY_PID ?? '')
  && Number(env.CODEFLARE_CHAT_PRIMARY_PID) === process.pid;

/** Activate the stock PUBLIC extension factory with process-local configuration.
 * The stock factory synchronously captures its endpoint/config. Restore the env
 * before any child can start; inherited CLI resources also fail the PID guard.
 * This is not a gateway bootstrap or a replacement transport.
 */
export function activatePrimaryBridge(pi, stockFactory, env = process.env) {
  if (!ownsProcess(env) || !env.CODEFLARE_CHAT_SOCKET) return;
  const prior = { socket: env.PI_DASHBOARD_SOCKET, bridge: env.PI_DASHBOARD_BRIDGE };
  try {
    env.PI_DASHBOARD_SOCKET = env.CODEFLARE_CHAT_SOCKET;
    env.PI_DASHBOARD_BRIDGE = 'on';
    stockFactory(pi);
  } finally {
    if (prior.socket === undefined) delete env.PI_DASHBOARD_SOCKET; else env.PI_DASHBOARD_SOCKET = prior.socket;
    if (prior.bridge === undefined) delete env.PI_DASHBOARD_BRIDGE; else env.PI_DASHBOARD_BRIDGE = prior.bridge;
  }
}

export default function primaryIdentity(pi, env = process.env) {
  if (!ownsProcess(env)) return;
  const file = env.CODEFLARE_CHAT_IDENTITY_FILE;
  const generation = Number(env.CODEFLARE_CHAT_GENERATION);
  if (!file?.startsWith('/') || !/^(0|[1-9][0-9]{0,15})$/.test(env.CODEFLARE_CHAT_GENERATION ?? '')
    || !Number.isSafeInteger(generation)) return;
  let activeSessionId;
  // Herdr's documented report-agent-session -- <resume-command...> persists
  // native resume argv. Its stock Pi integration still owns status/reporting;
  // retain its official source and actual session, adding ONLY scoped activation.
  const reportResume = async ctx => {
    if (ctx.mode !== 'tui' || env.HERDR_ENV !== '1' || !env.HERDR_BIN_PATH || !env.HERDR_PANE_ID) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return;
    try {
      await execute(env.HERDR_BIN_PATH, ['pane', 'report-agent-session', env.HERDR_PANE_ID,
        '--source', 'herdr:pi', '--agent', 'pi', '--agent-session-id', sessionId,
        '--', 'codeflare-primary-pi', '--tui-mode', 'fullscreen', '--session-id', sessionId],
      { timeout: 5000, maxBuffer: 64 * 1024 });
    } catch { console.error('Codeflare: primary Herdr resume activation could not be recorded'); }
  };
  // Public Pi lifecycle API: the same getSessionId used by the stock bridge's
  // session_register. No cwd/name/most-recent registration inference.
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return;
    const paneId = /^[A-Za-z0-9._:-]{1,128}$/.test(env.HERDR_PANE_ID ?? '') ? env.HERDR_PANE_ID : undefined;
    const temporary = `${file}.${process.pid}.tmp`;
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    fs.writeFileSync(temporary, JSON.stringify({ sessionId, generation, pid: process.pid, startTime, ...(paneId ? { paneId } : {}) }), { mode: 0o600 });
    fs.renameSync(temporary, file);
    activeSessionId = sessionId;
    await reportResume(ctx);
  });
  pi.on('agent_start', async (_event, ctx) => { await reportResume(ctx); });
  pi.on('session_shutdown', () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (activeSessionId && current.pid === process.pid && current.sessionId === activeSessionId) fs.unlinkSync(file);
      activeSessionId = undefined;
    } catch { /* exit/reload can converge; identity reads fail closed */ }
  });
}
