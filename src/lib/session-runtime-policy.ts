type RuntimeLifecycleState = 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping';

export interface RuntimePolicyState {
  lifecycleState: RuntimeLifecycleState;
  lifecycleGeneration: number;
  responseRevision: number;
  observationSequence: number;
  unreachableIncidentId: string | null;
  unreachableFirstObservedAt: number | null;
  unreachableDeadlineMs: number | null;
  terminationIntentId: string | null;
  terminationGeneration: number | null;
}

export function openUnreachableIncident<T extends RuntimePolicyState>(
  state: T,
  observation: { generation: number; incidentId: string; observedAtMs: number },
): T {
  if (state.lifecycleGeneration !== observation.generation || state.lifecycleState !== 'running' || state.unreachableIncidentId !== null) return state;
  return {
    ...state,
    lifecycleState: 'unreachable',
    responseRevision: state.responseRevision + 1,
    unreachableIncidentId: observation.incidentId,
    unreachableFirstObservedAt: observation.observedAtMs,
    unreachableDeadlineMs: observation.observedAtMs + 120_000,
  };
}

export function recoverUnreachableIncident<T extends RuntimePolicyState>(
  state: T,
  observation: { generation: number; incidentId: string },
): T {
  if (state.lifecycleState !== 'unreachable' || state.lifecycleGeneration !== observation.generation || state.unreachableIncidentId !== observation.incidentId) return state;
  return {
    ...state,
    lifecycleState: 'running',
    responseRevision: state.responseRevision + 1,
    unreachableIncidentId: null,
    unreachableFirstObservedAt: null,
    unreachableDeadlineMs: null,
  };
}

export function claimExpiredTermination<T extends RuntimePolicyState>(
  state: T,
  claim: { nowMs: number; intentId: string },
): T {
  if (state.lifecycleState !== 'unreachable' || state.unreachableDeadlineMs === null || claim.nowMs < state.unreachableDeadlineMs || state.terminationIntentId !== null) return state;
  return {
    ...state,
    lifecycleState: 'stopping',
    responseRevision: state.responseRevision + 1,
    terminationIntentId: claim.intentId,
    terminationGeneration: state.lifecycleGeneration,
  };
}

export function canSignalTermination(
  state: RuntimePolicyState,
  claim: { generation: number; intentId: string },
): boolean {
  return state.lifecycleState === 'stopping'
    && state.lifecycleGeneration === claim.generation
    && state.terminationGeneration === claim.generation
    && state.terminationIntentId === claim.intentId;
}

export function confirmProcessExit<T extends RuntimePolicyState>(
  state: T,
  evidence: { generation: number; intentId: string },
): T {
  if (!canSignalTermination(state, evidence)) return state;
  return {
    ...state,
    lifecycleState: 'stopped',
    responseRevision: state.responseRevision + 1,
    unreachableIncidentId: null,
    unreachableFirstObservedAt: null,
    unreachableDeadlineMs: null,
    terminationIntentId: null,
    terminationGeneration: null,
  };
}
