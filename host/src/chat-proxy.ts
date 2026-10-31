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
import type { ChatAuthScope, ChatAuthService } from './chat-auth.js';

export interface ChatPrimary { sessionId: string; generation: number }
export interface ChatConversation {
  id: string;
  name?: string;
  created?: string;
  modified?: string;
  messageCount: number;
}
export interface ChatConversationPort {
  list(bound: ChatPrimary): Promise<ChatConversation[]>;
  new: (bound: ChatPrimary) => Promise<ChatPrimary>;
  resume(bound: ChatPrimary, conversationId: string): Promise<ChatPrimary>;
  fork(bound: ChatPrimary, entryId: string): Promise<ChatPrimary>;
}
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
  providerAuth?: {
    forPrimary(bound: ChatPrimary): { scope: ChatAuthScope; service: ChatAuthService };
    close(): void;
  };
  conversations?: ChatConversationPort;
}
const MAX_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const displayBooleans = new Set(['tokenStatsBar', 'contextUsageBar', 'reasoning', 'toolResults', 'turnMetadata',
  'debugTools', 'keepReasoningOpenUntilTurnEnds', 'toolGroupDefaultCollapsed', 'changeSummaryTable',
  'reserveProcessLineAtIdle', 'showOutOfCwdSessionDiffs', 'reasoningInlineFlow', 'chatMotion']);
function displayPrefs(value: unknown): boolean {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (displayBooleans.has(key)) return typeof entry === 'boolean';
    if (key === 'reasoningAutoCollapseMs') return integer(entry);
    if (key === 'notifyMinLevel') return typeof entry === 'string' && ['all', 'success', 'warnings', 'errors'].includes(entry);
    if (key === 'toolCalls') return object(entry) && keys(entry, ['read', 'bash', 'edit', 'agent', 'generic'])
      && Object.values(entry).every(item => typeof item === 'boolean');
    if (key === 'customEventGroups') return object(entry) && Object.entries(entry).every(([group, enabled]) =>
      text(group, 256) && !['__proto__', 'constructor', 'prototype'].includes(group) && typeof enabled === 'boolean');
    return false;
  });
}
// These stock roads can provision/move the primary or expose a second control
// plane. Conversation controls use the separately authorized adapter, not slash text.
const reservedCommands = new Set(['new', 'resume', 'fork', 'exit', 'quit', 'shutdown', 'restart', 'reload',
  'view', 'flows:new', 'flows:edit', 'flows:delete', 'codeflare-conversation']);
const commandName = (value: unknown): value is string => text(value, 128)
  && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value) && !reservedCommands.has(value.toLowerCase())
  && value.toLowerCase() !== 'dashboard' && !value.toLowerCase().startsWith('dashboard-')
  && !value.toLowerCase().startsWith('__dashboard');
const fileQuery = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
  && !/[\u0000-\u001f\u007f]/.test(value) && !/^(?:[/\\]|[A-Za-z]:)/.test(value)
  && !value.split(/[/\\]/).includes('..');
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
    if (!url.pathname.startsWith(`${prefix}/`)) { req.resume(); reply(res, 404, { error: 'Not found' }); return; }
    const attach = url.pathname === `${prefix}/attach`;
    const question = url.pathname.startsWith(`${prefix}/api/questions/`)
      ? /^([A-Za-z0-9_-]{1,128})(\/answer)?$/.exec(url.pathname.slice(`${prefix}/api/questions/`.length)) : null;
    const relative = url.pathname.slice(prefix.length);
    const provider = /^\/api\/provider-auth\/(providers|status|start|logout|flow\/([A-Za-z0-9_-]{1,128})(\/input)?)$/.exec(relative);
    const conversation = /^\/api\/conversations(?:\/(new|resume|fork))?$/.exec(relative);
    const preferences = relative === '/api/preferences/display';
    const capabilities = relative === '/api/capabilities';
    if (!attach && !question && !provider && !conversation && !preferences && !capabilities) {
      req.resume(); reply(res, 404, { error: 'Not found' }); return;
    }
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
      if (capabilities) {
        req.resume();
        if (req.method !== 'GET') { reply(res, 405, { error: 'Method not allowed' }); return; }
        reply(res, 200, { success: true, data: { controls: true } }); return;
      }
      if (provider) {
        const operation = provider[1];
        const flowId = provider[2];
        const methods = operation === 'start' || operation === 'logout' || provider[3] ? ['POST']
          : flowId ? ['GET', 'DELETE'] : ['GET'];
        if (!methods.includes(req.method ?? '')) { req.resume(); reply(res, 405, { error: 'Method not allowed' }); return; }
        let input: Record<string, unknown> | undefined;
        if (req.method === 'POST') {
          const raw = await body(req);
          if (!object(raw)) { reply(res, 400, { error: 'Invalid authentication request' }); return; }
          input = raw;
          const valid = operation === 'start'
            ? keys(input, ['providerId', 'type']) && text(input.providerId, 128) && typeof input.type === 'string'
              && ['api_key', 'oauth'].includes(input.type)
            : operation === 'logout' ? keys(input, ['providerId']) && text(input.providerId, 128)
              : keys(input, ['stepId', 'value']) && id(input.stepId) && typeof input.value === 'string'
                && input.value.length > 0 && input.value.length <= 16384;
          if (!valid) { reply(res, 400, { error: 'Invalid authentication request' }); return; }
        } else req.resume();
        if (!current(bound)) { reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return; }
        const auth = options.providerAuth?.forPrimary(bound);
        if (!auth) { reply(res, 503, { error: 'Provider authentication unavailable' }); return; }
        let data: unknown;
        if (operation === 'providers') data = await auth.service.providers(auth.scope);
        else if (operation === 'status') data = await auth.service.status(auth.scope);
        else if (operation === 'start') data = await auth.service.start(auth.scope, input!);
        else if (operation === 'logout') await auth.service.logout(auth.scope, input!);
        else if (provider[3]) await auth.service.input(auth.scope, flowId!, input!);
        else if (req.method === 'DELETE') await auth.service.cancel(auth.scope, flowId!);
        else data = await auth.service.flow(auth.scope, flowId!);
        if (!current(bound)) { reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return; }
        if (req.method !== 'GET') options.recordInput();
        reply(res, 200, { success: true, data: data ?? null }); return;
      }
      if (conversation) {
        const action = conversation[1];
        if (req.method !== (action ? 'POST' : 'GET')) { req.resume(); reply(res, 405, { error: 'Method not allowed' }); return; }
        if (!options.conversations) { req.resume(); reply(res, 503, { error: 'Conversation controls unavailable' }); return; }
        if (!action) {
          req.resume();
          const rows = await options.conversations.list(bound);
          if (!current(bound)) { reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return; }
          reply(res, 200, { success: true, data: rows }); return;
        }
        const input = await body(req);
        if (!object(input) || !keys(input, action === 'new' ? ['sessionId']
          : action === 'resume' ? ['sessionId', 'conversationId'] : ['sessionId', 'entryId'])
          || !id(input.sessionId) || action === 'resume' && !id(input.conversationId)
          || action === 'fork' && !id(input.entryId)) {
          reply(res, 400, { error: 'Invalid conversation request' }); return;
        }
        if (input.sessionId !== bound.sessionId || !current(bound)) {
          reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return;
        }
        const adopted = action === 'new' ? await options.conversations.new(bound)
          : action === 'resume' ? await options.conversations.resume(bound, input.conversationId as string)
            : await options.conversations.fork(bound, input.entryId as string);
        if (!current(adopted)) { reply(res, 409, { error: 'Conversation adoption is unconfirmed; reopen Chat' }); return; }
        options.recordInput();
        reply(res, 200, { sessionId: adopted.sessionId, generation: adopted.generation }); return;
      }
      if (preferences) {
        if (req.method !== 'GET' && req.method !== 'PATCH') { req.resume(); reply(res, 405, { error: 'Method not allowed' }); return; }
        let input: unknown;
        if (req.method === 'PATCH') {
          input = await body(req);
          if (!displayPrefs(input)) { reply(res, 400, { error: 'Invalid display preferences' }); return; }
        } else req.resume();
        if (!current(bound)) { reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return; }
        const response = await privateRequest(req.method, '/api/preferences/display', input);
        if (!current(bound)) { reply(res, 409, { error: 'Primary Pi changed; reopen Chat' }); return; }
        if (response.status !== 200 || !object(response.data)
          || response.data.displayPrefs !== undefined && !displayPrefs(response.data.displayPrefs)) {
          reply(res, 502, { error: 'Chat display preferences unavailable' }); return;
        }
        if (req.method === 'PATCH') options.recordInput();
        reply(res, 200, { success: true, data: response.data.displayPrefs ?? null }); return;
      }
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
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const failures: Record<string, [number, string]> = {
        invalid_auth_request: [400, 'Invalid authentication request'], invalid_auth_input: [400, 'Invalid sign-in input'],
        stale_auth_scope: [409, 'Pi binding changed; reopen Chat'], auth_closed: [409, 'Authentication closed; reopen Chat'],
        auth_unavailable: [503, 'Provider authentication unavailable'], auth_provider_unavailable: [404, 'Provider unavailable'],
        auth_method_unavailable: [400, 'Sign-in method unavailable'], auth_flow_not_found: [404, 'Sign-in flow not found'],
        auth_not_waiting: [409, 'Sign-in is not waiting for input'], stale_auth_step: [409, 'Sign-in step changed; refresh its state'],
        auth_flow_conflict: [409, 'Sign-in is already in progress'], personal_auth_forbidden: [403, 'Personal providers are managed by your organization'],
        BUSY: [423, 'Pi has active or queued work; finish it before changing conversations'],
        STALE_PRIMARY: [409, 'Pi binding changed; reopen Chat'], NOT_FOUND: [404, 'Conversation not found'],
        INVALID_FORK: [400, 'This message cannot be forked'], INVALID_REQUEST: [400, 'Invalid conversation request'],
        NATIVE_FAILED: [502, 'Native conversation operation failed'], UNCONFIRMED_ADOPTION: [409, 'Conversation adoption is unconfirmed; reopen Chat'],
        CONVERSATION_CANCELLED: [409, 'Conversation change cancelled'], CONVERSATION_UNAVAILABLE: [503, 'Conversation controls unavailable'],
        CONVERSATION_PENDING: [503, 'Conversation outcome is uncertain; reopen Chat to confirm the current conversation, do not resend'],
      };
      const code = object(error) && typeof error.code === 'string' ? error.code : '';
      if (Object.hasOwn(failures, code)) {
        const [status, message] = failures[code];
        reply(res, status, { error: message, code });
      } else if (error instanceof SyntaxError) reply(res, 400, { error: 'Invalid JSON body' });
      else reply(res, attach ? 503 : 502, { error: 'Chat unavailable; primary readiness or private transport failed' });
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
        const commands = new Set<string>();
        const flows = new Set<string>();
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
          const slash = typeof msg.text === 'string' && msg.text.startsWith('/') ? msg.text.slice(1).split(/\s/, 1)[0] : undefined;
          let allowed = false; let human = false;
          switch (msg.type) {
            case 'subscribe': allowed = keys(msg, ['type', 'sessionId', 'lastSeq']) && (msg.lastSeq === undefined || integer(msg.lastSeq)); break;
            case 'unsubscribe': case 'abort': allowed = keys(msg, ['type', 'sessionId']); human = msg.type === 'abort'; break;
            case 'request_models': case 'request_commands': allowed = keys(msg, ['type', 'sessionId']); break;
            case 'set_model':
              allowed = keys(msg, ['type', 'sessionId', 'provider', 'modelId']) && text(msg.provider, 128) && text(msg.modelId, 512);
              human = true; break;
            case 'set_thinking_level':
              allowed = keys(msg, ['type', 'sessionId', 'level']) && typeof msg.level === 'string'
                && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(msg.level);
              human = true; break;
            case 'list_files': allowed = keys(msg, ['type', 'sessionId', 'query']) && fileQuery(msg.query); break;
            case 'edit_followup_entry':
              allowed = keys(msg, ['type', 'sessionId', 'index', 'text']) && integer(msg.index)
                && typeof msg.text === 'string' && msg.text.length <= MAX_BYTES;
              human = true; break;
            case 'remove_followup_entry': case 'promote_followup_entry':
              allowed = keys(msg, ['type', 'sessionId', 'index']) && integer(msg.index); human = true; break;
            case 'clear_followup_entries':
              allowed = keys(msg, ['type', 'sessionId', 'indices'])
                && (msg.indices === 'all' || Array.isArray(msg.indices) && msg.indices.every(integer));
              human = true; break;
            case 'retry_session': case 'force_kill': case 'stop_after_turn':
              allowed = keys(msg, ['type', 'sessionId']); human = true; break;
            case 'setSessionDisplayPrefs':
              allowed = keys(msg, ['type', 'sessionId', 'override']) && Object.hasOwn(msg, 'override')
                && (msg.override === null || displayPrefs(msg.override));
              human = true; break;
            case 'history_backfill': allowed = keys(msg, ['type', 'sessionId', 'fromSeq', 'toSeq'])
              && integer(msg.fromSeq) && integer(msg.toSeq) && msg.fromSeq <= msg.toSeq; break;
            case 'prompt_resync_request': allowed = keys(msg, ['type', 'sessionId', 'requestId']) && (msg.requestId === undefined || id(msg.requestId)); break;
            case 'send_prompt':
              allowed = keys(msg, ['type', 'sessionId', 'text', 'images', 'delivery']) && typeof msg.text === 'string'
                // Only fresh advertised commands may use stock dispatch; never
                // turn arbitrary slash text into provisioning or a second owner.
                && (!msg.text.trimStart().startsWith('/') || typeof slash === 'string'
                  && commandName(slash) && (commands.has(slash) || flows.has(slash)))
                && !msg.text.trimStart().startsWith('!')
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
          if (!allowed || msg.type !== 'send_prompt' && Buffer.byteLength(bytes.toString()) > MAX_BYTES) { stop(); return; }
          upstream.send(JSON.stringify(msg));
          if (human) options.recordInput();
        });
        upstream.on('message', (bytes, binary) => {
          if (!stillBound()) { stop(4002); return; }
          if (binary || client.bufferedAmount > MAX_UPSTREAM_BYTES) { stop(); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(bytes.toString()); } catch { stop(1011); return; }
          if (!object(parsed)) return;
          let msg: Record<string, unknown> = parsed;
          if (msg.type === 'display_prefs_updated') {
            if (displayPrefs(msg.prefs)) client.send(JSON.stringify({ type: msg.type, prefs: msg.prefs }));
            return;
          }
          if (msg.sessionId === bound!.sessionId && (msg.type === 'commands_list' || msg.type === 'flows_list')) {
            const field = msg.type === 'commands_list' ? 'commands' : 'flows';
            const entries = msg[field];
            if (!Array.isArray(entries)) return;
            const rows = entries.filter((row: unknown) => object(row) && commandName(row.name)
              && (field === 'commands' || commandName(`flows:${row.name}`)));
            const catalog = msg.type === 'commands_list' ? commands : flows;
            catalog.clear();
            for (const row of rows) catalog.add((row as Record<string, string>).name);
            msg = { ...msg, [field]: rows };
          }
          // Stock send_prompt has an ended-session reopen road. Never leave a
          // browser connection armed after observing that its primary ended.
          if (msg.sessionId === bound!.sessionId && (msg.type === 'session_removed'
            || msg.type === 'session_updated' && object(msg.updates) && (msg.updates.status === 'ended' || msg.updates.resuming === true))) {
            client.send(JSON.stringify(msg));
            stop(4002); return;
          }
          if (msg.type === 'questions_update' && Array.isArray(msg.questions)) {
            msg = { type: 'questions_update', questions: msg.questions.filter(q => object(q) && q.sessionId === bound!.sessionId) };
          } else if (msg.type === 'sessions_snapshot' && Array.isArray(msg.sessions)) {
            if (msg.sessions.some(s => object(s) && s.id === bound!.sessionId && (s.status === 'ended' || s.resuming === true))) { stop(4002); return; }
            msg = { type: 'sessions_snapshot', sessions: msg.sessions.filter(s => object(s) && s.id === bound!.sessionId),
              orders: {}, endedTotals: {}, archivedCountByCwd: {} };
          } else if (msg.type === 'session_added' && object(msg.session) && msg.session.id === bound!.sessionId) {
            // The embedded reducer may use the bound row; never expose global registry rows.
          } else {
            if (msg.sessionId !== bound!.sessionId) return;
            if (!['event', 'event_replay', 'session_updated', 'session_removed', 'session_state_reset', 'history_window',
              'history_backfill_result', 'asset_register', 'prompt_request', 'prompt_dismiss', 'prompt_cancel',
              'extension_ui_request', 'ui_dismiss', 'prompt_received', 'queue_update', 'notify', 'models_list', 'commands_list',
              'flows_list', 'files_list', 'force_kill_result', 'command_feedback', 'error'].includes(String(msg.type))) return;
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
        upstream.on('close', () => client.close(stillBound() ? 1012 : 4002, 'Private Chat transport disconnected'));
        upstream.on('error', () => stop(1011));
      });
    });
    upstream.on('error', () => { if (!socket.destroyed) socket.destroy(); });
    upstream.once('close', () => { backends.delete(upstream); if (!socket.destroyed) socket.end(); });
    socket.once('close', () => upstream.terminate());
  }
  return { handleHttp, handleUpgrade, close() {
    closed = true;
    options.providerAuth?.close();
    for (const ws of wss.clients) ws.terminate();
    for (const ws of backends) ws.terminate();
    wss.close();
  } };
}
