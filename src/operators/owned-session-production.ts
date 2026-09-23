import type { Env } from '../types';
import { parseOperatorContainerProfile } from '../container/operator-context';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getR2Config } from '../lib/r2-config';
import { getSseHeaders } from '../lib/r2-sse';
import type { OperatorActivity } from './activity';
import type { OwnedOperatorSessionState, OwnedOperatorSessionStore } from './owned-session';
import type { OperatorSessionBootstrap } from './owned-session-runtime';
import type { OperatorSyncReader } from './sync-verification';

export type OperatorActivityStub = DurableObjectStub<OperatorActivity>;

export function operatorActivitySessionStore(activity: OperatorActivityStub): OwnedOperatorSessionStore {
  return {
    load: async () => {
      const state = await activity.getOwnedSession();
      return state ? { schemaVersion: 1, requestId: state.requestId, requestDigest: state.requestDigest,
        activityId: state.activityId, ownerBucket: state.ownerBucket, sessionId: state.sessionId,
        profile: parseOperatorContainerProfile(state.profile), status: state.status } : null;
    },
    save: async (state: OwnedOperatorSessionState) => {
      const result = await activity.saveOwnedSession(state);
      if (!result.ok) throw new Error(`Owned session state ${result.reason}`);
    },
  };
}

/** Owner-scoped, SSE-aware and byte-bounded reader used only after Activity authorization. */
export async function createOperatorSyncReader(env: Env, bucket: string,
  bootstrap: OperatorSessionBootstrap): Promise<OperatorSyncReader> {
  const config = await getR2Config(env);
  const client = createR2Client({ R2_ACCESS_KEY_ID: bootstrap.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: bootstrap.r2SecretAccessKey });
  return async (key, maxBytes) => {
    const signed = await client.sign(getR2Url(config.endpoint, bucket, key), {
      headers: getSseHeaders(env, bootstrap.r2SseDisabled === true),
    });
    const response = await fetch(signed);
    if (response.status === 404) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || (declared && declared > maxBytes)) throw new Error('Bounded R2 read failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Bounded R2 read failed');
    return bytes;
  };
}
