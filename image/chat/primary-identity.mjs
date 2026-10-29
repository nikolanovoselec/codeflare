// Process/identity glue only. Loaded explicitly for Codeflare's configured primary;
// never installed in user settings, managed extensions, IDEs or SDK resource lists.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

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
