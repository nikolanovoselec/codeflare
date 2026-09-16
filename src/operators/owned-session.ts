/**
 * Activity-owned orchestration over existing Codeflare session primitives.
 * This component owns idempotent ordering and ownership, not quotas, container
 * implementation, Pi tasks, storage transport or credentials; those remain in
 * the injected platform runtime and dedicated adapters.
 */
import type { JwtStampingAuthority } from './jwt-stamping';
import type { OperatorContainerProfile } from '../container/operator-context';

export interface OwnedOperatorSessionState {
  schemaVersion: 1;
  requestId: string;
  requestDigest: string;
  activityId: string;
  ownerBucket: string;
  sessionId: string;
  profile: OperatorContainerProfile;
  status: 'reserved' | 'configured' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'unknown';
}
export interface OwnedOperatorSessionStore {
  load(): Promise<OwnedOperatorSessionState | null>;
  save(state: OwnedOperatorSessionState): Promise<void>;
}
export interface OwnedOperatorSessionRuntime {
  reserve(input: { activityId: string; ownerBucket: string }): Promise<{ sessionId: string }>;
  configure(sessionId: string, profile: OperatorContainerProfile, authority: JwtStampingAuthority): Promise<void>;
  start(sessionId: string): Promise<void>;
  readiness(sessionId: string): Promise<'starting' | 'ready' | 'stopped' | 'unknown'>;
  stop(sessionId: string, drain: boolean): Promise<'stopped' | 'unknown'>;
}

export class OwnedOperatorSessionService {
  constructor(_store: OwnedOperatorSessionStore, _runtime: OwnedOperatorSessionRuntime) {}
  async ensure(_input: { requestId: string; requestDigest: string; activityId: string; ownerBucket: string;
    profile: OperatorContainerProfile; authority: JwtStampingAuthority }): Promise<OwnedOperatorSessionState> {
    throw new Error('Not implemented');
  }
  async stop(_input: { activityId: string; ownerBucket: string; drain: boolean }): Promise<OwnedOperatorSessionState> {
    throw new Error('Not implemented');
  }
}
