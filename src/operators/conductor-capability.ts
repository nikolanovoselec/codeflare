import { z } from 'zod';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const KEY = z.string().min(1).max(1024).refine(value => value.trim() === value
  && !/[\\%\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
const MAX_BODY = 64 * 1024;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export interface ConductorCapabilityOperations {
  current(): Promise<void>;
  session: {
    ensure(input: { initialization?: unknown }): Promise<{ status: string }>;
    stop(): Promise<{ status: string }>;
  };
  attachments: {
    restore(input: { locator: string; sha256: string; size: number }): Promise<{ status: 'restored'; path: string }>;
  };
  packets?: {
    prepare(input: { preparationId: string; lane: string }, signal: AbortSignal): Promise<{ preparationId: string;
      bytes: string; attachment: { name: string; mediaType: string; locator: string; size: number; sha256: string } }>;
  };
  pi: {
    ensure(): Promise<{ ready: true; conversationId: string }>;
    task(input: { taskId: string; digest: string; mode: 'prompt'; text: string }
      | { taskId: string; digest: string; mode: 'tool'; toolName: 'run_approved_tasks';
        arguments: { initializationDigest: string } }): Promise<{ taskId: string; status: string }>;
  };
  sync: {
    seal(input: { operationId: string; paths: string[] }): Promise<{
      status: 'sealed'; manifestDigest: string; prefix: string; filePrefix: string;
    }>;
  };
  storage: {
    read(input: { key: string; maxBytes: number }): Promise<Uint8Array | null>;
  };
}

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: HEADERS });
}

const empty = z.strictObject({ schemaVersion: z.literal(1) });
const ensure = z.strictObject({ schemaVersion: z.literal(1), initialization: z.unknown().optional() });
const attachment = z.strictObject({ schemaVersion: z.literal(1), attachment: z.strictObject({
  locator: ID, sha256: DIGEST, size: z.number().int().positive().max(8 * 1024 * 1024),
}) });
const packet = z.strictObject({ schemaVersion: z.literal(1), preparationId: ID,
  lane: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) });
const task = z.discriminatedUnion('mode', [
  z.strictObject({ schemaVersion: z.literal(1), taskId: ID, digest: DIGEST,
    mode: z.literal('prompt'), text: z.string().min(1).max(32 * 1024) }),
  z.strictObject({ schemaVersion: z.literal(1), taskId: ID, digest: DIGEST, mode: z.literal('tool'),
    toolName: z.literal('run_approved_tasks'), arguments: z.strictObject({ initializationDigest: DIGEST }) }),
]);
const seal = z.strictObject({ schemaVersion: z.literal(1), operationId: ID,
  paths: z.array(KEY).min(1).max(128).refine(paths => new Set(paths).size === paths.length) });
const read = z.strictObject({ schemaVersion: z.literal(1), key: KEY,
  maxBytes: z.number().int().positive().max(MAX_BODY) });

/** Profile-neutral, generation-bound operations for installed Conductor packages. */
export class OperatorConductorCapability {
  constructor(private readonly operations: ConductorCapabilityOperations) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== 'POST') return response(405, { error: 'Method not allowed' });
    if (url.search || url.hash) return response(400, { error: 'Invalid request' });
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY) return response(413, { error: 'Request body too large' });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY) return response(413, { error: 'Request body too large' });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return response(400, { error: 'Invalid request' }); }
    try {
      // Cleanup may outlive a revoked generation; it can only stop the owned session.
      if (url.pathname === '/v1/session/stop') {
        empty.parse(body);
        return response(200, await this.operations.session.stop());
      }
      await this.operations.current();
      switch (url.pathname) {
        case '/v1/session/ensure': {
          const { initialization } = ensure.parse(body);
          return response(200, await this.operations.session.ensure({ initialization }));
        }
        case '/v1/storage/restore': return response(200, await this.operations.attachments.restore(attachment.parse(body).attachment));
        case '/v1/packets/prepare': {
          const value = packet.parse(body);
          if (!this.operations.packets) throw new Error('Packet preparation unavailable');
          return response(200, await this.operations.packets.prepare(value, request.signal));
        }
        case '/v1/pi/ensure': empty.parse(body); return response(200, await this.operations.pi.ensure());
        case '/v1/pi/tasks': return response(200, await this.operations.pi.task(task.parse(body)));
        case '/v1/sync/seal': return response(200, await this.operations.sync.seal(seal.parse(body)));
        case '/v1/storage/read': {
          const value = read.parse(body);
          const stored = await this.operations.storage.read(value);
          return stored ? response(200, { bytes: btoa(String.fromCharCode(...stored)) })
            : response(404, { error: 'Not found' });
        }
        default: return response(404, { error: 'Not found' });
      }
    } catch {
      return response(403, { error: 'Capability denied' });
    }
  }
}
