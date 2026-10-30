/** Primary-only boundary in front of Dashboard 0.11.0 (f93a27812534).
 * Transport stays stock: CLI server, /ws, and the documented question REST roads.
 * Wire contracts: shared/src/browser-protocol.ts, types.ts, question-types.ts.
 * No session provisioning, private gateway imports, prompt bus, or replay owner.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Session } from './session.js';
import { AGENT_EVENT_LIMITS } from './agent-events.js';

export interface ChatPrimary { sessionId: string; generation: number }
export interface ChatPort {
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}
interface ChatOptions {
  cfid: string;
  generation: number | null;
  primary(): ChatPrimary | null;
  ensurePrimary(): Promise<ChatPrimary>;
  upstream: { port: number; token(): string };
  recordInput(): void;
  notificationSession?(): Session | undefined;
}
const MAX_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const images = (value: unknown): boolean => value === undefined || Array.isArray(value) && value.length <= 10
  && value.every(image => object(image) && keys(image, ['type', 'data', 'mimeType']) && image.type === 'image'
    && typeof image.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    && typeof image.mimeType === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType));

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req: http.IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BYTES) throw new Error('Chat request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createChatProxy(options: ChatOptions): ChatPort & { close(): void } {
  const prefix = `/api/chat/${options.cfid}`;
  // Chat carries documented base64 images, unlike /terminal's 64KB input frames.
  // Bound complete frames and bridge buffers; HTTP bodies retain the API's 64KB cap.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_UPSTREAM_BYTES });
  const backends = new Set<WebSocket>();
  let closed = false;
  let attaching: Promise<ChatPrimary> | undefined;
  const configured = (): boolean => /^[a-z0-9]{8,24}$/.test(options.cfid)
    && integer(options.generation);
  const current = (bound: ChatPrimary): boolean => {
    const live = options.primary();
    return !closed && live?.sessionId === bound.sessionId && live.generation === bound.generation
      && bound.generation === options.generation;
  };
  function authority(req: http.IncomingMessage, url: URL, requireQuery = false): number {
    if (!configured() || closed) return 503;
    if (req.headers['x-codeflare-chat-generation'] !== String(options.generation)) return 409;
    const params = [...url.searchParams];
    if (params.some(([name]) => name !== 'generation') || params.length > 1
      || (requireQuery || params.length > 0) && url.searchParams.get('generation') !== String(options.generation)) return 409;
    return 0;
  }
  function privateRequest(method: string, path: string, input?: unknown): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      let token: string;
      try { token = options.upstream.token(); if (!token) throw new Error('missing credential'); }
      catch { reject(new Error('Private Chat transport unavailable')); return; }
      const request = http.request({ host: '127.0.0.1', port: options.upstream.port, path, method,
        headers: { 'x-pi-local-token': token, 'content-type': 'application/json' }, timeout: 5000,
      }, response => {
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPSTREAM_BYTES) { response.destroy(); reject(new Error('Oversized Chat response')); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode ?? 502, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { reject(new Error('Invalid Chat response')); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Chat transport timed out')));
      request.on('error', reject);
      request.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://container');
    const attach = url.pathname === `${prefix}/attach`;
    const question = url.pathname.startsWith(`${prefix}/api/questions/`)
      ? /^([A-Za-z0-9_-]{1,128})(\/answer)?$/.exec(url.pathname.slice(`${prefix}/api/questions/`.length)) : null;
    if (!attach && !question) { req.resume(); reply(res, 404, { error: 'Not found' }); return; }
    const denied = authority(req, url);
    if (denied) {
      req.resume(); reply(res, denied, { error: denied === 503
        ? 'Chat runtime authority unavailable (CODEFLARE_CHAT_GENERATION required)' : 'Stale Chat generation' }); return;
    }
    try {
      if (attach) {
        if (req.method !== 'POST') { req.resume(); reply(res, 405, { error: 'Method not allowed' }); return; }
        const input = await body(req);
        if (!object(input) || Object.keys(input).length !== 1 || input.generation !== options.generation) {
          reply(res, 400, { error: 'Expected exactly {generation}' }); return;
        }
        // Coalesce ONLY explicit entry. Reads and WS reconnect never call ensure.
        attaching ??= options.ensurePrimary().finally(() => { attaching = undefined; });
        const bound = await attaching;
        if (!current(bound)) { reply(res, 409, { error: 'Primary Pi is no longer live' }); return; }
        reply(res, 200, bound); return;
      }
      const bound = options.primary();
      if (!bound || !current(bound)) { req.resume(); reply(res, 409, { error: 'Primary Pi is not live; attach explicitly' }); return; }
      const path = `/api/questions/${question![1]}`;
      if (req.method !== (question![2] ? 'POST' : 'GET')) { req.resume(); reply(res, 405, { error: 'Method not allowed' }); return; }
      let input: unknown;
      if (question![2]) {
        input = await body(req);
        if (!object(input) || Object.keys(input).length !== 1
          || !(typeof input.answer === 'string' || input.cancelled === true)) {
          reply(res, 400, { error: 'Expected {answer} or {cancelled:true}; automatic authority is not browser supplied' }); return;
        }
      }
      // Resolve ownership on EVERY request, before answering. Do not trust an opaque browser id.
      const detail = await privateRequest('GET', path);
      const envelope = detail.data;
      if (detail.status !== 200 || !object(envelope) || envelope.success !== true || !object(envelope.data)
        || envelope.data.sessionId !== bound.sessionId || !current(bound)) {
        reply(res, 404, { error: 'Question not found' }); return;
      }
      if (!question![2]) { reply(res, 200, envelope); return; }
      if (envelope.data.answerable !== true || envelope.data.origin === 'file') {
        reply(res, 403, { error: 'Question requires its owning approval surface' }); return;
      }
      const answer = await privateRequest('POST', `${path}/answer`, input);
      if (answer.status === 200 && object(answer.data) && answer.data.success === true) options.recordInput();
      reply(res, answer.status, answer.data);
    } catch {
      if (!res.headersSent && !res.destroyed) reply(res, attach ? 503 : 502, { error: 'Chat unavailable; primary readiness or private transport failed' });
    }
  }
  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://container');
    const bound = options.primary();
    const denied = url.pathname !== `${prefix}/ws` ? 404 : authority(req, url, true)
      || (!bound || !current(bound) ? 409 : 0);
    if (denied) { socket.end(`HTTP/1.1 ${denied} Chat Unavailable\r\nConnection: close\r\n\r\n`); return; }
    let upstream: WebSocket;
    try {
      const token = options.upstream.token(); if (!token) throw new Error('missing credential');
      upstream = new WebSocket(`ws://127.0.0.1:${options.upstream.port}/ws`, {
        headers: { 'x-pi-local-token': token }, maxPayload: MAX_UPSTREAM_BYTES, handshakeTimeout: 5000,
      });
    } catch { socket.end('HTTP/1.1 503 Chat Unavailable\r\nConnection: close\r\n\r\n'); return; }
    backends.add(upstream);
    // Do not acknowledge browser readiness until the stock connection is ready.
    upstream.once('open', () => {
      if (!current(bound!) || socket.destroyed) { upstream.terminate(); return; }
      wss.handleUpgrade(req, socket, head, client => {
        const prompts = new Set<string>(); const dialogs = new Set<string>();
        const stop = (code = 1008): void => { client.close(code, 'Chat binding or operation unavailable'); upstream.close(); };
        const stillBound = (): boolean => current(bound!);
        const notifications = options.notificationSession?.();
        const unregister = notifications?.registerAgentEventClient(client, stillBound);
        client.once('close', () => unregister?.());
        client.once('error', () => unregister?.());
        // No host queue/replay: client must wait for OPEN; stock owns pending input.
        client.on('message', (bytes, binary) => {
          if (binary || !stillBound() || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_UPSTREAM_BYTES) { stop(); return; }
          let msg: unknown;
          try { msg = JSON.parse(bytes.toString()); } catch { stop(); return; }
          if (!object(msg) || msg.sessionId !== bound!.sessionId || typeof msg.type !== 'string') { stop(); return; }
          // Host-only frames use the same authenticated bound socket, never the
          // upstream protocol or its replay/outbox. Draft text is not accepted.
          if (msg.type === 'chat-input' || msg.type === 'agent-event-disposition' || msg.type === 'agent-event-displayed') {
            if (Buffer.byteLength(bytes.toString()) > AGENT_EVENT_LIMITS.maxFrameBytes) { stop(); return; }
            if (msg.type === 'chat-input') {
              if (!keys(msg, ['type', 'sessionId'])) { stop(); return; }
              options.recordInput(); return;
            }
            if (typeof msg.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.eventId)) { stop(); return; }
            if (msg.type === 'agent-event-disposition') {
              if (!keys(msg, ['type', 'sessionId', 'eventId', 'disposition'])
                || (msg.disposition !== 'suppress' && msg.disposition !== 'display-request')) { stop(); return; }
              notifications?.submitAgentEventDisposition(msg.eventId, client, msg.disposition);
            } else {
              if (!keys(msg, ['type', 'sessionId', 'eventId'])) { stop(); return; }
              notifications?.confirmAgentEventDisplay(msg.eventId, client);
            }
            return;
          }
          let allowed = false; let human = false;
          switch (msg.type) {
            case 'subscribe': allowed = keys(msg, ['type', 'sessionId', 'lastSeq']) && (msg.lastSeq === undefined || integer(msg.lastSeq)); break;
            case 'unsubscribe': case 'abort': allowed = keys(msg, ['type', 'sessionId']); human = msg.type === 'abort'; break;
            case 'history_backfill': allowed = keys(msg, ['type', 'sessionId', 'fromSeq', 'toSeq'])
              && integer(msg.fromSeq) && integer(msg.toSeq) && msg.fromSeq <= msg.toSeq; break;
            case 'prompt_resync_request': allowed = keys(msg, ['type', 'sessionId', 'requestId']) && (msg.requestId === undefined || id(msg.requestId)); break;
            case 'send_prompt':
              allowed = keys(msg, ['type', 'sessionId', 'text', 'images', 'delivery']) && typeof msg.text === 'string'
                // Slash commands are control/provisioning roads in stock, not ordinary prompts.
                && !msg.text.trimStart().startsWith('/') && !msg.text.trimStart().startsWith('!')
                && (msg.text.trim().length > 0 || Array.isArray(msg.images) && msg.images.length > 0)
                && images(msg.images) && (msg.delivery === undefined || msg.delivery === 'steer' || msg.delivery === 'followUp');
              human = true; break;
            case 'prompt_response':
              allowed = keys(msg, ['type', 'sessionId', 'promptId', 'answer', 'cancelled', 'source', 'images'])
                && id(msg.promptId) && prompts.has(msg.promptId) && msg.source === 'dashboard-default'
                && (typeof msg.answer === 'string' && msg.cancelled === undefined || msg.answer === undefined && msg.cancelled === true)
                && images(msg.images); human = true; break;
            case 'extension_ui_response':
              // result is deliberately unknown in the pinned public contract. Only a live native request may receive it.
              allowed = keys(msg, ['type', 'sessionId', 'requestId', 'result', 'cancelled']) && id(msg.requestId)
                && dialogs.has(msg.requestId) && (msg.cancelled === undefined || typeof msg.cancelled === 'boolean'); human = true; break;
          }
          if (!allowed) { stop(); return; }
          upstream.send(JSON.stringify(msg));
          if (human) options.recordInput();
        });
        upstream.on('message', (bytes, binary) => {
          if (binary || !stillBound() || client.bufferedAmount > MAX_UPSTREAM_BYTES) { stop(); return; }
          let msg: unknown;
          try { msg = JSON.parse(bytes.toString()); } catch { stop(1011); return; }
          if (!object(msg)) return;
          // Stock send_prompt has an ended-session reopen road. Never leave a
          // browser connection armed after observing that its primary ended.
          if (msg.sessionId === bound!.sessionId && (msg.type === 'session_removed'
            || msg.type === 'session_updated' && object(msg.updates) && (msg.updates.status === 'ended' || msg.updates.resuming === true))) {
            stop(); return;
          }
          if (msg.type === 'questions_update' && Array.isArray(msg.questions)) {
            msg = { type: 'questions_update', questions: msg.questions.filter(q => object(q) && q.sessionId === bound!.sessionId) };
          } else if (msg.type === 'sessions_snapshot' && Array.isArray(msg.sessions)) {
            if (msg.sessions.some(s => object(s) && s.id === bound!.sessionId && (s.status === 'ended' || s.resuming === true))) { stop(); return; }
            msg = { type: 'sessions_snapshot', sessions: msg.sessions.filter(s => object(s) && s.id === bound!.sessionId),
              orders: {}, endedTotals: {}, archivedCountByCwd: {} };
          } else if (msg.type === 'session_added' && object(msg.session) && msg.session.id === bound!.sessionId) {
            // The embedded reducer may use the bound row; never expose global registry rows.
          } else {
            if (msg.sessionId !== bound!.sessionId) return;
            if (!['event', 'event_replay', 'session_updated', 'session_removed', 'session_state_reset', 'history_window',
              'history_backfill_result', 'asset_register', 'prompt_request', 'prompt_dismiss', 'prompt_cancel',
              'extension_ui_request', 'ui_dismiss', 'prompt_received', 'queue_update', 'notify'].includes(String(msg.type))) return;
            if (msg.type === 'prompt_request' && id(msg.promptId)) prompts.add(msg.promptId);
            if ((msg.type === 'prompt_dismiss' || msg.type === 'prompt_cancel') && id(msg.promptId)) prompts.delete(msg.promptId);
            if (msg.type === 'extension_ui_request' && id(msg.requestId)) dialogs.add(msg.requestId);
            if (msg.type === 'ui_dismiss' && id(msg.requestId)) dialogs.delete(msg.requestId);
            if (prompts.size + dialogs.size > 256) { stop(); return; }
          }
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
        });
        client.on('error', () => upstream.terminate());
        client.on('close', () => upstream.close());
        upstream.on('close', () => client.close(1012, 'Private Chat transport disconnected'));
        upstream.on('error', () => stop(1011));
      });
    });
    upstream.on('error', () => { if (!socket.destroyed) socket.destroy(); });
    upstream.once('close', () => { backends.delete(upstream); if (!socket.destroyed) socket.end(); });
    socket.once('close', () => upstream.terminate());
  }
  return { handleHttp, handleUpgrade, close() {
    closed = true;
    for (const ws of wss.clients) ws.terminate();
    for (const ws of backends) ws.terminate();
    wss.close();
  } };
}
