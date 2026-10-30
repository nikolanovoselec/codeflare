/** External installed-Worker wire fixture, NOT proof of Flue execution/scheduling/recovery. */
export const normalHosting = {
  kind: 'normal', binding: 'FLUE_DISPATCHER_AGENT', className: 'FlueDispatcherAgent', migrationTag: 'v1',
} as const;

export function normalDispatcherBundle() {
  return {
    schemaVersion: 2 as const, hosting: { ...normalHosting }, sourceCommit: 'a'.repeat(40),
    versions: { runtime: '2.3.0', vitePlugin: '2.3.0', agents: '0.30.1' } as const,
    className: 'FlueDispatcherAgent' as const, compatibilityDate: '2026-09-10' as const,
    compatibilityFlags: ['nodejs_compat'] as ['nodejs_compat'], mainModule: 'index.js',
    modules: {
      'index.js': { js: 'export class FlueDispatcherAgent {}\nexport default { fetch() { throw new Error("Must not execute during acquisition") } };' },
      'resources/intent.txt': { text: 'Trusted installed application\néxact resource bytes\n' },
    },
  };
}

export type NormalReceipt = { submissionId: string; acceptedAt: string; uid: string; deduplicated?: true };
type NormalDispatch = {
  id: string; uid?: string; installationId: string; activityId: string; generation: number;
  releaseId: string; connectionRevision: number; workerVersionId: string; idempotencyKey: string;
  message: unknown; initialData?: unknown;
};
export const connectionSecret = 'fixture-installation-secret-not-a-provider-credential';
export const normalDeployment = {
  controlOrigin: 'https://installed-dispatcher.example.test',
  workerName: 'installed-dispatcher', workerVersionId: '11111111-2222-4333-8444-555555555555',
  sourceCommit: 'a'.repeat(40), compilerCommit: 'c'.repeat(40),
};

export function normalCallback(activityId: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://operator.internal/v1/dispatcher/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${connectionSecret}`,
      'x-codeflare-operator-installation': 'installation',
      'x-codeflare-operator-worker-version': normalDeployment.workerVersionId, 'x-codeflare-operator-activity': activityId,
      'x-codeflare-operator-generation': '1', 'x-codeflare-operator-release': 'release',
      'x-codeflare-operator-connection-revision': '1', ...headers }, body: JSON.stringify(body),
  });
}

type NormalProfileIdentity = {
  source: 'pi-native' | 'managed'; provider: string; model: string; api: string; reasoningLevel: string | null;
};

/** Durable remote acceptance exists independently of the Activity's receipt storage.
 * Profile metadata simulates the external Worker wire, not SDK resolution/auth/parser execution.
 */
export function createNormalDispatcherTransport(options: {
  profile?: NormalProfileIdentity;
  profileTransport?: (request: Request) => Promise<Response | undefined>;
} = {}) {
  const requests: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const networkRequests: Array<{ url: string; method: string }> = [];
  const admissions = new Map<string, { wire: string; receipt: NormalReceipt }>();
  let loseNextAcknowledgement = false;
  let nextReadFailure: number | undefined;
  let outcome: 'pending' | 'completed' | 'failed' | 'aborted' = 'pending';
  let data: Record<string, unknown[]> = {};
  let replyPatch: Record<string, unknown> = {};
  let receiptPatch: Record<string, unknown> = {};
  let profileAuthMissing = false;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    networkRequests.push({ url: request.url, method: request.method });
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/control/')) throw new Error(`Unexpected external network path: ${path}`);
    const body = await request.clone().json() as Record<string, unknown>;
    requests.push({ path, authorization: request.headers.get('authorization'), body: structuredClone(body) });
    if (request.headers.get('authorization') !== `Bearer ${connectionSecret}`) return new Response(null, { status: 403 });
    if (path === '/control/profile') {
      const controlled = await options.profileTransport?.(request);
      if (controlled) return controlled;
      const identity = options.profile ?? { source: 'managed', provider: 'codeflare-gateway', model: 'approved',
        api: 'openai-completions', reasoningLevel: 'off' };
      // Optional fault evidence only; SDK auth is not required to run during profile discovery.
      if (profileAuthMissing) return Response.json({ authFailure: {
        code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider: identity.provider } }, { status: 401 });
      const { source, provider, model, api, reasoningLevel } = identity;
      const profileDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(JSON.stringify({ source, provider, model, api, reasoningLevel })))), byte => byte.toString(16).padStart(2, '0')).join('');
      return Response.json({ selection: { ...identity, profileDigest,
        ...(identity.source === 'managed' ? { routeId: identity.model } : {}) } });
    }
    if (path === '/control/dispatch') {
      const wire = body as NormalDispatch;
      if (!wire.id || !wire.idempotencyKey || wire.uid === null || wire.uid && wire.initialData !== undefined)
        return Response.json({ code: 'invalid-dispatch' }, { status: 400 });
      const retained = admissions.get(wire.idempotencyKey);
      if (retained && retained.wire !== JSON.stringify(wire)) return Response.json({ code: 'key-conflict' }, { status: 409 });
      const receipt = retained?.receipt ?? { submissionId: `submission-${admissions.size + 1}`,
        acceptedAt: new Date().toISOString(), uid: 'normal-sdk-instance' };
      admissions.set(wire.idempotencyKey, { wire: JSON.stringify(wire), receipt });
      if (loseNextAcknowledgement) { loseNextAcknowledgement = false; throw new Error('External acknowledgement lost after durable acceptance'); }
      return Response.json({ ...receipt, ...(retained ? { deduplicated: true } : {}) }, { status: 202 });
    }
    if (path === '/control/abort') return Response.json({ status: 'intent-recorded' }, { status: 202 });
    if (path === '/control/read') {
      if (nextReadFailure !== undefined) {
        const status = nextReadFailure; nextReadFailure = undefined;
        return new Response('Temporary platform failure', { status, headers: { 'content-type': 'text/html' } });
      }
      const receipt = [...admissions.values()].find(item => item.receipt.submissionId === (body.receipt as NormalReceipt)?.submissionId)?.receipt;
      if (!receipt) return Response.json({ code: 'unknown-submission' }, { status: 404 });
      return Response.json({ status: outcome, receipt: { ...receipt, ...receiptPatch },
        ...(outcome === 'pending' ? { reason: 'observation-timeout' } : outcome === 'completed'
          ? { reply: { uid: receipt.uid, submissionId: receipt.submissionId, text: '', data, ...replyPatch } }
          : { submissionId: receipt.submissionId }) }, { status: outcome === 'pending' ? 202 : 200 });
    }
    return new Response(null, { status: 404 });
  };
  return { fetcher, requests, networkRequests, admissions,
    refuseProfileAuth: () => { profileAuthMissing = true; },
    loseAcknowledgement: () => { loseNextAcknowledgement = true; },
    failNextRead: (status: number) => { nextReadFailure = status; },
    settle: (status: typeof outcome, assessmentData: Array<{ name: string; data: unknown }> = []) => {
      outcome = status;
      data = {};
      for (const item of assessmentData) (data[item.name] ??= []).push(item.data);
    },
    changeReply: (patch: Record<string, unknown>) => { replyPatch = patch; },
    changeReceipt: (patch: Record<string, unknown>) => { receiptPatch = patch; },
  };
}
