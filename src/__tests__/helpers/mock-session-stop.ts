import type { Env } from '../../types';
import type { MockKV } from './mock-kv';
import { createMockSessionD1 } from './mock-session-d1';

type StopCommand = { bucket: string; sessionId: string; generation: number };

/** Route fixtures execute the real DO lifecycle operation against their D1 adapter. */
export function createMockSessionStop(kv: MockKV, destroy: () => Promise<void>) {
  return async (input: StopCommand): Promise<void> => {
    const lifecycle = await import('../../container/container-lifecycle') as unknown as {
      stopSession(env: Env, input: StopCommand, destroy: () => Promise<void>): Promise<void>;
    };
    await lifecycle.stopSession({ USAGE_DB: createMockSessionD1(kv) } as Env, input, destroy);
  };
}
