import { createSignal } from 'solid-js';
import type { AgentType } from '../types';

// In-memory ownership shared by both picker entry points and session deletion.
type CloneAttempt = { agentType?: AgentType } & (
  | { phase: 'creating'; ticket: symbol; sessionId?: string }
  | { phase: 'retrying' | 'failed'; sessionId: string });
const [attempts, setAttempts] = createSignal<ReadonlyMap<string, CloneAttempt>>(new Map());

export function cloneAttempt(repo: string) {
  return attempts().get(repo);
}

export function setCloneAttempt(repo: string, attempt?: CloneAttempt) {
  setAttempts(previous => {
    const next = new Map(previous);
    if (attempt) next.set(repo, attempt);
    else next.delete(repo);
    return next;
  });
}

export function forgetCloneAttempt(id: string, failedOnly = false) {
  for (const [repo, attempt] of attempts()) {
    if (attempt.sessionId === id && (!failedOnly || attempt.phase === 'failed')) setCloneAttempt(repo);
  }
}
