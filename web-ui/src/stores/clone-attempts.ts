import { createSignal } from 'solid-js';

// In-memory ownership shared by both picker entry points and session deletion.
type CloneAttempt =
  | { phase: 'creating'; ticket: symbol; sessionId?: string }
  | { phase: 'retrying' | 'failed'; sessionId: string };
const attemptKey = (repo: string, surface?: 'chat') => `${surface ?? 'code'}:${repo}`;
const [attempts, setAttempts] = createSignal<ReadonlyMap<string, CloneAttempt>>(new Map());

export function cloneAttempt(repo: string, surface?: 'chat') {
  return attempts().get(attemptKey(repo, surface));
}

export function setCloneAttempt(repo: string, attempt?: CloneAttempt, surface?: 'chat') {
  const key = attemptKey(repo, surface);
  setAttempts(previous => {
    const next = new Map(previous);
    if (attempt) next.set(key, attempt);
    else next.delete(key);
    return next;
  });
}

export function cloneLaunchPending(repo: string): boolean {
  return [cloneAttempt(repo), cloneAttempt(repo, 'chat')].some(attempt => attempt && attempt.phase !== 'failed');
}

export function isStartingChatClone(id: string): boolean {
  return [...attempts()].some(([key, attempt]) => key.startsWith('chat:') && attempt.sessionId === id && attempt.phase !== 'failed');
}

export function forgetCloneAttempt(id: string, failedOnly = false) {
  setAttempts(previous => {
    const next = new Map(previous);
    for (const [key, attempt] of previous) {
      if (attempt.sessionId === id && (!failedOnly || attempt.phase === 'failed')) next.delete(key);
    }
    return next.size === previous.size ? previous : next;
  });
}
