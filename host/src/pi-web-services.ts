import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

const installRoot = '/opt/codeflare/pi-web';
const dist = `${installRoot}/node_modules/@jmfederico/pi-web/dist`;
const workflows = `${dist}/pi-packages/workflows`;
const mcpManager = `${dist}/pi-packages/mcp-manager`;
const extension = `${installRoot}/handoff-extension.ts`;
export const PI_WEB_PORT = 8504;
const origin = `http://127.0.0.1:${PI_WEB_PORT}`;

export function managedPiPackage(): string {
  const piPath = realpathSync('/usr/local/bin/pi');
  const piPackage = dirname(dirname(dirname(piPath)));
  if (piPath !== join(piPackage, 'dist/bundle/cli.js') || !existsSync(join(piPackage, 'dist/index.js'))) {
    throw new Error('Managed Pi SDK is unavailable');
  }
  return piPackage;
}

export interface PiWebServices {
  start(): Promise<void>;
  running(): boolean;
  request<T>(path: string, body?: object): Promise<T>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Host-supervised stock processes; never expose their private API or socket directly. */
export function createPiWebServices(options: { runtimeDir: string; cwd: string; profileRestored: () => boolean }): PiWebServices {
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
    child.on('error', () => { /* An error is not exit; close also follows failed spawn. */ });
    child.once('close', () => { state.running = false; resolve(); });
    processes.push(state);
  }

  async function stopProcesses(): Promise<void> {
    const retiring = processes;
    for (const { child, running } of retiring) if (running) child.kill('SIGTERM');
    const joined = Promise.all(retiring.map(({ stopped }) => stopped));
    if (!await Promise.race([joined.then(() => true), sleep(4000, false, { ref: false })])) {
      for (const { child, running } of retiring) if (running) child.kill('SIGKILL');
      if (!await Promise.race([joined.then(() => true), sleep(4000, false, { ref: false })])) {
        throw new Error('Stock pi-web process exit is unconfirmed');
      }
    }
    if (processes === retiring) processes = [];
  }

  async function boot(): Promise<void> {
    await until(options.profileRestored, 120_000);
    if (shuttingDown) throw new Error('Container is stopping');
    const piPackage = managedPiPackage();
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
    const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: unknown[]; extensions?: unknown[] };
    const settings = existsSync(settingsPath) ? readSettings() : {};
    const before = Array.isArray(settings.packages) ? settings.packages : [];
    const sourceOf = (item: unknown) => typeof item === 'object' && item !== null && 'source' in item ? item.source : item;
    const workflowsRegistered = before.some(item => sourceOf(item) === workflows);
    // These exact companion exclusions do not disable either MCP client.
    const managedExclusions = ['-builtin:mcp', ...['review-enforcement.ts', 'operator-review-remote.ts',
      'mcp-portal-oauth.ts', 'hermes-memory-runtime.ts'].flatMap(name => {
      const relative = `extensions/${name}`;
      return [`-${join(agentDir, relative)}`, `-${relative}`, `-./${relative}`];
    })];
    const adapterSelected = Array.isArray(settings.extensions) && settings.extensions.includes('-builtin:mcp')
      && settings.extensions.every(item => typeof item === 'string' && managedExclusions.includes(item))
      && before.every(item => typeof sourceOf(item) === 'string')
      && before.some(item => typeof item === 'string' && (
        /^npm:pi-mcp-adapter@\d+\.\d+\.\d+$/.test(item) || item === join(piPackage, '..', '..', 'pi-mcp-adapter')));
    const defaultsPath = join(options.runtimeDir, 'defaults.json');
    writeFileSync(defaultsPath, JSON.stringify({
      installationName: 'Codeflare',
      quietMode: true,
      defaultTheme: { themeId: 'themes:classic', auto: false },
    }), { mode: 0o600 });
    const dataDir = join(options.runtimeDir, 'data');
    const pluginDir = join(dataDir, 'plugins');
    const chromePlugin = join(installRoot, 'codeflare-chrome');
    const chromeLink = join(pluginDir, 'codeflare-chrome');
    mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    try { symlinkSync(chromePlugin, chromeLink); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(chromeLink).isSymbolicLink()
        || readlinkSync(chromeLink) !== chromePlugin) throw error;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEFLARE_PI_WEB_DAEMON: '1', PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PI_PACKAGE_DIR: piPackage, PI_WEB_RUNTIME: 'node', PI_WEB_HOST: '127.0.0.1', PI_WEB_PORT: String(PI_WEB_PORT),
      PI_WEB_HOST_ACCESS: '{"mode":"any"}', PI_WEB_DATA_DIR: dataDir,
      PI_WEB_SESSIOND_SOCKET: join(options.runtimeDir, 'daemon.sock'), PI_WEB_SKIP_VERSION_CHECK: '1',
      PI_WEB_SPAWN_SESSIONS: 'false', PI_WEB_DEFAULTS_CONFIG: defaultsPath,
      PI_WEB_PLUGINS: JSON.stringify({
        git: { enabled: false },
        info: { enabled: false },
        updates: { enabled: false },
        'mcp-manager': { enabled: false },
        'workspace-tasks': { enabled: false },
        relays: { enabled: false },
      }),
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
    const userSources = new Set(packages.packages.filter(row => row.scope === 'user').map(row => row.source));
    if (userSources.has(workflows)) {
      if (workflowsRegistered) throw new Error('Existing Workflows registration prevents Git-free Chat');
      const removed = await request<{ removed: boolean }>('/api/pi-packages/remove', { scope: 'user', source: workflows });
      if (!removed.removed) throw new Error('Bundled Workflows could not be dismissed');
    }
    // Disabling the panel doesn't disable the bundled Pi extension. Dismiss
    // only the newly provisioned source when the managed adapter is registered.
    if (adapterSelected && !before.some(item => sourceOf(item) === mcpManager) && userSources.has(mcpManager)) {
      const after = readSettings();
      // Stock can normalize any configured copy to the bundled path. If any
      // prior entry (including filters) changed, absence before boot is not proof.
      const remaining = Array.isArray(after.packages) ? after.packages.filter(item => sourceOf(item) !== mcpManager) : [];
      const preserved = before.every(item => {
        const index = remaining.findIndex(candidate => isDeepStrictEqual(candidate, item));
        if (index === -1) return false;
        remaining.splice(index, 1);
        return true;
      });
      if (preserved && isDeepStrictEqual(after.extensions, settings.extensions)) {
        const removed = await request<{ removed: boolean }>('/api/pi-packages/remove', { scope: 'user', source: mcpManager });
        if (!removed.removed) throw new Error('Bundled MCP Manager could not be dismissed');
      }
    }
  }

  return {
    request,
    running: () => processes.length === 2 && processes.every(process => process.running),
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
    async reset() {
      await stopProcesses();
      starting = undefined;
    },
    close() {
      shuttingDown = true;
      closing ??= stopProcesses();
      return closing;
    },
  };
}
