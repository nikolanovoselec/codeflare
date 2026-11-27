import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sessionIdPattern = /^[a-z0-9]{8,24}$/;
const nativeIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9])?$/;

function stateDirectory(home, parts, create = false) {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('Classic state directory is redirected or invalid');
    if (!stat && create) mkdirSync(path, { mode: 0o700 });
  }
  return path;
}

function classicPiState(home, sessionId) {
  if (!home || typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)) throw new Error('Invalid Classic session ID');
  home = realpathSync(home);
  const cwd = realpathSync(join(home, 'workspace'));
  if (!lstatSync(cwd).isDirectory()) throw new Error('Invalid Classic workspace');
  const store = ['.pi', 'agent', 'sessions', `--${cwd.slice(1).replace(/[\\/:]/g, '-')}--`];
  const binding = ['.codeflare', 'classic', 'sessions', `cf-${sessionId}`];
  return {
    home, cwd, store, binding,
    sessionDir: stateDirectory(home, store),
    bindingFile: join(stateDirectory(home, binding), 'agent-session-id'),
  };
}

function readRegularPrefix(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Classic state is not a regular file');
    const buffer = Buffer.alloc(limit);
    const count = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function exactTranscript(state, id, rootOnly) {
  if (typeof id !== 'string' || !nativeIdPattern.test(id)) throw new Error('Invalid native Pi ID');
  const { cwd, sessionDir } = state;
  const candidates = readdirSync(sessionDir).filter(name => {
    const separator = name.indexOf('_');
    return separator > 0 && name.slice(separator + 1) === `${id}.jsonl`;
  });
  if (candidates.length !== 1 || candidates[0].includes('.conflict')) throw new Error('Classic Pi transcript is not unique');
  const path = join(sessionDir, candidates[0]);
  const bytes = readRegularPrefix(path, 65536);
  const end = bytes.indexOf(10);
  if (end < 0) throw new Error('Classic Pi transcript has no native header');
  const header = JSON.parse(bytes.toString('utf8', 0, end));
  const parent = header?.parentSession;
  if (header?.type !== 'session' || header.id !== id || header.cwd !== cwd
    || ![1, 2, 3].includes(header.version) || typeof header.timestamp !== 'string' || !Number.isFinite(Date.parse(header.timestamp))
    || (parent !== undefined && (rootOnly || typeof parent !== 'string' || !parent))) {
    throw new Error('Classic Pi transcript header does not match the workspace or native ID');
  }
  return path;
}

function publishFile(path, bytes, exclusive) {
  const temporary = join(dirname(path), `.classic-pi.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readBinding(state) {
  const bytes = readRegularPrefix(state.bindingFile, 257);
  if (bytes.length > 256) throw new Error('Classic binding is oversized');
  return bytes.toString('utf8').trim();
}

export function writeClassicPiBinding(home, sessionId, id, path, { rootOnly = false } = {}) {
  const state = classicPiState(home, sessionId);
  if (exactTranscript(state, id, rootOnly) !== path) throw new Error('Classic Pi selected a different native transcript');
  const stat = lstatSync(state.bindingFile, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error('Classic binding is redirected or invalid');
  stateDirectory(state.home, state.binding, true);
  publishFile(state.bindingFile, `${id}\n`, false);
}

function prepareClassicPi(home, sessionId) {
  const state = classicPiState(home, sessionId);
  // Known bindings are never replaced just because their transcript aged out.
  if (lstatSync(state.bindingFile, { throwIfNoEntry: false })) return;
  stateDirectory(state.home, state.store, true);
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const path = join(state.sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp, cwd: state.cwd };
  publishFile(path, `${JSON.stringify(header)}\n`, true);
  if (exactTranscript(state, id, true) !== path) throw new Error('Classic Pi seeded a different native transcript');
  stateDirectory(state.home, state.binding, true);
  publishFile(state.bindingFile, `${id}\n`, true);
}

function main([action, home, sessionId, id, path]) {
  switch (action) {
    case 'prepare': prepareClassicPi(home, sessionId); break;
    case 'resume': {
      const state = classicPiState(home, sessionId);
      process.stdout.write(exactTranscript(state, readBinding(state), false));
      break;
    }
    case 'bind': writeClassicPiBinding(home, sessionId, id, path); break;
    default: throw new Error('Unknown Classic Pi state operation');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch { process.exitCode = 1; }
}
