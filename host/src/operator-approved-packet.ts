import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PACK = 128 * 1024 * 1024;
const MAX_CHECKOUT = 128 * 1024 * 1024;
const MAX_PACKET = 8 * 1024 * 1024;

export interface ApprovedPacketInput {
  pack: Uint8Array;
  head: string;
  acknowledgedHead: string | null;
  lane: string;
  deadline: number;
  maxPackBytes: number;
  maxCheckoutBytes: number;
  maxOutputBytes: number;
}

interface TrustedRunnerOptions {
  root: string;
  scriptPath: string;
  signal?: AbortSignal;
}

function validLimit(value: number, ceiling: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling;
}

/** Never inherit credentials, Git config, process launchers, or hooks from the session. */
function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'protocol.allow', GIT_CONFIG_VALUE_1: 'never',
    GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1',
  };
}

async function execute(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; deadline: number; signal?: AbortSignal;
  input?: Uint8Array; maxBytes?: number;
}): Promise<Buffer> {
  if (Date.now() >= options.deadline || options.signal?.aborted) throw new Error('Approved task unavailable');
  const child = spawn(command, args, { cwd: options.cwd, env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let exceeded = false;
  let timedOut = false;
  let failed = false;
  let size = 0;
  const chunks: Buffer[] = [];
  const stop = () => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.deadline - Date.now()));
  const aborted = () => stop();
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on('error', () => { failed = true; stop(); });
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 64 * 1024)) { exceeded = true; stop(); }
        else chunks.push(chunk);
      });
      // Never expose stderr: Git may echo remote data or candidate paths.
      child.stderr.resume();
    });
    // Closing the abort-check/listener race must happen before any input is sent.
    if (options.signal?.aborted) stop();
    child.stdin.on('error', () => { /* A rejected pack may close stdin first. */ });
    try { child.stdin.end(options.input ? Buffer.from(options.input) : undefined); }
    catch { failed = true; stop(); }
    const result = await closed; // Reap a killed or failed child before the checkout directory is removed.
    if (result.code !== 0 || result.signal || failed || exceeded || timedOut
      || Date.now() >= options.deadline || options.signal?.aborted) throw new Error('Approved task unavailable');
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', aborted);
  }
}

/** The host receives inert Git pack bytes from its authenticated parent, never a remote URL or token.
 * Only the trusted host composition selects scriptPath; the pack and candidate tree cannot do so. */
export async function runApprovedPacket(input: ApprovedPacketInput, options: TrustedRunnerOptions): Promise<Uint8Array> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== [
      'acknowledgedHead', 'deadline', 'head', 'lane', 'maxCheckoutBytes',
      'maxOutputBytes', 'maxPackBytes', 'pack',
    ].join(',')
    || !(input.pack instanceof Uint8Array) || input.pack.byteLength === 0
    || !SHA.test(input.head) || input.acknowledgedHead !== null && !SHA.test(input.acknowledgedHead)
    || !LANE.test(input.lane) || !Number.isSafeInteger(input.deadline)
    || input.deadline <= Date.now() || input.deadline > Date.now() + 5 * 60_000
    || !validLimit(input.maxPackBytes, MAX_PACK) || input.pack.byteLength > input.maxPackBytes
    || !validLimit(input.maxCheckoutBytes, MAX_CHECKOUT)
    || !validLimit(input.maxOutputBytes, MAX_PACKET)
    || !path.isAbsolute(options.root) || !path.isAbsolute(options.scriptPath)
    || options.signal?.aborted) throw new Error('Approved task denied');

  const directory = await mkdtemp(path.join(options.root, 'operator-packet-'));
  try {
    const home = path.join(directory, 'home');
    const template = path.join(directory, 'template');
    const repo = path.join(directory, 'checkout');
    await Promise.all([mkdir(home), mkdir(template), mkdir(repo)]);
    const env = isolatedEnvironment(home);
    const git = (args: string[], maxBytes?: number, pack?: Uint8Array) => execute('git', args, {
      cwd: repo, env, deadline: input.deadline, signal: options.signal, maxBytes, input: pack,
    });
    await git(['init', '-q', `--template=${template}`]);
    // This caps transported/compressed bytes, not Git index-pack's transient expansion or
    // all ancestor objects. The checkout budget below is checked before worktree writes;
    // production admission still needs an independently enforced runtime resource ceiling.
    await git(['index-pack', '--strict', '--stdin'], 64 * 1024, input.pack);
    if ((await git(['cat-file', '-t', input.head])).toString().trim() !== 'commit') throw new Error('Approved task denied');
    if (input.acknowledgedHead) {
      if ((await git(['cat-file', '-t', input.acknowledgedHead])).toString().trim() !== 'commit') {
        throw new Error('Approved task denied');
      }
      await git(['merge-base', '--is-ancestor', input.acknowledgedHead, input.head]);
    }
    // Inspect the exact immutable tree BEFORE checkout, including compressed expansion.
    const tree = await git(['ls-tree', '-r', '-l', '-z', input.head], 16 * 1024 * 1024);
    let checkoutBytes = 0;
    for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Approved task denied');
      const metadata = entry.slice(0, tab).trim().split(/\s+/);
      const [mode, type, object, size] = metadata;
      const name = entry.slice(tab + 1);
      if (metadata.length !== 4 || !SHA.test(object)
        || mode !== '100644' && mode !== '100755' || type !== 'blob'
        || !/^[0-9]+$/.test(size) || !name || name.split('/').some(part => !part || part === '.' || part === '..'
          || part.toLowerCase() === '.git') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) {
        throw new Error('Approved task denied');
      }
      checkoutBytes += Number(size);
      if (!Number.isSafeInteger(checkoutBytes) || checkoutBytes > input.maxCheckoutBytes) {
        throw new Error('Approved task exceeds checkout bound');
      }
    }
    await git(['checkout', '--detach', '--force', input.head]);
    if ((await git(['rev-parse', 'HEAD'])).toString().trim() !== input.head) throw new Error('Approved task denied');
    const scope = input.acknowledgedHead ? 'diff' : 'all';
    const args = [options.scriptPath, '--repo', repo, '--scope', scope,
      ...(input.acknowledgedHead ? ['--range', `${input.acknowledgedHead}..${input.head}`] : []),
      '--lane', input.lane, '--with-evidence'];
    const bytes = await execute(process.execPath, args, { cwd: repo, env,
      deadline: input.deadline, signal: options.signal, maxBytes: input.maxOutputBytes });
    const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      scope?: unknown; lane?: unknown; range?: unknown;
    };
    if (packet.scope !== scope || packet.lane !== input.lane
      || packet.range !== (input.acknowledgedHead ? `${input.acknowledgedHead}..${input.head}` : undefined)) {
      throw new Error('Approved task denied');
    }
    if (options.signal?.aborted || Date.now() >= input.deadline) throw new Error('Approved task unavailable');
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
