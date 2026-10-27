/** External installed-Worker wire fixture, NOT proof of Flue execution/scheduling/recovery. */
export const normalHosting = {
  kind: 'normal', binding: 'FlueDispatcherAgent', className: 'FlueDispatcherAgent', migrationTag: 'v1',
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
export type NormalDispatch = {
  id: string; uid?: string; installationId: string; activityId: string; generation: number;
  releaseId: string; connectionRevision: number; workerVersionId: string; idempotencyKey: string;
  message: unknown; initialData?: unknown;
};
export const connectionSecret = 'fixture-installation-secret-not-a-provider-credential';
export const normalDeployment = {
  workerName: 'installed-dispatcher', workerVersionId: '11111111-2222-4333-8444-555555555555',
  sourceCommit: 'a'.repeat(40), compilerCommit: 'c'.repeat(40),
};

export function normalCallback(activityId: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://operator.internal/v1/dispatcher/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${connectionSecret}`,
      'x-codeflare-operator-installation': 'installation', 'x-codeflare-operator-activity': activityId,
      'x-codeflare-operator-generation': '1', 'x-codeflare-operator-release': 'release',
      'x-codeflare-operator-connection-revision': '1', ...headers }, body: JSON.stringify(body),
  });
}

/** Durable remote acceptance exists independently of the Activity's receipt storage. */
export function createNormalDispatcherTransport() {
  const requests: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const admissions = new Map<string, { wire: string; receipt: NormalReceipt }>();
  let loseNextAcknowledgement = false;
  let outcome: 'pending' | 'completed' | 'failed' | 'aborted' = 'pending';
  let data: Record<string, unknown[]> = {};
  let replyPatch: Record<string, unknown> = {};
  let receiptPatch: Record<string, unknown> = {};
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/control/')) throw new Error(`Unexpected external network path: ${path}`);
    const body = await request.json() as Record<string, unknown>;
    requests.push({ path, authorization: request.headers.get('authorization'), body: structuredClone(body) });
    if (request.headers.get('authorization') !== `Bearer ${connectionSecret}`) return new Response(null, { status: 403 });
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
      const receipt = [...admissions.values()].find(item => item.receipt.submissionId === (body.receipt as NormalReceipt)?.submissionId)?.receipt;
      if (!receipt) return Response.json({ code: 'unknown-submission' }, { status: 404 });
      return Response.json({ status: outcome, receipt: { ...receipt, ...receiptPatch },
        ...(outcome === 'pending' ? { reason: 'observation-timeout' } : outcome === 'completed'
          ? { reply: { uid: receipt.uid, submissionId: receipt.submissionId, text: '', data, ...replyPatch } }
          : { submissionId: receipt.submissionId }) }, { status: outcome === 'pending' ? 202 : 200 });
    }
    return new Response(null, { status: 404 });
  };
  return { fetcher, requests, admissions,
    loseAcknowledgement: () => { loseNextAcknowledgement = true; },
    settle: (status: typeof outcome, assessmentData: Array<{ name: string; data: unknown }> = []) => {
      outcome = status;
      data = {};
      for (const item of assessmentData) (data[item.name] ??= []).push(item.data);
    },
    changeReply: (patch: Record<string, unknown>) => { replyPatch = patch; },
    changeReceipt: (patch: Record<string, unknown>) => { receiptPatch = patch; },
  };
}
