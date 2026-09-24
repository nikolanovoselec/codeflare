import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PACK = 128 * 1024 * 1024;
const MAX_CHECKOUT = 128 * 1024 * 1024;
const MAX_PACKET = 8 * 1024 * 1024;

// Runs inside a private mount/PID/network namespace. All task writes share one bounded tmpfs.
function sandboxTask(): void {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const { mkdirSync, writeFileSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const config = JSON.parse(process.argv[1]) as {
    head: string; acknowledgedHead: string | null; lane: string; script: string;
    maxCheckoutBytes: number; maxOutputBytes: number; gitAddressSpaceBytes: number;
  };
  const repo = '/work/checkout';
  mkdirSync('/work/bin');
  mkdirSync('/work/home');
  mkdirSync('/work/template');
  mkdirSync(repo);
  // Canonical script invokes `git` by PATH; it must receive the same per-process limits.
  writeFileSync('/work/bin/git', `#!/bin/sh\nexec /usr/bin/prlimit --as=${config.gitAddressSpaceBytes} --cpu=60 -- /usr/bin/git "$@"\n`, { mode: 0o755 });
  process.env.PATH = '/work/bin:/usr/bin:/bin';
  process.env.HOME = '/work/home';
  process.env.XDG_CONFIG_HOME = '/work/home';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_0 = '/dev/null';
  process.env.GIT_CONFIG_KEY_1 = 'protocol.allow';
  process.env.GIT_CONFIG_VALUE_1 = 'never';
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_ATTR_NOSYSTEM = '1';
  process.env.GIT_LFS_SKIP_SMUDGE = '1';
  process.env.GIT_INDEX_THREADS = '1';
  process.env.GIT_PACK_THREADS = '1';
  process.env.GIT_NO_REPLACE_OBJECTS = '1';
  const run = (command: string, args: string[], maxBuffer = 64 * 1024) => {
    const result = spawnSync(command, args, { cwd: repo, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer });
    if (result.error || result.status !== 0) throw new Error('Approved task unavailable');
    return result.stdout as Buffer;
  };
  const git = (args: string[], maxBuffer?: number, pack?: Buffer) => {
    const result = spawnSync('/work/bin/git', args, { cwd: repo, env: process.env,
      input: pack, stdio: [pack ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: maxBuffer ?? 64 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Approved task unavailable');
    return result.stdout as Buffer;
  };
  git(['init', '-q', '--template=/work/template']);
  git(['index-pack', '--strict', '--stdin'], 64 * 1024, readFileSync(0));
  if (git(['cat-file', '-t', config.head]).toString().trim() !== 'commit') throw new Error('Approved task denied');
  if (config.acknowledgedHead) {
    if (git(['cat-file', '-t', config.acknowledgedHead]).toString().trim() !== 'commit') throw new Error('Approved task denied');
    git(['merge-base', '--is-ancestor', config.acknowledgedHead, config.head]);
  }
  const tree = git(['ls-tree', '-r', '-l', '-z', config.head], 16 * 1024 * 1024);
  let checkoutBytes = 0;
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('Approved task denied');
    const metadata = entry.slice(0, tab).trim().split(/\s+/);
    const [mode, type, object, size] = metadata;
    const name = entry.slice(tab + 1);
    if (metadata.length !== 4 || !/^[a-f0-9]{40}$/.test(object)
      || mode !== '100644' && mode !== '100755' || type !== 'blob'
      || !/^[0-9]+$/.test(size) || !name || name.split('/').some(part => !part || part === '.' || part === '..'
        || part.toLowerCase() === '.git') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('Approved task denied');
    }
    checkoutBytes += Number(size);
    if (!Number.isSafeInteger(checkoutBytes) || checkoutBytes > config.maxCheckoutBytes) {
      throw new Error('Approved task exceeds checkout bound');
    }
  }
  git(['checkout', '--detach', '--force', config.head]);
  if (git(['rev-parse', 'HEAD']).toString().trim() !== config.head) throw new Error('Approved task denied');
  const scope = config.acknowledgedHead ? 'diff' : 'all';
  const args = [config.script, '--repo', repo, '--scope', scope,
    ...(config.acknowledgedHead ? ['--range', `${config.acknowledgedHead}..${config.head}`] : []),
    '--lane', config.lane, '--with-evidence'];
  const bytes = run(process.execPath, args, config.maxOutputBytes);
  const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
    scope?: unknown; lane?: unknown; range?: unknown;
  };
  if (packet.scope !== scope || packet.lane !== config.lane
    || packet.range !== (config.acknowledgedHead ? `${config.acknowledgedHead}..${config.head}` : undefined)) {
    throw new Error('Approved task denied');
  }
  process.stdout.write(bytes);
}


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
  scriptPath: string;
  signal?: AbortSignal;
  sandboxBytes?: number;
  gitAddressSpaceBytes?: number;
}

function validLimit(value: number, ceiling: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling;
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
    || !path.isAbsolute(options.scriptPath)
    || options.sandboxBytes !== undefined && !validLimit(options.sandboxBytes, 256 * 1024 * 1024)
    || options.gitAddressSpaceBytes !== undefined && !validLimit(options.gitAddressSpaceBytes, 512 * 1024 * 1024)
    || options.signal?.aborted) throw new Error('Approved task denied');

  // Bind only the trusted script, executable closure and read-only system libraries.
  const parents: string[] = [];
  for (let dir = path.dirname(options.scriptPath); dir !== '/'; dir = path.dirname(dir)) parents.unshift(dir);
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net', '--new-session', '--clearenv',
    '--setenv', 'LANG', 'C', '--setenv', 'PATH', '/work/bin:/usr/bin:/bin',
    '--proc', '/proc', '--dev', '/dev', '--size', String(options.sandboxBytes ?? 256 * 1024 * 1024), '--tmpfs', '/work',
    '--ro-bind', '/usr', '/usr'];
  for (const dir of ['/lib', '/lib64', '/bin']) {
    if (dir !== '/usr' && path.resolve(dir) !== '/usr') args.push('--ro-bind', dir, dir);
  }
  for (const dir of parents) args.push('--dir', dir);
  // The approved script's adjacent lane-evidence module is part of its fixed closure.
  // CI and the image may install Node outside /usr; bind only that trusted executable.
  args.push('--dir', '/runner', '--ro-bind', realpathSync(process.execPath), '/runner/node',
    '--ro-bind', path.dirname(options.scriptPath), path.dirname(options.scriptPath),
    '--chdir', '/work', '--', '/runner/node', '-e', `(${sandboxTask.toString()})()`,
    JSON.stringify({ head: input.head, acknowledgedHead: input.acknowledgedHead, lane: input.lane,
      script: options.scriptPath, maxCheckoutBytes: input.maxCheckoutBytes,
      maxOutputBytes: input.maxOutputBytes, gitAddressSpaceBytes: options.gitAddressSpaceBytes ?? 512 * 1024 * 1024 }));
  const bytes = await execute('/usr/bin/bwrap', args, {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, deadline: input.deadline,
    signal: options.signal, maxBytes: input.maxOutputBytes, input: input.pack,
  });
  return bytes;
}
