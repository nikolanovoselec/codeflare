const { spawn } = require('node:child_process');
const { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { isAbsolute, join } = require('node:path');
const { constants } = require('node:os');

// One authorized CI diagnostic. Never wrap/replace workerd or change its arguments.
const directory = process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP)
  ? join(process.env.RUNNER_TEMP, 'native-connection-capture') : undefined;
const evidence = directory && join(directory, 'evidence');
const privateDirectory = directory && join(directory, 'private');
let scope;
const owned = new WeakMap();
const pendingTracers = new Set();
const calls = 'socket,bind,listen,connect,accept,accept4,getsockname,getpeername,getsockopt,shutdown,close,read,readv,write,writev,recvfrom,recvmsg,recvmmsg,sendto,sendmsg,sendmmsg,clone,clone3,exit,exit_group';
// Whole-call raw decoding never dereferences buffers, iovec or ancillary messages.
const raw = 'read,readv,write,writev,recvfrom,recvmsg,recvmmsg,sendto,sendmsg,sendmmsg';
const callNames = new Set(calls.split(','));
const rawNames = new Set(raw.split(','));
const errors = new Set('EAGAIN,EINTR,EINPROGRESS,EBADF,EINVAL,EPIPE,ECONNRESET,ECONNREFUSED,ECONNABORTED,ENOTCONN,ETIMEDOUT,ENOMEM,EMFILE,ENFILE,EIO,EFAULT,ENOSYS,EPERM,EACCES'.split(','));
const signals = new Set('SIGKILL,SIGTERM,SIGINT,SIGSEGV,SIGABRT,SIGPIPE,SIGCHLD,SIGXFSZ,SIGSTOP,SIGCONT,SIGTRAP'.split(','));
const integer = value => value && /^(?:0x[\da-f]+|\d+)$/i.test(value) ? Number(value) : null;

// Intentional privacy contract: return closed numeric metadata, never trace arguments/text.
function normalize(line) {
  const prefix = /^(\d+\.\d+)\s+(.+)$/.exec(line);
  if (!prefix) return null;
  const at = Number(prefix[1]) * 1000;
  if (!Number.isFinite(at)) return null;
  const text = prefix[2];
  const killed = /^\+\+\+ killed by (SIG[A-Z]+)\b/.exec(text);
  if (killed) return { at, kind: 'exit', signal: signals.has(killed[1]) ? killed[1] : 'OTHER' };
  const signal = /^--- (SIG[A-Z]+)\b/.exec(text);
  if (signal) return { at, kind: 'signal', signal: signals.has(signal[1]) ? signal[1] : 'OTHER' };
  const ended = /^\+\+\+ exited with (\d+) \+\+\+$/.exec(text);
  if (ended) return { at, kind: 'exit', code: Number(ended[1]) };
  const call = /^(\w+)\(/.exec(text) ?? /^<\.\.\. (\w+) resumed>/.exec(text);
  if (!call || !callNames.has(call[1])) return null;
  const name = call[1];
  const result = /\)\s+=\s+(-?0x[\da-f]+|-?\d+|\?)(?:\s+([A-Z][A-Z0-9_]+))?/.exec(text);
  const first = /^\w+\((0x[\da-f]+|\d+)(?:,|\))/.exec(text);
  const port = /sin6?_port=htons\((\d+)\)/.exec(text);
  const address = /inet_addr\("(127\.0\.0\.1)"\)/.exec(text)
    ?? /inet_pton\(AF_INET6, "(::1)"/.exec(text);
  return { at, kind: 'syscall', call: name, resumed: text.startsWith('<...'), unfinished: text.endsWith('<unfinished ...>'),
    argument0: integer(first?.[1]), result: result && result[1] !== '?' ? Number(result[1]) : null,
    errno: result?.[2] ? errors.has(result[2]) ? result[2] : 'OTHER' : null,
    address: address?.[1] ?? null, port: port && Number(port[1]) <= 65535 ? Number(port[1]) : null,
    threadClone: (name === 'clone' || name === 'clone3') && !text.startsWith('<...') && /\bflags\s*=/.test(text)
      ? text.includes('CLONE_THREAD') : null,
    decodedIo: rawNames.has(name) && /"|iov_base|msg_iov|msg_control/.test(text) };
}
exports.normalize = normalize;

function normalizeStream(lines) {
  let pendingClone;
  let complete = lines.length > 0;
  const rows = lines.map(line => {
    const row = normalize(line);
    if (!row) { complete = false; return null; }
    if (row.call === 'clone' || row.call === 'clone3') {
      if (row.resumed) {
        if (pendingClone?.call === row.call) row.threadClone = pendingClone.threadClone;
        else complete = false;
        pendingClone = undefined;
      } else if (row.unfinished) {
        if (pendingClone) complete = false;
        pendingClone = row;
      }
      if (row.result > 0 && row.threadClone !== true) complete = false;
    }
    return row;
  });
  return { rows, complete: complete && !pendingClone };
}
function record(value) {
  try {
    if (!directory || process.env.CI !== 'true') return;
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    appendFileSync(join(evidence, `lifecycle-${process.pid}.jsonl`), JSON.stringify({ at: Date.now(), nodePid: process.pid, ...value }) + '\n', { mode: 0o600 });
  } catch { console.error('[native-flue] native-capture-write-failed'); }
}
exports.setScope = value => { scope = typeof value === 'string' && /^[0-2]:[1-9][0-9]{0,5}$/.test(value) ? value : undefined; };
exports.started = (child, names) => {
  if (!scope || !directory || process.env.CI !== 'true' || !Number.isSafeInteger(child.pid)) return;
  const role = names.includes('ProxyWorker') ? 'proxy' : names.includes('operator-loader-fixture') ? 'user' : undefined;
  if (!role) { record({ stage: 'unsupported-role', scope }); return; }
  const entry = { scope, role, pid: child.pid };
  owned.set(child, entry);
  record({ ...entry, stage: 'spawn' });
  child.once('exit', (code, signal) => record({ ...entry, stage: 'exit', code, signal }));
  try {
    const prefix = join(privateDirectory, `${scope.replace(':', '-')}-${role}-${child.pid}.strace`);
    const tracer = spawn('sudo', ['-n', 'prlimit', '--fsize=1048576', '--', 'strace', '-ff', '-ttt', '-s', '64', '-e', `trace=${calls}`, '-e', `raw=${raw}`, '-o', prefix, '-p', String(child.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
    tracer.once('spawn', () => record({ ...entry, stage: 'tracer-spawn', launcherPid: tracer.pid }));
    let buffered = '';
    tracer.stderr.on('data', chunk => {
      buffered = (buffered + chunk.toString()).slice(-4096);
      if (new RegExp(`Process ${child.pid} attached\\b`).test(buffered)) {
        record({ ...entry, stage: 'attached' });
        buffered = '';
      }
    });
    tracer.once('error', () => record({ ...entry, stage: 'tracer-unavailable' }));
    const closed = new Promise(resolve => tracer.once('close', (code, signal) => {
      record({ ...entry, stage: 'tracer-close', code, signal });
      resolve();
    }));
    pendingTracers.add(closed);
    void closed.then(() => pendingTracers.delete(closed));
    // Strace follows threads; unexpected non-thread children fail capture qualification.
    tracer.unref();
    tracer.stderr.unref?.();
  } catch { record({ ...entry, stage: 'tracer-unavailable' }); }
};
exports.drain = () => Promise.all([...pendingTracers]);
exports.ready = (child, port) => {
  const entry = owned.get(child);
  if (entry) record({ ...entry, stage: 'ready', port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null });
};
exports.disposing = child => {
  const entry = owned.get(child);
  if (entry) record({ ...entry, stage: 'dispose-requested' });
};

if (require.main === module) {
  if (process.env.CI !== 'true' || !directory || process.argv[2] !== 'verify') throw new Error('Native capture verification is CI-only');
  const names = readdirSync(privateDirectory);
  const events = readdirSync(evidence).filter(name => /^lifecycle-\d+\.jsonl$/.test(name))
    .flatMap(name => readFileSync(join(evidence, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const spawned = events.filter(event => event.stage === 'spawn');
  const scopes = new Set(spawned.map(event => event.scope));
  let complete = spawned.length >= 4 && spawned.length <= 16 && scopes.size === 2
    && !events.some(event => ['unsupported-role', 'tracer-unavailable'].includes(event.stage)
      || event.stage === 'tracer-close' && (event.signal === 'SIGXFSZ' || event.code === 153));
  for (const value of scopes) complete &&= ['proxy', 'user'].every(role => spawned.some(event => event.scope === value && event.role === role));
  const manifest = [];
  let bytes = 0;
  for (const entry of spawned) {
    const terminal = events.find(event => event.pid === entry.pid && event.stage === 'exit');
    const tracerTerminal = events.find(event => event.pid === entry.pid && event.stage === 'tracer-close');
    complete &&= Boolean(terminal && tracerTerminal && tracerTerminal.signal === null
      && [0, terminal.code, terminal.signal ? 128 + constants.signals[terminal.signal] : null].includes(tracerTerminal.code));
    const prefix = `${entry.scope.replace(':', '-')}-${entry.role}-${entry.pid}.strace.`;
    const traces = names.filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)));
    if (!traces.includes(prefix + entry.pid)) complete = false;
    for (const name of traces) {
      const path = join(privateDirectory, name);
      bytes += statSync(path).size;
      if (bytes > 16 * 1024 * 1024) throw new Error('Native capture evidence bound exceeded');
      const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      const tid = Number(name.slice(prefix.length));
      const stream = normalizeStream(rows);
      const normalized = stream.rows;
      if (normalized.some(row => row?.decodedIo)) throw new Error('Native capture payload decoding refused');
      const last = normalized.at(-1);
      complete &&= stream.complete && last?.kind === 'exit'
        && (tid !== entry.pid || Boolean(terminal && (terminal.signal
          ? last.signal === terminal.signal : last.code === terminal.code)));
      const data = normalized.filter(Boolean).map(row => JSON.stringify({ ...entry, tid, ...row })).join('\n') + '\n';
      const output = name + '.jsonl';
      writeFileSync(join(evidence, output), data, { mode: 0o600 });
      manifest.push({ name: output, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  if (names.some(name => !spawned.some(entry => name.startsWith(`${entry.scope.replace(':', '-')}-${entry.role}-${entry.pid}.strace.`)))) throw new Error('Native capture unowned trace refused');
  // Attachment must precede each original observation; PID identity is not inferred from port alone.
  const log = readFileSync(join(process.env.RUNNER_TEMP, 'backend-node-flue.log'), 'utf8');
  const correlations = [];
  const expected = [];
  const forwards = [];
  for (const line of log.split('\n')) {
    const harnessMarker = '[native-flue] harness-observe=';
    const proxyMarker = '[native-flue] proxy-observe=';
    const marker = line.includes(harnessMarker) ? harnessMarker : line.includes(proxyMarker) ? proxyMarker : null;
    if (!marker) continue;
    let observation;
    try { observation = JSON.parse(line.slice(line.indexOf(marker) + marker.length).replace(/\x1b\[[0-9;]*m/g, '')); }
    catch { throw new Error('Native capture correlation malformed'); }
    if (!scopes.has(observation.harnessEpoch) || marker === proxyMarker && observation.stage !== 'forward-start') continue;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(observation.observationId)
      || !Number.isSafeInteger(observation.at) || marker === proxyMarker && (!/^[0-9]{1,5}$/.test(observation.destinationPort)
      || Number(observation.destinationPort) < 1 || Number(observation.destinationPort) > 65535)) {
      throw new Error('Native capture correlation fields refused');
    }
    (marker === harnessMarker ? expected : forwards).push(observation);
  }
  const sameObservation = (left, right) => left.observationId === right.observationId && left.harnessEpoch === right.harnessEpoch;
  for (const observation of expected) {
    const matches = forwards.filter(forward => sameObservation(forward, observation));
    const forward = matches.length === 1 ? matches[0] : null;
    const alive = spawned.filter(entry => entry.scope === observation.harnessEpoch
      && entry.at <= observation.at
      && !events.some(event => event.pid === entry.pid && event.stage === 'exit' && event.at < (forward?.at ?? observation.at)));
    const users = forward ? alive.filter(entry => entry.role === 'user'
      && events.some(event => event.pid === entry.pid && event.stage === 'ready' && String(event.port) === forward.destinationPort)) : [];
    const proxies = forward ? alive.filter(entry => entry.role === 'proxy') : [];
    const covered = Boolean(forward && observation.at <= forward.at
      && expected.filter(item => sameObservation(item, observation)).length === 1
      && users.length === 1 && proxies.length === 1 && [users[0], proxies[0]]
        .every(entry => events.some(event => event.pid === entry.pid && event.stage === 'attached' && event.at <= observation.at)
          && !events.some(event => event.pid === entry.pid && event.stage === 'tracer-close' && event.at < forward.at)));
    complete &&= covered;
    correlations.push({ observationId: observation.observationId, scope: observation.harnessEpoch,
      at: observation.at, forwardAt: forward?.at ?? null, destinationPort: forward ? Number(forward.destinationPort) : null, covered,
      userPid: users.length === 1 ? users[0].pid : null, proxyPid: proxies.length === 1 ? proxies[0].pid : null });
  }
  complete &&= forwards.every(forward => expected.some(observation => sameObservation(forward, observation)));
  complete &&= [...scopes].every(value => correlations.some(row => row.scope === value));
  writeFileSync(join(evidence, 'verified.json'), JSON.stringify({ diagnostic: 'native-connection-capture', complete,
    calls, raw, bytes, processes: spawned, correlations, files: manifest, boundary: 'kernel events, not parsed HTTP dispatch' }, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'safe=true\n');
  console.log(JSON.stringify({ diagnostic: 'native-connection-capture', complete, processes: spawned.length, files: manifest.length, bytes }));
  if (!complete) throw new Error('Native capture coverage incomplete; normalized safe evidence retained');
}
