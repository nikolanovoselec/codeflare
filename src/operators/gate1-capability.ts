import type { Gate1Resources } from './gate1-resources';
import type { OperatorSyncExpectation } from './sync-verification';

const OPERATION_ID = 'gate1-output-v1';
const TASK_ID = 'gate1-pi-file-v1';
const MAX_BODY = 64 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

type SessionStatus = 'reserved' | 'configuring' | 'configured' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'unknown';
interface SessionController {
  ensure(): Promise<{ status: SessionStatus }>;
  stop(): Promise<{ status: SessionStatus }>;
}
interface HostClient { fetch(path: string, init?: RequestInit): Promise<Response> }
interface SyncOwner {
  get(operationId: string): Promise<{ phase: string; evidence?: { filesVerified: number; bytesVerified: number } | null } | null>;
  prepare(input: unknown): Promise<{ ok: boolean; phase?: string; reason?: string }>;
  uploaded(operationId: string, manifestDigest: string): Promise<{ ok: boolean; phase?: string; reason?: string }>;
  verified(operationId: string, evidence: { manifestDigest: string; filesVerified: number; bytesVerified: number }):
    Promise<{ ok: boolean; phase?: string; reason?: string }>;
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export interface Gate1CapabilityOptions {
  activityId: string;
  generation: number;
  deadline: number;
  resources: Gate1Resources;
  session: SessionController;
  host: HostClient;
  sync: SyncOwner;
  verify: (expected: OperatorSyncExpectation) => Promise<{ manifestDigest: string; filesVerified: number; bytesVerified: number }>;
}

/** One generation-bound, fixed-purpose capability. No generic session, Pi or storage API is exposed. */
export class Gate1OperatorCapability {
  constructor(private readonly options: Gate1CapabilityOptions) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname !== '/v1/gate1/session') return response(404, { error: 'Not found' });
    if (request.method !== 'POST') return response(405, { error: 'Method not allowed' });
    if (url.search || url.hash) return response(400, { error: 'Invalid request' });
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY) return response(413, { error: 'Request body too large' });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY) return response(413, { error: 'Request body too large' });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400, { error: 'Invalid request' }); }
    const record = body as Record<string, unknown>;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 4
      || record.schemaVersion !== 1 || record.activityId !== this.options.activityId
      || record.generation !== this.options.generation || !('checkpoint' in record)) {
      return response(record?.generation !== this.options.generation ? 403 : 400, { error: 'Invalid request' });
    }
    if (Date.now() >= this.options.deadline) return response(403, { error: 'Capability expired' });
    try { return response(200, await this.drive()); }
    catch {
      await this.options.session.stop().catch(() => ({ status: 'unknown' as const }));
      return response(200, this.failed('GATE1_CAPABILITY_FAILED'));
    }
  }

  private async drive(): Promise<unknown> {
    const { activityId, deadline, resources, session, host, sync } = this.options;
    const existing = await sync.get(OPERATION_ID);
    if (existing?.phase === 'verified' && existing.evidence) return this.finish(existing.evidence);

    let owned: Awaited<ReturnType<SessionController['ensure']>>;
    try { owned = await session.ensure(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Gate 1 session configuration failed') return this.failed('GATE1_SESSION_CONFIG_FAILED');
      const category = message.startsWith('Gate 1 session startup failed:')
        ? message.slice('Gate 1 session startup failed:'.length).replaceAll('-', '_').toUpperCase() : '';
      if (['HOST_UNAVAILABLE', 'HOST_ERROR', 'INIT_NOT_READY', 'TERMINAL_NOT_READY', 'PORTS_TIMEOUT',
        'STARTING', 'STOPPED', 'UNKNOWN'].includes(category)) {
        return this.failed(`GATE1_SESSION_START_${category}`);
      }
      throw error;
    }
    if (owned.status === 'unknown') return this.failed('GATE1_SESSION_UNKNOWN');
    if (owned.status !== 'ready') return this.waiting('session');

    const ensured = await host.fetch('/internal/operator/pi/ensure', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (!ensured.ok) throw new Error('Pi ensure failed');
    const taskDigest = await sha256(resources.profile.piProfile.systemPrompt);
    const taskResponse = await host.fetch('/internal/operator/pi/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        taskId: TASK_ID, digest: taskDigest, text: resources.profile.piProfile.systemPrompt, mode: 'prompt',
      }),
    });
    if (!taskResponse.ok) throw new Error('Pi task failed');
    const task = await taskResponse.json() as { status?: string };
    if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'unknown') {
      await session.stop();
      return this.failed('GATE1_PI_FAILED');
    }
    if (task.status !== 'completed') return this.waiting('pi');

    const requestDigest = await sha256(JSON.stringify({ activityId, marker: resources.marker }));
    const prefix = `.codeflare/operators/${activityId}/${OPERATION_ID}/`;
    const prepared = await sync.prepare({ operationId: OPERATION_ID, sessionId: resources.profile.sessionId,
      requestDigest, policyDigest: resources.profile.policyDigest, prefix, deadline });
    if (!prepared.ok) throw new Error('Sync preparation failed');
    const upload = await host.fetch('/internal/bisync-trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        operationId: OPERATION_ID, requestDigest, files: [{ path: resources.marker.relativePath,
          size: new TextEncoder().encode(resources.marker.content).byteLength, sha256: resources.marker.sha256 }],
      }),
    });
    if (!upload.ok) {
      const failure = await upload.json().catch(() => null) as { code?: unknown } | null;
      if (failure?.code === 'SYNC_OUTPUT_NOT_FOUND' || failure?.code === 'SYNC_OUTPUT_MISMATCH'
        || failure?.code === 'SYNC_STATE_FAILED') {
        await session.stop();
        return this.failed(`GATE1_${failure.code}`);
      }
      throw new Error('Sync upload failed');
    }
    const receipt = await upload.json() as { schemaVersion?: number; operationId?: string; requestDigest?: string;
      status?: string; manifestDigest?: string | null; files?: unknown };
    const expectedFiles = [{ path: resources.marker.relativePath,
      size: new TextEncoder().encode(resources.marker.content).byteLength, sha256: resources.marker.sha256 }];
    if (receipt.schemaVersion !== 1 || receipt.operationId !== OPERATION_ID || receipt.requestDigest !== requestDigest
      || receipt.status !== 'uploaded' || !receipt.manifestDigest || !/^[0-9a-f]{64}$/.test(receipt.manifestDigest)
      || JSON.stringify(receipt.files) !== JSON.stringify(expectedFiles)) throw new Error('Sync upload uncertain');
    const uploaded = await sync.uploaded(OPERATION_ID, receipt.manifestDigest);
    if (!uploaded.ok) throw new Error('Sync seal failed');
    const evidence = await this.options.verify({ activityId, sessionId: resources.profile.sessionId,
      operationId: OPERATION_ID, requestDigest, policyDigest: resources.profile.policyDigest,
      manifestDigest: receipt.manifestDigest, prefix, filePrefix: resources.profile.outputPrefix, deadline });
    const verified = await sync.verified(OPERATION_ID, evidence);
    if (!verified.ok) throw new Error('Sync verification failed');
    return this.finish(evidence);
  }

  private async finish(evidence: { filesVerified: number; bytesVerified: number }): Promise<unknown> {
    const stopped = await this.options.session.stop();
    if (stopped.status !== 'stopped') return this.failed('GATE1_STOP_UNKNOWN');
    return { schemaVersion: 1, status: 'completed', checkpoint: null, result: {
      fixture: 'codeflare-gate1', activityId: this.options.activityId,
      sessionId: this.options.resources.profile.sessionId, operationId: OPERATION_ID,
      filesVerified: evidence.filesVerified, bytesVerified: evidence.bytesVerified,
    } };
  }
  private waiting(stage: 'session' | 'pi'): unknown {
    return { schemaVersion: 1, status: 'waiting', checkpoint: { stage } };
  }
  private failed(code: string): unknown {
    return { schemaVersion: 1, status: 'failed', checkpoint: null, result: { code } };
  }
}
