import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const installRoot = '/opt/codeflare/pi-web';
const dist = `${installRoot}/node_modules/@jmfederico/pi-web/dist`;
const workflows = `${dist}/pi-packages/workflows`;
const extension = `${installRoot}/handoff-extension.ts`;
export const PI_WEB_PORT = 8504;
const origin = `http://127.0.0.1:${PI_WEB_PORT}`;

export interface PiWebServices {
  start(): Promise<void>;
  request<T>(path: string, body?: object): Promise<T>;
  close(): Promise<void>;
}

/** Host-supervised stock processes; never expose their private API or socket directly. */
export function createPiWebServices(options: { runtimeDir: string; cwd: string; cloneRestored: () => boolean }): PiWebServices {
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let processes: Array<{ child: ChildProcess; stopped: Promise<void>; running: boolean }> = [];
  let shuttingDown = false;

  async function request<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      ...(body !== undefined && { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Stock pi-web private API returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!shuttingDown && Date.now() < end) {
      if (await check()) return;
      await sleep(200);
    }
    throw new Error('Stock pi-web startup did not settle');
  }

  function launch(name: string, env: NodeJS.ProcessEnv): void {
    const child = spawn(`${dist}/bin/${name}`, [], { env, cwd: options.cwd, stdio: 'ignore' });
    let resolve!: () => void;
    const state = { child, running: true, stopped: new Promise<void>(done => { resolve = done; }) };
    const done = () => { state.running = false; resolve(); };
    child.once('error', done);
    child.once('close', done);
    processes.push(state);
  }

  async function stopProcesses(): Promise<void> {
    const retiring = processes;
    for (const { child, running } of retiring) if (running) child.kill('SIGTERM');
    const joined = Promise.all(retiring.map(({ stopped }) => stopped));
    if (!await Promise.race([joined.then(() => true), sleep(4000, false, { ref: false })])) {
      for (const { child, running } of retiring) if (running) child.kill('SIGKILL');
      await joined;
    }
    if (processes === retiring) processes = [];
  }

  async function boot(): Promise<void> {
    await until(options.cloneRestored, 120_000);
    if (shuttingDown) throw new Error('Container is stopping');
    const piPath = realpathSync('/usr/local/bin/pi');
    const piPackage = dirname(dirname(dirname(piPath)));
    if (piPath !== join(piPackage, 'dist/bundle/cli.js') || !existsSync(join(piPackage, 'dist/index.js'))) {
      throw new Error('Managed Pi SDK is unavailable');
    }
    const home = process.env.HOME ?? '/home/user';
    const agentDir = join(home, '.pi/agent');
    const extensionLink = join(agentDir, 'extensions/codeflare-web-handoff.ts');
    mkdirSync(dirname(extensionLink), { recursive: true });
    try { symlinkSync(extension, extensionLink); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(extensionLink).isSymbolicLink()
        || readlinkSync(extensionLink) !== extension) throw error;
    }
    const settingsPath = join(agentDir, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: unknown } : {};
    // Do not remove this package by name or touch an unrelated user source.
    const alreadyRegistered = Array.isArray(settings.packages) && settings.packages.some((item: unknown) =>
      item === workflows || (typeof item === 'object' && item !== null && 'source' in item && item.source === workflows));
    const defaultsPath = join(options.runtimeDir, 'defaults.json');
    writeFileSync(defaultsPath, '{"quietMode":true}\n', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEFLARE_PI_WEB_DAEMON: '1', PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PI_PACKAGE_DIR: piPackage, PI_WEB_RUNTIME: 'node', PI_WEB_HOST: '127.0.0.1', PI_WEB_PORT: String(PI_WEB_PORT),
      PI_WEB_HOST_ACCESS: '{"mode":"any"}', PI_WEB_DATA_DIR: join(options.runtimeDir, 'data'),
      PI_WEB_SESSIOND_SOCKET: join(options.runtimeDir, 'daemon.sock'), PI_WEB_SKIP_VERSION_CHECK: '1',
      PI_WEB_SPAWN_SESSIONS: 'false', PI_WEB_DEFAULTS_CONFIG: defaultsPath, PI_WEB_PLUGINS: '{"git":{"enabled":false}}',
    };
    // No private container credential or parent authority in agent child env.
    delete env.CONTAINER_AUTH_TOKEN;
    launch('pi-web-sessiond.sh', env);
    launch('pi-web-server.sh', env);
    await until(async () => {
      if (processes.some(process => !process.running)) throw new Error('Stock pi-web process exited');
      try { return (await request<{ ok: boolean }>('/api/sessiond/health')).ok; }
      catch { return false; }
    }, 30_000);
    const packages = await request<{ packages: { source: string; scope: string }[] }>('/api/pi-packages');
    if (packages.packages.some(row => row.scope === 'user' && row.source === workflows)) {
      if (alreadyRegistered) throw new Error('Existing Workflows registration prevents Git-free Chat');
      const removed = await request<{ removed: boolean }>('/api/pi-packages/remove', { scope: 'user', source: workflows });
      if (!removed.removed) throw new Error('Bundled Workflows could not be dismissed');
    }
  }

  return {
    request,
    async start() {
      if (shuttingDown) throw new Error('Container is stopping');
      if (starting && processes.some(process => !process.running)) {
        await starting.catch(() => {});
        await stopProcesses();
        starting = undefined;
      }
      starting ??= boot().catch(async (error: unknown) => {
        await stopProcesses();
        starting = undefined;
        throw error;
      });
      return starting;
    },
    close() {
      shuttingDown = true;
      closing ??= stopProcesses();
      return closing;
    },
  };
}
