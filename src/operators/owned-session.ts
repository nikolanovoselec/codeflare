/**
 * Activity-owned orchestration over existing Codeflare session primitives.
 * This component owns idempotent ordering and ownership, not quotas, container
 * implementation, Pi tasks, storage transport or credentials; those remain in
 * the injected platform runtime and dedicated adapters.
 */
import type { JwtStampingAuthority } from './jwt-stamping';
import { parseOperatorContainerProfile, type OperatorContainerProfile } from '../container/operator-context';

export interface OwnedOperatorSessionState {
  schemaVersion: 1;
  requestId: string;
  requestDigest: string;
  activityId: string;
  ownerBucket: string;
  sessionId: string;
  profile: OperatorContainerProfile;
  status: 'reserved' | 'configuring' | 'configured' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'unknown';
}
export interface OwnedOperatorSessionStore {
  load(): Promise<OwnedOperatorSessionState | null>;
  save(state: OwnedOperatorSessionState): Promise<void>;
}
export interface OwnedOperatorSessionRuntime {
  reserve(input: { requestId: string; requestDigest: string; activityId: string; ownerBucket: string;
    sessionId: string }): Promise<{ sessionId: string }>;
  configure(sessionId: string, profile: OperatorContainerProfile, authority: JwtStampingAuthority): Promise<void>;
  start(sessionId: string): Promise<void>;
  readiness(sessionId: string): Promise<'starting' | 'ready' | 'stopped' | 'unknown'>;
  stop(sessionId: string, drain: boolean): Promise<'stopped' | 'unknown'>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function sameProfile(left: OperatorContainerProfile, right: OperatorContainerProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class OwnedOperatorSessionService {
  constructor(private readonly store: OwnedOperatorSessionStore,
    private readonly runtime: OwnedOperatorSessionRuntime) {}

  async ensure(input: { requestId: string; requestDigest: string; activityId: string; ownerBucket: string;
    profile: OperatorContainerProfile; authority: JwtStampingAuthority }): Promise<OwnedOperatorSessionState> {
    const profile = parseOperatorContainerProfile(input.profile);
    if (!ID.test(input.requestId) || !DIGEST.test(input.requestDigest) || !ID.test(input.activityId)
      || !OWNER.test(input.ownerBucket) || profile.activityId !== input.activityId
      || profile.ownerBucket !== input.ownerBucket || !ID.test(profile.sessionId)) {
      throw new Error('Owned session identity is invalid');
    }
    const authorityAudiences = [...input.authority.human.audiences].sort();
    const profileAudiences = [...profile.human.audiences].sort();
    let authorityIssuer = '';
    try { authorityIssuer = new URL(input.authority.human.issuer).href; } catch { /* mismatch below */ }
    if (!input.authority.accessJwt || new TextEncoder().encode(input.authority.accessJwt).byteLength > 64 * 1024
      || input.authority.human.subject !== profile.human.subject
      || input.authority.human.email.toLowerCase() !== profile.human.email
      || authorityIssuer !== profile.human.issuer
      || authorityAudiences.length !== profileAudiences.length
      || authorityAudiences.some((audience, index) => audience !== profileAudiences[index])
      || input.authority.human.expiresAt * 1000 <= Date.now()) throw new Error('Owned session authority is invalid');

    let state = await this.store.load();
    if (state) {
      if (state.requestId !== input.requestId || state.requestDigest !== input.requestDigest
        || state.activityId !== input.activityId || state.ownerBucket !== input.ownerBucket
        || state.sessionId !== profile.sessionId || !sameProfile(state.profile, profile)) {
        throw new Error('Owned session request conflict');
      }
      if (state.status === 'ready' || state.status === 'stopped' || state.status === 'unknown') return state;
      if (state.status === 'configuring') {
        state = { ...state, status: 'unknown' };
        await this.store.save(state);
        return state;
      }
      if (state.status === 'starting' || state.status === 'stopping') return this.reconcile(state);
    } else {
      const reserved = await this.runtime.reserve({ requestId: input.requestId, requestDigest: input.requestDigest,
        activityId: input.activityId, ownerBucket: input.ownerBucket, sessionId: profile.sessionId });
      if (reserved.sessionId !== profile.sessionId) throw new Error('Owned session reservation identity mismatch');
      state = { schemaVersion: 1, requestId: input.requestId, requestDigest: input.requestDigest,
        activityId: input.activityId, ownerBucket: input.ownerBucket, sessionId: reserved.sessionId,
        profile, status: 'reserved' };
      await this.store.save(state);
    }

    if (state.status === 'reserved') {
      state = { ...state, status: 'configuring' };
      await this.store.save(state);
      try {
        await this.runtime.configure(state.sessionId, state.profile, input.authority);
      } catch (error) {
        state = { ...state, status: 'unknown' };
        await this.store.save(state).catch(() => {});
        throw error;
      }
      state = { ...state, status: 'configured' };
      await this.store.save(state);
    }
    if (state.status === 'configured') {
      // Persist start intent before the effect. A lost response reconciles via
      // readiness and never invokes start again.
      state = { ...state, status: 'starting' };
      await this.store.save(state);
      await this.runtime.start(state.sessionId);
    }
    return this.reconcile(state);
  }

  async stop(input: { activityId: string; ownerBucket: string; drain: boolean }): Promise<OwnedOperatorSessionState> {
    let state = await this.store.load();
    if (!state || state.activityId !== input.activityId || state.ownerBucket !== input.ownerBucket) {
      throw new Error('Owned session ownership mismatch');
    }
    if (state.status === 'stopped') return state;
    if (state.status !== 'stopping') {
      state = { ...state, status: 'stopping' };
      await this.store.save(state);
    }
    // An uncertain configure/start/stop may have left a live owned container.
    // Only the ownership-checked destruction operation can establish stopped.
    const stopped = await this.runtime.stop(state.sessionId, input.drain);
    state = { ...state, status: stopped };
    await this.store.save(state);
    return state;
  }

  private async reconcile(state: OwnedOperatorSessionState): Promise<OwnedOperatorSessionState> {
    const observed = await this.runtime.readiness(state.sessionId);
    let status = state.status;
    if (state.status === 'starting') {
      status = observed === 'ready' ? 'ready' : observed === 'starting' ? 'starting' : 'unknown';
    } else if (state.status === 'stopping') {
      status = observed === 'unknown' ? 'unknown' : 'stopping';
    }
    if (status !== state.status) {
      state = { ...state, status };
      await this.store.save(state);
    } else if (status === 'ready') {
      // Fresh starts reach here from `starting`; persist even when a mock/runtime
      // returned an already-ready projection without an intermediate mutation.
      await this.store.save(state);
    }
    return state;
  }
}
