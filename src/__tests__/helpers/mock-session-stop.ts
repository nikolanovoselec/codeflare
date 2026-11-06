import type { Env } from '../../types';
import type { MockKV } from './mock-kv';
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
