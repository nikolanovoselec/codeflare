// Private managed-primary command over public Pi command-context operations.
// One latest outcome is correlation evidence, never a queue or binding authority.
import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_COMMAND = 'codeflare-conversation';
export const MAX_REQUEST_BYTES = 4096;
export const MAX_OUTCOME_BYTES = 256 * 1024;
const MAX_IDENTITY_BYTES = 4096;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
  && !/^\.+$/.test(value);
const safeGeneration = value => Number.isSafeInteger(value) && value >= 0;
const sameIdentity = (a, b) => a && b && a.sessionId === b.sessionId && a.generation === b.generation
  && a.pid === b.pid && a.startTime === b.startTime && a.paneId === b.paneId;
const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function decode(args) {
  let request;
  const invalid = () => ({ error: {
    requestId: identifier(request?.requestId) ? request.requestId : null,
    op: ['list', 'new', 'resume', 'fork'].includes(request?.op) ? request.op : null,
    status: 'error', code: 'INVALID_REQUEST',
  } });
  if (typeof args !== 'string' || Buffer.byteLength(args) > MAX_REQUEST_BYTES) return invalid();
  try { request = JSON.parse(args); } catch { return invalid(); }
  const extra = request?.op === 'resume' ? ['conversationId'] : request?.op === 'fork' ? ['entryId'] : [];
  if (!exact(request, ['requestId', 'op', 'primary', ...extra]) || !identifier(request.requestId)
    || !['list', 'new', 'resume', 'fork'].includes(request.op)
    || !exact(request.primary, ['sessionId', 'generation']) || !identifier(request.primary.sessionId)
    || !safeGeneration(request.primary.generation)
    || extra.some(key => !identifier(request[key]))) return invalid();
  return { request };
}

// The SDK list owns parsing and ordering. Filesystem checks only narrow its
// authority to existing canonical files in this primary's workspace/session dir.
function scopedRows(rows, cwd, sessionDir) {
  const workspace = fs.realpathSync(cwd);
  const directory = fs.realpathSync(sessionDir);
  return rows.filter(row => {
    try {
      if (!identifier(row.id) || !path.isAbsolute(row.cwd) || fs.realpathSync(row.cwd) !== workspace
        || !path.isAbsolute(row.path)) return false;
      const file = fs.realpathSync(row.path);
      return inside(directory, file) && fs.statSync(file).isFile();
    } catch { return false; }
  });
}

function metadata(row) {
  if (!(row.created instanceof Date) || !(row.modified instanceof Date)
    || !Number.isSafeInteger(row.messageCount) || row.messageCount < 0
    || (row.name !== undefined && typeof row.name !== 'string')) throw new Error('Invalid session metadata');
  return { id: row.id, ...(row.name !== undefined ? { name: row.name } : {}),
    created: row.created.toISOString(), modified: row.modified.toISOString(), messageCount: row.messageCount };
}

export default function primaryConversations(pi, { env = process.env, listSessions } = {}) {
  if (!/^\d+$/.test(env.CODEFLARE_CHAT_PRIMARY_PID ?? '')
    || Number(env.CODEFLARE_CHAT_PRIMARY_PID) !== process.pid) return;
  const identityFile = env.CODEFLARE_CHAT_IDENTITY_FILE;
  const generation = Number(env.CODEFLARE_CHAT_GENERATION);
  if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile)
    || !/^(0|[1-9][0-9]{0,15})$/.test(env.CODEFLARE_CHAT_GENERATION ?? '')
    || !safeGeneration(generation) || typeof listSessions !== 'function') return;
  const directory = path.dirname(identityFile);
  const outcomeFile = path.join(directory, 'conversations.json');
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  let handling = false;

  function privateDirectory() {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('Unsafe runtime directory');
    }
  }

  function published() {
    let descriptor;
    try {
      privateDirectory();
      descriptor = fs.openSync(identityFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1
        || (info.mode & 0o077) !== 0 || info.size > MAX_IDENTITY_BYTES) return;
      const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (!identifier(value?.sessionId) || value.generation !== generation || value.pid !== process.pid
        || value.startTime !== startTime || (value.paneId !== undefined && !identifier(value.paneId))) return;
      return { sessionId: value.sessionId, generation, pid: process.pid, startTime,
        ...(value.paneId !== undefined ? { paneId: value.paneId } : {}) };
    } catch { return; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  function write(outcome) {
    let temporary;
    try {
      let wire = JSON.stringify(outcome);
      if (Buffer.byteLength(wire) > MAX_OUTCOME_BYTES) {
        // Never silently truncate history or a metadata field and claim success.
        wire = JSON.stringify({ requestId: outcome.requestId, op: outcome.op, from: outcome.from,
          status: 'error', code: 'NATIVE_FAILED' });
      }
      privateDirectory();
      temporary = fs.mkdtempSync(path.join(directory, '.conversations-'));
      const pending = path.join(temporary, 'outcome');
      fs.writeFileSync(pending, wire, { mode: 0o600, flag: 'wx' });
      fs.renameSync(pending, outcomeFile);
    } catch {
      // No raw native/path errors. Missing outcome means uncertainty to Host.
      console.error('Codeflare: private conversation outcome could not be published');
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  pi.registerCommand(CONVERSATION_COMMAND, {
    description: 'Private Codeflare primary conversation control',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') return;
      const { request, error } = decode(args);
      if (!request) { write(error); return; }
      const { requestId, op, primary: from } = request;
      const base = { requestId, op, from };
      const fail = code => write({ ...base, status: 'error', code });
      if (handling) { fail('BUSY'); return; }
      handling = true;
      try {
        const source = published();
        const current = () => {
          if (!source || from.generation !== generation || from.sessionId !== source.sessionId
            || !sameIdentity(source, published())) return false;
          try { return ctx.sessionManager.getSessionId() === source.sessionId; }
          catch { return false; } // A Terminal replacement can invalidate this context.
        };
        if (!current()) { fail('STALE_PRIMARY'); return; }
        const idle = () => ctx.isIdle() && !ctx.hasPendingMessages();
        if (op !== 'list' && !idle()) { fail('BUSY'); return; }
        let target;
        if (op === 'list' || op === 'resume') {
          const cwd = ctx.cwd;
          const sessionDir = ctx.sessionManager.getSessionDir();
          const rows = scopedRows(await listSessions(cwd, sessionDir), cwd, sessionDir);
          if (!current()) { fail('STALE_PRIMARY'); return; }
          if (op === 'list') {
            write({ ...base, status: 'ok', primary: source, conversations: rows.map(metadata) });
            return;
          }
          if (!idle()) { fail('BUSY'); return; }
          const matches = rows.filter(row => row.id === request.conversationId);
          if (matches.length !== 1) { fail('NOT_FOUND'); return; }
          target = matches[0].path;
        }
        if (op === 'fork') {
          const entry = ctx.sessionManager.getEntry(request.entryId);
          if (!entry || entry.id !== request.entryId || entry.type !== 'message') { fail('INVALID_FORK'); return; }
        }
        // Only fresh callback context can supply replacement-bound reads. Never
        // read ctx again after invoking a replacement, even on cancellation.
        let adopted;
        const options = { withSession: async fresh => {
          const identity = published();
          if (fresh.mode === 'tui' && identity && identity.sessionId === fresh.sessionManager.getSessionId()
            && identity.pid === source.pid && identity.startTime === source.startTime
            && identity.generation === source.generation && identity.paneId === source.paneId) adopted = identity;
        } };
        const result = op === 'new' ? await ctx.newSession(options)
          : op === 'resume' ? await ctx.switchSession(target, options) : await ctx.fork(request.entryId, options);
        if (result.cancelled) { write({ ...base, status: 'cancelled' }); return; }
        if (!adopted || !sameIdentity(adopted, published())) { fail('UNCONFIRMED_ADOPTION'); return; }
        write({ ...base, status: 'ok', primary: adopted });
      } catch {
        // A thrown native operation may already have replaced the session. This
        // grants no binding and makes no rollback claim; Host must reconfirm.
        fail('NATIVE_FAILED');
      } finally { handling = false; }
    },
  });
}
