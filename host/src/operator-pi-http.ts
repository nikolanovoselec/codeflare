/**
 * Narrow authenticated host API for the parent-owned Pi conversation.
 * The outer request router owns container authentication; this controller owns
 * only fixed methods/paths, bounded JSON and projection-safe responses.
 */
import type { OperatorPiConversation } from './operator-pi.js';

export interface OperatorPiHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const PREFIX = '/internal/operator/pi/';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BODY = 64 * 1024;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function result(status: number, value: unknown): OperatorPiHttpResult {
  return { status, headers: HEADERS, body: JSON.stringify(value) };
}

function parseBody(body: Uint8Array | undefined): Record<string, unknown> {
  if (!body || body.byteLength > MAX_BODY) throw new Error(body && body.byteLength > MAX_BODY ? 'oversized' : 'invalid');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error('invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  return value as Record<string, unknown>;
}

function isEmpty(value: Record<string, unknown>): boolean { return Object.keys(value).length === 0; }

export class OperatorPiHttpController {
  constructor(private readonly conversation: OperatorPiConversation) {}

  async handle(input: { method: string; pathname: string; query?: URLSearchParams; body?: Uint8Array }): Promise<OperatorPiHttpResult | null> {
    if (!input.pathname.startsWith(PREFIX)) return null;
    if (input.body && input.body.byteLength > MAX_BODY) return result(413, { error: 'Request body too large', code: 'REQUEST_TOO_LARGE' });
    try {
      if (input.pathname === `${PREFIX}ensure`) {
        if (input.method !== 'POST') return this.methodNotAllowed();
        if (!isEmpty(parseBody(input.body))) return this.invalid();
        const identity = await this.conversation.ensure();
        return result(200, { conversationId: identity.conversationId, ready: true });
      }
      if (input.pathname === `${PREFIX}tasks`) {
        if (input.method !== 'POST') return this.methodNotAllowed();
        const body = parseBody(input.body);
        const keys = Object.keys(body);
        const valid = keys.length === 4 && keys.every(key => ['taskId', 'digest', 'text', 'mode'].includes(key))
          && typeof body.taskId === 'string' && ID.test(body.taskId)
          && typeof body.digest === 'string' && DIGEST.test(body.digest)
          && typeof body.text === 'string' && body.text.trim().length > 0
          && new TextEncoder().encode(body.text).byteLength <= 32 * 1024
          && (body.mode === 'prompt' || body.mode === 'follow-up' || body.mode === 'steer');
        if (!valid) return this.invalid();
        const taskId = body.taskId as string;
        const task = await this.conversation.send({ taskId, digest: body.digest as string,
          text: body.text as string, mode: body.mode as 'prompt' | 'follow-up' | 'steer' });
        return result(202, { taskId, status: task.status });
      }
      if (input.pathname === `${PREFIX}events`) {
        if (input.method !== 'GET') return this.methodNotAllowed();
        const query = input.query ?? new URLSearchParams();
        if ([...query.keys()].some(key => key !== 'cursor')) return this.invalid();
        const raw = query.get('cursor') ?? '0';
        if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return this.invalid();
        const cursor = Number(raw);
        if (!Number.isSafeInteger(cursor)) return this.invalid();
        return result(200, this.conversation.observe(cursor));
      }
      const abortMatch = input.pathname.match(/^\/internal\/operator\/pi\/tasks\/([A-Za-z0-9_-]{1,128})\/abort$/);
      if (abortMatch) {
        if (input.method !== 'POST') return this.methodNotAllowed();
        if (!isEmpty(parseBody(input.body))) return this.invalid();
        const taskId = abortMatch[1];
        const task = await this.conversation.abort(taskId);
        return result(200, { taskId, status: task.status });
      }
      return result(404, { error: 'Unknown structured Pi operation', code: 'PI_ROUTE_NOT_FOUND' });
    } catch (error) {
      if (error instanceof Error && error.message === 'oversized') return result(413, { error: 'Request body too large', code: 'REQUEST_TOO_LARGE' });
      if (error instanceof Error && error.message === 'invalid') return this.invalid();
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('not found')) return result(404, { error: 'Structured Pi task not found', code: 'PI_TASK_NOT_FOUND' });
      if (message.includes('conflict') || message.includes('busy') || message.includes('queue')
        || message.includes('pending') || message.includes('lost')) {
        return result(409, { error: 'Structured Pi operation conflicts with current state', code: 'PI_OPERATION_CONFLICT' });
      }
      if (message.startsWith('invalid') || message.includes('requires an active run')) return this.invalid();
      return result(500, { error: 'Structured Pi operation failed', code: 'PI_OPERATION_FAILED' });
    }
  }

  private invalid(): OperatorPiHttpResult {
    return result(400, { error: 'Invalid structured Pi request', code: 'PI_REQUEST_INVALID' });
  }

  private methodNotAllowed(): OperatorPiHttpResult {
    return result(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
}
