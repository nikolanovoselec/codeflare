import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ChatConversation, ChatConversationPort, ChatPrimary } from './chat-proxy.js';

export interface ChatNativePrimary extends ChatPrimary {
  pid: number;
  startTime: string;
  paneId?: string;
}
interface PrimaryConversationsOptions {
  runtimeDir: string;
  budgetMs: number;
  readIdentity: () => ChatNativePrimary | null;
  confirm: (expected: ChatNativePrimary) => Promise<ChatPrimary>;
  dispatch: (source: ChatNativePrimary, text: string) => Promise<void>;
}
type Operation = 'list' | 'new' | 'resume' | 'fork';
const MAX_OUTCOME_BYTES = 8 * 1024 * 1024;
const codes = new Set(['BUSY', 'STALE_PRIMARY', 'NOT_FOUND', 'INVALID_FORK', 'NATIVE_FAILED',
  'UNCONFIRMED_ADOPTION', 'CONVERSATION_CANCELLED', 'CONVERSATION_PENDING', 'CONVERSATION_UNAVAILABLE']);
const fail = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !/^\.+$/.test(value);
const sameBinding = (a: ChatPrimary, b: ChatPrimary): boolean => a.sessionId === b.sessionId && a.generation === b.generation;
const sameCarrier = (a: ChatNativePrimary, b: ChatNativePrimary): boolean => a.pid === b.pid
  && a.startTime === b.startTime && a.generation === b.generation && a.paneId === b.paneId;
const sameIdentity = (a: ChatNativePrimary, b: ChatNativePrimary): boolean => sameBinding(a, b) && sameCarrier(a, b);
const primary = (value: unknown): value is ChatNativePrimary => object(value) && identifier(value.sessionId)
  && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
  && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
  && typeof value.startTime === 'string' && /^\d+$/.test(value.startTime)
  && (value.paneId === undefined || identifier(value.paneId));
const bare = (value: ChatPrimary): ChatPrimary => ({ sessionId: value.sessionId, generation: value.generation });

function metadata(value: unknown): ChatConversation[] {
  const date = (entry: unknown): entry is string => typeof entry === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry) && Number.isFinite(Date.parse(entry));
  if (!Array.isArray(value)) throw fail('NATIVE_FAILED');
  return value.map(row => {
    if (!object(row) || !identifier(row.id) || !date(row.created) || !date(row.modified)
      || !Number.isSafeInteger(row.messageCount) || (row.messageCount as number) < 0
      || row.name !== undefined && typeof row.name !== 'string') throw fail('NATIVE_FAILED');
    return { id: row.id, ...(row.name === undefined ? {} : { name: row.name as string }),
      created: row.created, modified: row.modified, messageCount: row.messageCount as number };
  });
}

// Read the one private, atomically replaced latest outcome. No journal or queue.
// fstat plus a bounded read also handles a file growing after the size check.
function readOutcome(runtimeDir: string): unknown {
  let descriptor: number | undefined;
  try {
    const directory = fs.lstatSync(runtimeDir);
    if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) {
      throw fail('CONVERSATION_UNAVAILABLE');
    }
    descriptor = fs.openSync(path.join(runtimeDir, 'conversations.json'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.uid !== directory.uid || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || info.size > MAX_OUTCOME_BYTES) throw fail('CONVERSATION_UNAVAILABLE');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_OUTCOME_BYTES + 1));
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_OUTCOME_BYTES || size > info.size) throw fail('CONVERSATION_UNAVAILABLE');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return null;
    throw fail('CONVERSATION_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createPrimaryConversations(options: PrimaryConversationsOptions): ChatConversationPort {
  let inFlight = false;
  function identity(): ChatNativePrimary | null {
    try { const value = options.readIdentity(); return value ? { ...value } : null; }
    catch { throw fail('CONVERSATION_UNAVAILABLE'); }
  }
  async function request(op: Operation, bound: ChatPrimary, target?: string): Promise<ChatPrimary | ChatConversation[]> {
    if (inFlight) throw fail('BUSY');
    inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + options.budgetMs;
    const remaining = (): number => {
      const value = deadline - performance.now();
      if (value <= 0) throw fail('CONVERSATION_PENDING');
      return value;
    };
    try {
      if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0 || !path.isAbsolute(options.runtimeDir)
        || target !== undefined && !identifier(target)) throw fail('CONVERSATION_UNAVAILABLE');
      const source = identity();
      if (!source || !sameBinding(source, bound)) throw fail('STALE_PRIMARY');
      const requestId = randomUUID();
      const wire = { requestId, op, primary: bare(source),
        ...(op === 'resume' ? { conversationId: target } : op === 'fork' ? { entryId: target } : {}) };
      const work = async (): Promise<ChatPrimary | ChatConversation[]> => {
        // Dispatch exactly once. A transport failure might have delivered it;
        // only explicit reattachment elsewhere may resolve that uncertainty.
        try { await options.dispatch({ ...source }, `/codeflare-conversation ${JSON.stringify(wire)}`); }
        catch { throw fail('CONVERSATION_PENDING'); }
        for (;;) {
          remaining();
          const live = identity();
          if (live && !sameCarrier(source, live)) throw fail('STALE_PRIMARY');
          // A native ID change is expected during replacement, but never proof.
          const outcome = readOutcome(options.runtimeDir);
          if (object(outcome) && outcome.requestId === requestId) {
            if (outcome.op !== op || !object(outcome.from) || outcome.from.sessionId !== source.sessionId
              || outcome.from.generation !== source.generation) throw fail('UNCONFIRMED_ADOPTION');
            if (outcome.status === 'cancelled') throw fail('CONVERSATION_CANCELLED');
            if (outcome.status === 'error') throw fail(typeof outcome.code === 'string' && codes.has(outcome.code) ? outcome.code : 'NATIVE_FAILED');
            if (outcome.status !== 'ok' || !primary(outcome.primary) || !live
              || !sameCarrier(source, outcome.primary) || !sameIdentity(live, outcome.primary)) throw fail('UNCONFIRMED_ADOPTION');
            if (op === 'list' && !sameIdentity(source, live)) throw fail('STALE_PRIMARY');
            const expected = { ...live };
            let confirmed: ChatPrimary;
            try { confirmed = await options.confirm({ ...expected }); }
            catch { throw fail('UNCONFIRMED_ADOPTION'); }
            remaining();
            const actual = identity();
            if (!confirmed || !sameBinding(expected, confirmed) || !actual || !sameIdentity(expected, actual)) {
              throw fail('UNCONFIRMED_ADOPTION');
            }
            return op === 'list' ? metadata(outcome.conversations) : bare(expected);
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining())));
        }
      };
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fail('CONVERSATION_PENDING')), remaining());
      });
      return await Promise.race([work(), expired]);
    } catch (error) {
      const code = object(error) && typeof error.code === 'string' && codes.has(error.code) ? error.code : 'CONVERSATION_UNAVAILABLE';
      throw fail(code);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlight = false;
    }
  }
  return {
    list: bound => request('list', bound) as Promise<ChatConversation[]>,
    new: bound => request('new', bound) as Promise<ChatPrimary>,
    resume: (bound, conversationId) => request('resume', bound, conversationId) as Promise<ChatPrimary>,
    fork: (bound, entryId) => request('fork', bound, entryId) as Promise<ChatPrimary>,
  };
}
