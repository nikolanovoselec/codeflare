import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { PI_WEB_PORT } from './pi-web-services.js';
import type { PiWebRuntime } from './pi-web-runtime.js';

const hostname = '127.0.0.1';
const root = `http://${hostname}:${PI_WEB_PORT}`;
const maxBody = 1024 * 1024;
const maxAttachmentBytes = 10_000_000;
const maxAttachmentBody = 14 * 1024 * 1024; // Base64 plus bounded JSON metadata.
class BodyTooLarge extends Error {}
const requestIdPattern = /^[a-f0-9-]{36}$/i;
const settlers = new Set(['abort', 'ask/submit', 'ask/cancel', 'dialogs/answer', 'dialogs/cancel', 'commands/respond']);
const sessionMutations = new Set(['prompt', 'commands/run', ...settlers, 'queue/message', 'queue/clear', 'unread', 'unread/acknowledge',
  'warnings/dismiss', 'notifications/dismiss', 'notifications/dismiss-all', 'model', 'model/cycle',
  'models/enabled', 'models/scope', 'defaults', 'thinking-level', 'thinking-level/cycle', 'tree/navigate', 'attachments']);

function send(res: ServerResponse, code: number, data: object, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(code, { ...headers, 'content-type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(stream: IncomingMessage, limit = maxBody): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // An over-limit upload must be able to receive a 413 without destroying its socket.
  const input = limit === maxAttachmentBody ? stream.iterator({ destroyOnReturn: false }) : stream;
  for await (const part of input) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

async function jsonBody(req: IncomingMessage, limit = maxBody): Promise<Record<string, unknown>> {
  const body = await readJson(req, limit);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Pi web request');
  return body as Record<string, unknown>;
}

function validateAttachmentSize(attachments: unknown): void {
  if (!Array.isArray(attachments) || attachments.length > 16) throw new Error('Invalid attachments');
  let bytes = 0;
  for (const item of attachments) {
    const data: unknown = item?.data;
    if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error('Invalid base64 attachment');
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    bytes += data.length / 4 * 3 - padding;
    if (bytes > maxAttachmentBytes) throw new BodyTooLarge();
  }
}

// REQ-AGENT-272 AC5: no scoped browser request owns a transcript or starts a runtime.
export function createPiWebProxy(options: { sessionId: string; runtime: PiWebRuntime; recordInput(): void }) {
  const { sessionId, runtime } = options;
  const prefix = `/api/pi-web/${sessionId}/`;
  const appPrefix = `${prefix}g/${runtime.generation}/`;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBody });
  let closed = false;
  const sockets = new Set<WebSocket>();
  runtime.onRevokeAttachment(() => {
    for (const socket of sockets) socket.terminate();
    for (const client of wss.clients) client.terminate();
  });

  function route(req: IncomingMessage): URL | undefined {
    const raw = req.url;
    if (closed || req.headers['x-codeflare-pi-generation'] !== String(runtime.generation) || !raw?.startsWith(prefix)) return;
    const control = raw.slice(prefix.length).split('?')[0];
    const scoped = runtime.attachment && `${appPrefix}a/${runtime.attachment}/`;
    const target = control === '_switch' || control === '_cancel' ? raw.slice(prefix.length)
      : scoped && raw.startsWith(scoped) ? raw.slice(scoped.length) : undefined;
    if (target === undefined) return;
    const path = target.split('?')[0];
    if (path.startsWith('/') || /%2f|%5c|%2e|[\\\x00-\x20\x7f]|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path)) return;
    // URL parsing is only for route and query matching. Downstream dials use
    // a fixed authority, never a request-derived URL.
    return new URL(`/${target}`, root);
  }

  function publicOrigin(req: IncomingMessage): string | undefined {
    const host = req.headers['x-forwarded-host'];
    const proto = req.headers['x-forwarded-proto'];
    if (typeof host !== 'string' || (proto !== 'https' && proto !== 'http')) return;
    try {
      const url = new URL(`${proto}://${host}`);
      if (url.host === host && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) {
        return url.origin;
      }
    } catch { /* Refuse damaged canonical forwarding metadata. */ }
  }

  const browserPath = (pathname: string) => pathname.replace(/^\/api\/machines\/local(?=\/)/, '/api');

  function isScoped(path: string, url: URL): boolean {
    if (/^\/api\/machines\/[^/]+\//.test(path) || path === '/api/sessions/') return false;
    if (url.searchParams.has('cwd') && (url.searchParams.getAll('cwd').length !== 1 || url.searchParams.get('cwd') !== runtime.cwd)) return false;
    const matched = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(path);
    if (matched && (matched[1] !== runtime.binding?.id && !(matched[1] === 'events' && path === '/api/sessions/events'))) return false;
    // Catalog discovery must not disclose an unrelated workspace or past row.
    const catalog = /^(\/api\/plugin-catalog\/projects\/[^/]+\/workspaces\/[^/]+\/sessions)(?:\/([^/]+))?\/?$/.exec(path);
    return !catalog || path === runtime.catalogPath || path === catalog[1] && runtime.catalogPath?.startsWith(`${catalog[1]}/`) === true;
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    if (req.method === 'GET' && path === '/_switch') {
      if (url.searchParams.get('generation') !== String(runtime.generation)) { send(res, 409, { error: 'Stale Pi workspace' }); return; }
      send(res, 200, runtime.status());
      return;
    }
    if (req.method !== 'POST' || url.search) { send(res, 405, { error: 'Unsupported Pi handoff request' }); return; }
    const { generation, requestId, target } = await jsonBody(req);
    if (generation !== runtime.generation || typeof requestId !== 'string' || !requestIdPattern.test(requestId)) {
      send(res, 409, { error: 'Invalid Pi handoff identity' }); return;
    }
    if (path === '/_cancel') {
      const cancelled = runtime.handoff.cancel({ generation, requestId });
      send(res, cancelled ? 200 : 409, runtime.status());
      return;
    }
    if (target !== 'terminal' && target !== 'chat') { send(res, 400, { error: 'Unknown Pi surface' }); return; }
    const status = runtime.status();
    if (runtime.legacyHerdr || (status.phase === 'opening' || status.phase === 'failed') && !status.requestId) {
      send(res, 409, status); return;
    }
    let rejected = false;
    // The switch keeps running if the browser disconnects. Admission changes
    // synchronously; wait one microtask for an immediate validation failure.
    void runtime.handoff.switchTo({ generation, target, requestId }).catch(() => { rejected = true; });
    await Promise.resolve();
    send(res, rejected ? 409 : 202, runtime.status());
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = route(req);
    const origin = publicOrigin(req);
    if (!url || !origin) { send(res, 409, { error: 'Pi workspace unavailable' }); return; }
    const path = browserPath(url.pathname);
    if (path === '/_switch' || path === '/_cancel') {
      if (req.url?.startsWith(appPrefix)) { send(res, 409, { error: 'Pi workspace unavailable' }); return; }
      try { await control(req, res, path, url); }
      catch { send(res, 400, { error: 'Invalid Pi handoff request' }); }
      return;
    }
    if (path === '/_intent') {
      if (req.method !== 'POST' || url.search || !runtime.attachment || req.headers.origin !== origin) {
        send(res, 405, { error: 'Unsupported Chat intent' }); return;
      }
      const attachment = runtime.attachment;
      try {
        const data = await jsonBody(req, 4096);
        const { generation, cwd, action, id } = data;
        if (generation !== runtime.generation || cwd !== runtime.cwd) {
          send(res, 409, { error: 'Workspace does not match the Chat attachment' }); return;
        }
        if (action === 'new' && Object.keys(data).length === 3) await runtime.chatIntent(attachment, { action });
        else if (action === 'select' && typeof id === 'string' && Object.keys(data).length === 4) {
          await runtime.chatIntent(attachment, { action, id });
        } else { send(res, 400, { error: 'Invalid Chat intent' }); return; }
        send(res, 202, { accepted: true });
      } catch { send(res, 409, { error: 'Chat conversation is unavailable' }); }
      return;
    }
    const read = req.method === 'GET' || req.method === 'HEAD';
    const endpoint = /^\/api\/sessions\/[^/]+\/(.+)$/.exec(path)?.[1];
    const preference = path === '/api/config' && req.method === 'PATCH';
    const kind = read ? 'read' : endpoint && settlers.has(endpoint) ? 'settle' : 'work';
    const opening = runtime.opening;
    const startup = runtime.chatStartupSignal;
    if ((!runtime.ready && (!opening || kind === 'work')) || !isScoped(path, url)
      || (!read && !preference && (req.method !== 'POST' || !endpoint || !sessionMutations.has(endpoint)))) {
      send(res, 409, { error: 'Request is outside the active Chat conversation' }); return;
    }
    const finish = runtime.handoff.admit('chat', kind);
    if (!finish) { send(res, 409, { error: 'Chat is releasing its conversation' }); return; }
    let dispatched = false;
    let upstreamSettled = false;
    try {
      let body: string | undefined;
      let commandName: string | undefined;
      if (!read) {
        let data: Record<string, unknown>;
        if (endpoint === 'attachments') {
          try {
            data = await jsonBody(req, maxAttachmentBody);
            validateAttachmentSize(data.attachments);
          } catch (error) {
            if (error instanceof BodyTooLarge) {
              req.resume(); // Discard unread bytes; do not forward any portion of the batch.
              send(res, 413, { error: 'Chat attachment uploads are limited to 10 MB per request' });
            } else {
              send(res, 400, { error: 'Invalid Chat attachment upload' });
            }
            return;
          }
        } else {
          data = await jsonBody(req);
        }
        if (preference) {
          const set = data.set as Record<string, unknown> | undefined;
          if (!set || Object.keys(data).length !== 1 || Object.keys(set).length !== 1 || typeof set.quietMode !== 'boolean') {
            send(res, 400, { error: 'Only the Chat display preference can be changed here' }); return;
          }
        } else if (data.cwd !== runtime.cwd) {
          send(res, 400, { error: 'Workspace does not match the Chat conversation' }); return;
        }
        if (endpoint === 'commands/run') {
          if (typeof data.text !== 'string' || !data.text.trim()) {
            send(res, 400, { error: 'Chat command text is required' }); return;
          }
          // These stock commands create another transcript outside the bound session.
          [commandName] = data.text.trim().replace(/^\//, '').split(/\s+/, 1);
          if (commandName === 'clone' || commandName === 'fork') {
            send(res, 409, { error: 'Command would leave the active Chat conversation' }); return;
          }
        }
        body = JSON.stringify(data);
      }
      startup?.throwIfAborted();
      // The shell can preload while the browser is suspended. Start the writer
      // deadline only when stock boot requests its scoped transcript snapshot.
      if (opening && req.method === 'GET' && runtime.binding
        && path === `/api/sessions/${runtime.binding.id}/transcript-snapshot`
        && url.searchParams.get('cwd') === runtime.cwd) runtime.beginChatAttachment();
      dispatched = true;
      // Node fetch can replace Host with the loopback authority. Stock checks
      // Host and Origin as a pair, so use Node HTTP with the verified public Host.
      const result = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstream = http.request({ hostname, port: PI_WEB_PORT, path: `${url.pathname}${url.search}`,
          method: req.method,
          signal: opening && endpoint ? startup : AbortSignal.any([AbortSignal.timeout(25_000), ...(startup ? [startup] : [])]),
          headers: { Host: new URL(origin).host, ...(req.headers.origin && { Origin: req.headers.origin }),
            ...(body !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
        }, resolve);
        upstream.once('error', reject);
        upstream.end(body);
      });
      if (!result.statusCode) throw new Error('Missing stock Chat HTTP status');
      const headers: http.OutgoingHttpHeaders = { 'Cache-Control': 'no-store' };
      if (result.headers['content-type']) headers['content-type'] = result.headers['content-type'];
      const policy = result.headers['content-security-policy'];
      if (policy) headers['content-security-policy'] = Array.isArray(policy) ? policy.join(', ') : policy;
      const framing = result.headers['x-frame-options'];
      // X-Frame-Options is singular. Do not let conflicting values turn an
      // upstream DENY into SAMEORIGIN at the public hop.
      if (framing) {
        const values = (Array.isArray(framing) ? framing : [framing]).flatMap(value => value.split(','));
        headers['x-frame-options'] = values.length > 0 && values.every(value => value.trim().toUpperCase() === 'SAMEORIGIN')
          ? 'SAMEORIGIN' : 'DENY';
      }
      const status = result.statusCode;
      const ok = status >= 200 && status < 300;
      if (endpoint && status >= 500 && !startup?.aborted) runtime.markWebRequestUnconfirmed();
      if (endpoint === 'prompt' && ok) {
        const acknowledgment = await readJson(result);
        if (!acknowledgment || typeof acknowledgment !== 'object' || !('accepted' in acknowledgment)
          || acknowledgment.accepted !== true) throw new Error('Unconfirmed stock prompt acknowledgment');
        // Acceptance is not settlement. The exact catalog row is checked
        // only after all admitted requests, including this one, finish.
        upstreamSettled = true;
        options.recordInput();
        send(res, status, acknowledgment, headers);
        return;
      }
      // /tree is a read-only result and may carry a large tree snapshot.
      if (ok && endpoint === 'commands/run' && commandName !== 'tree') {
        const resultBody = await readJson(result);
        if (!resultBody || typeof resultBody !== 'object' || !('type' in resultBody)
          || (resultBody.type !== 'done' && resultBody.type !== 'unsupported')) {
          throw new Error('Unconfirmed stock Chat command result');
        }
        upstreamSettled = true;
        if (resultBody.type === 'done') options.recordInput();
        send(res, status, resultBody, headers);
        return;
      }
      upstreamSettled = true;
      if (ok && endpoint && settlers.has(endpoint)) options.recordInput();
      const catalog = runtime.catalogPath;
      if (ok && read && req.method !== 'HEAD' && (path === '/api/sessions' || catalog && path === catalog.slice(0, catalog.lastIndexOf('/')))) {
        const rows = await readJson(result);
        const filtered = Array.isArray(rows) ? rows.filter(row => path === '/api/sessions' ? runtime.eligibleRow(row)
          : row?.cwd === runtime.cwd && row?.archived === false && runtime.hasSavedMember(row.id)) : [];
        send(res, status, filtered, headers);
        return;
      }
      res.writeHead(status, headers);
      // For a complete release, finish counts upstream I/O, not merely the
      // disconnected browser. Cancel the upstream stream before dropping it.
      await new Promise<void>((resolve, reject) => {
        result.once('error', reject);
        result.once('close', resolve);
        res.once('close', () => result.destroy());
        if (res.destroyed) result.destroy();
        else result.pipe(res);
      });
    } catch {
      // Cancelling fetch is not proof that sessiond cancelled getOrOpen or
      // accepted work. Preserve exclusivity even if the private hop timed out.
      if (dispatched && !upstreamSettled && !startup?.aborted && path.startsWith('/api/')) runtime.markWebRequestUnconfirmed();
      if (!res.headersSent) send(res, 503, { error: 'Chat service unavailable' });
      else res.destroy();
    } finally { finish(); }
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = route(req);
    const origin = publicOrigin(req);
    const path = url && browserPath(url.pathname);
    if (!url || !origin || !path || (!runtime.ready && !runtime.opening) || !runtime.handoff.permits('chat', 'read') || !isScoped(path, url)
      || !/^\/api\/(?:events|sessions\/(?:events|[^/]+\/events))$/.test(path)) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return;
    }
    const startup = runtime.chatStartupSignal;
    const attachment = runtime.attachment;
    const global = path === '/api/events' || path === '/api/sessions/events';
    const current = () => !closed && attachment === runtime.attachment && !startup?.aborted && runtime.handoff.permits('chat', 'read');
    const upstream = new URL(`ws://${hostname}:${PI_WEB_PORT}`);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const ws = new WebSocket(upstream, { headers: { Host: new URL(origin).host, Origin: origin }, handshakeTimeout: 5000, maxPayload: 8 * maxBody });
    sockets.add(ws);
    let upgraded = false;
    ws.once('close', () => { sockets.delete(ws); if (!upgraded) socket.destroy(); });
    socket.once('close', () => ws.terminate());
    ws.once('error', () => socket.destroy());
    ws.once('open', () => {
      if (socket.destroyed || !current()) { ws.terminate(); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, client => {
        upgraded = true;
        client.on('error', () => ws.terminate());
        client.on('close', () => ws.terminate());
        ws.on('close', () => client.close());
        ws.on('message', (frame, binary) => {
          if (!current() || client.bufferedAmount > 8 * maxBody) {
            client.close(); ws.close(); return;
          }
          if (!global || isBoundGlobalEvent(frame.toString(), runtime.binding?.id, runtime.cwd)) client.send(frame, { binary });
        });
      });
    });
  }

  let closing: Promise<void> | undefined;
  return { handle, upgrade, close() {
    closing ??= runtime.close().finally(() => {
      closed = true;
      wss.close();
    });
    return closing;
  } };
}

// Pinned stock global event shapes. Per-session streams stay receive-only and
// are already scoped by the exact URL. Unknown broadcast shapes fail closed.
function isBoundGlobalEvent(raw: string, id: string | undefined, cwd: string): boolean {
  if (!id) return false;
  try {
    const event = JSON.parse(raw);
    switch (event?.type) {
      case 'status.update': return event.status?.sessionId === id;
      case 'activity.update':
      case 'session.startup': return event.activity?.sessionId === id;
      case 'session.name': return event.sessionId === id;
      case 'session.created': return event.session?.id === id && event.session.cwd === cwd;
      case 'notifications.summary': return event.summary?.sessionId === id && event.summary.cwd === cwd;
      case 'sessions.unread': return event.sessionId === id && event.cwd === cwd;
      case 'models.changed':
      case 'machine.status': return true;
      default: return false;
    }
  } catch { return false; }
}

export type PiWebProxy = ReturnType<typeof createPiWebProxy>;
