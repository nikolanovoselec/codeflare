import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

const installRoot = '/opt/codeflare/pi-web';
const dist = `${installRoot}/node_modules/@jmfederico/pi-web/dist`;
const workflows = `${dist}/pi-packages/workflows`;
const mcpManager = `${dist}/pi-packages/mcp-manager`;
const extension = `${installRoot}/handoff-extension.ts`;
export const PI_WEB_PORT = 8504;
export const PI_WEB_ATTACHMENT_BODY_LIMIT = 65 * 1024 * 1024; // 50 MB decoded plus base64 and bounded JSON.
const origin = `http://127.0.0.1:${PI_WEB_PORT}`;

const bootErrnos = new Set(['EACCES', 'EADDRINUSE', 'EEXIST', 'EISDIR', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS']);
const bootSignals = new Set(['SIGABRT', 'SIGILL', 'SIGKILL', 'SIGSEGV', 'SIGTERM']);

class StockBootCancelled extends Error {}

class StockApiError extends Error {
  constructor(readonly status: number) {
    super(`Stock pi-web private API returned ${status}`);
  }
}

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
export function createPiWebServices(options: {
  runtimeDir: string; cwd: string; profileRestored: () => boolean;
  observeBuildStderr?: (launcher: string, stderr: Readable) => void;
}): PiWebServices {
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let processes: Array<{ child: ChildProcess; role: string; spawnErrno?: string; stopped: Promise<void>; running: boolean }> = [];
  let shuttingDown = false;
  const bootShutdown = new AbortController();

  async function request<T>(path: string, body?: object, startupSignal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(15_000);
    const signal = startupSignal ? AbortSignal.any([startupSignal, timeout]) : timeout;
    const response = await fetch(`${origin}${path}`, {
      signal,
      redirect: 'error',
      ...(body !== undefined && { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }),
    });
    const wasShutdownAbort = (error: unknown) => signal.reason instanceof StockBootCancelled
      && (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'));
    if (!response.ok) {
      try { await response.body?.cancel(); }
      catch (error) { if (!wasShutdownAbort(error)) throw error; }
      throw new StockApiError(response.status);
    }
    try { return await response.json() as T; }
    catch (error) { throw wasShutdownAbort(error) ? signal.reason : error; }
  }

  async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!shuttingDown && Date.now() < end) {
      if (await check()) return;
      await sleep(200);
    }
    if (shuttingDown) throw new StockBootCancelled('Stock pi-web startup did not settle');
    throw new Error('Stock pi-web startup did not settle');
  }

  function launch(name: string, env: NodeJS.ProcessEnv, isListenMarker: (line: string) => boolean, onListen: () => void): void {
    const child = spawn(`${dist}/bin/${name}`, [], {
      env, cwd: options.cwd, stdio: ['ignore', 'pipe', options.observeBuildStderr ? 'pipe' : 'ignore'],
    });
    if (child.stderr) options.observeBuildStderr?.(name, child.stderr);
    // Never forward child output. Retain only a bounded partial line until the
    // first matching stock marker, then drain without inspecting further output.
    const stdout = child.stdout;
    let partial: string | undefined = '';
    const observe = (chunk: string) => {
      const lines = chunk.split('\n');
      const last = lines.pop()!;
      for (const line of lines) {
        if (partial !== undefined && partial.length + line.length <= 4096 && isListenMarker(partial + line)) {
          stdout?.off('data', observe);
          stdout?.resume();
          onListen();
          return;
        }
        partial = '';
      }
      partial = partial !== undefined && partial.length + last.length <= 4096 ? partial + last : undefined;
    };
    stdout?.setEncoding('utf8').on('data', observe);
    let resolve!: () => void;
    const state: (typeof processes)[number] = { child, role: name === 'pi-web-sessiond.sh' ? 'sessiond' : 'gateway',
      running: true, stopped: new Promise<void>(done => { resolve = done; }) };
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code && bootErrnos.has(error.code)) state.spawnErrno = error.code;
    });
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

  async function boot(diagnostic: { operation: string; healthHttpStatus?: number }): Promise<void> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const mark = (operation: string) => { diagnostic.operation = operation; };
    const bootRequest = <T>(path: string, body?: object) => request<T>(path, body, bootShutdown.signal);
    mark('profile-restore');
    await until(options.profileRestored, 120_000);
    if (shuttingDown) throw new StockBootCancelled('Container is stopping');
    // The stock daemon provisions packages before the gateway becomes healthy.
    // Reject a known port conflict before that startup can modify the profile.
    mark('port-probe');
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(PI_WEB_PORT, '127.0.0.1', () => {
        probe.close(error => error ? reject(error) : resolve());
      });
    });
    if (shuttingDown) throw new StockBootCancelled('Container is stopping');
    mark('sdk-check');
    const piPackage = managedPiPackage();
    mark('profile-settings');
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
    mark('runtime-config');
    mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 });
    const defaultsPath = join(options.runtimeDir, 'defaults.json');
    writeFileSync(defaultsPath, JSON.stringify({
      installationName: 'Codeflare',
      quietMode: true,
      defaultTheme: { themeId: 'codeflare-chrome:graphite', auto: false },
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
      PI_WEB_SPAWN_SESSIONS: 'false', PI_WEB_MAX_UPLOAD_BYTES: String(PI_WEB_ATTACHMENT_BODY_LIMIT), PI_WEB_DEFAULTS_CONFIG: defaultsPath,
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
    let gatewayListenMs: number | null = null;
    let sessiondListenMs: number | null = null;
    mark('sessiond-launch');
    launch('pi-web-sessiond.sh', env, line => {
      try {
        const record = JSON.parse(line);
        return record?.level === 30 && record.msg === `Server listening at ${env.PI_WEB_SESSIOND_SOCKET}`;
      } catch { return false; }
    }, () => { sessiondListenMs = elapsed(); });
    mark('gateway-launch');
    launch('pi-web-server.sh', env, line => line === '  PI WEB is ready', () => { gatewayListenMs = elapsed(); });
    const launchMs = elapsed();
    mark('service-health');
    await until(async () => {
      if (processes.some(process => !process.running)) throw new Error('Stock pi-web process exited');
      try { return (await bootRequest<{ ok: boolean }>('/api/sessiond/health')).ok; }
      catch (error) {
        if (error instanceof StockBootCancelled) throw error;
        diagnostic.healthHttpStatus = error instanceof StockApiError ? error.status : undefined;
        return false;
      }
    }, 30_000);
    const healthyMs = elapsed();
    mark('package-list');
    const packages = await bootRequest<{ packages: { source: string; scope: string }[] }>('/api/pi-packages');
    const listedMs = elapsed();
    const userSources = new Set(packages.packages.filter(row => row.scope === 'user').map(row => row.source));
    let expectedPackages = before;
    // A restored registration of this exact bundled source must not block Chat.
    if (userSources.has(workflows)) {
      mark('workflows-removal');
      const removed = await bootRequest<{ removed: boolean }>('/api/pi-packages/remove', { scope: 'user', source: workflows });
      if (!removed.removed) throw new Error('Bundled Workflows could not be dismissed');
      expectedPackages = before.filter(item => sourceOf(item) !== workflows);
    }
    // Disabling the panel doesn't disable the bundled Pi extension. Dismiss
    // only the newly provisioned source when the managed adapter is registered.
    if (adapterSelected && !before.some(item => sourceOf(item) === mcpManager) && userSources.has(mcpManager)) {
      mark('mcp-settings');
      const after = readSettings();
      // Stock can normalize any configured copy to the bundled path. If any
      // prior entry (including filters) changed, absence before boot is not proof.
      const remaining = Array.isArray(after.packages) ? after.packages.filter(item => sourceOf(item) !== mcpManager) : [];
      const preserved = expectedPackages.every(item => {
        const index = remaining.findIndex(candidate => isDeepStrictEqual(candidate, item));
        if (index === -1) return false;
        remaining.splice(index, 1);
        return true;
      });
      if (preserved && isDeepStrictEqual(after.extensions, settings.extensions)) {
        mark('mcp-removal');
        const removed = await bootRequest<{ removed: boolean }>('/api/pi-packages/remove', { scope: 'user', source: mcpManager });
        if (!removed.removed) throw new Error('Bundled MCP Manager could not be dismissed');
      }
    }
    console.info(`[pi-web] service boot timing ${JSON.stringify({ launchMs, gatewayListenMs, sessiondListenMs, healthyMs, listedMs, readyMs: elapsed() })}`);
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
      if (!starting) {
        const startedAt = performance.now();
        const diagnostic: { operation: string; healthHttpStatus?: number } = { operation: 'profile-restore' };
        starting = boot(diagnostic).catch(async (error: unknown) => {
          if (!(error instanceof StockBootCancelled)) {
            const stopped = processes.find(({ child, running, spawnErrno }) =>
              !running || spawnErrno !== undefined || child.exitCode !== null || child.signalCode !== null);
            const errno = (error as NodeJS.ErrnoException | undefined)?.code ?? stopped?.spawnErrno;
            const signal = stopped?.child.signalCode;
            console.warn(`[pi-web] service boot failed ${JSON.stringify({
              operation: diagnostic.operation, elapsedMs: Math.round(performance.now() - startedAt),
              errno: errno && bootErrnos.has(errno) ? errno : undefined,
              role: stopped?.role, exitCode: stopped?.child.exitCode ?? undefined,
              signal: signal && bootSignals.has(signal) ? signal : undefined,
              httpStatus: error instanceof StockApiError ? error.status
                : diagnostic.operation === 'service-health' ? diagnostic.healthHttpStatus : undefined,
            })}`);
          }
          await stopProcesses();
          starting = undefined;
          throw error;
        });
      }
      return starting;
    },
    async reset() {
      await stopProcesses();
      starting = undefined;
    },
    close() {
      shuttingDown = true;
      bootShutdown.abort(new StockBootCancelled('Container is stopping'));
      closing ??= stopProcesses();
      return closing;
    },
  };
}
