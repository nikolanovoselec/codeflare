import type { Env } from '../../types';
import type { MockKV } from './mock-kv';
import { D1SessionRepository } from '../../lib/session-repository';
import { createMockSessionD1 } from './mock-session-d1';
// Resolve the real lifecycle module before route suites install fake timers.
import { stopSession } from '../../container/container-lifecycle';

type StopCommand = { bucket: string; sessionId: string; generation: number };

/** Route fixtures execute the real DO lifecycle operation against their D1 adapter. */
export function createMockSessionStop(kv: MockKV, destroy: () => Promise<void>) {
  return async (input: StopCommand): Promise<void> => {
    await stopSession({ USAGE_DB: createMockSessionD1(kv) } as Env, input, destroy);
  };
}

/** Controller fixtures simulate the DO's acknowledgement coupled to a D1 claim. */
export function withMockStartClaim<T extends {
  fetch(request: Request): Promise<Response>; getState(): Promise<{ status: string }>;
}>(container: T, kv: MockKV): T {
  return { ...container, async fetch(request: Request) {
    const copy = request.clone();
    const response = await container.fetch(request);
    const header = copy.headers.get('X-Codeflare-Start-Generation');
    if (header === null || (response.status !== 200 && response.status !== 409)) return response;
    const { bucketName, sessionId } = await copy.json() as { bucketName: string; sessionId: string };
    const repository = new D1SessionRepository(createMockSessionD1(kv));
    const session = await repository.getSession(bucketName, sessionId);
    if (session?.lifecycleState !== 'stopped') return response;
    if (['running', 'healthy'].includes((await container.getState()).status)) return new Response(null, { status: 412 });
    const claim = await repository.start(bucketName, sessionId, new Date().toISOString(), Number(header));
    if (!claim) return new Response(null, { status: 412 });
    const headers = new Headers(response.headers);
    headers.set('X-Codeflare-Start-Claim', String(claim.lifecycleGeneration));
    return new Response(null, { status: response.status, headers });
  } };
}
