import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { cancelPiWebSwitch, getPiWebStatus, requestPiWebSwitch, type PiWebStatus } from '../api/pi-web';
import { ApiError } from '../api/fetch-helper';
import type { PiSurface } from '../types';

export function isPiWebSwitchPending(status?: PiWebStatus): boolean {
  return status?.phase === 'waiting' || status?.phase === 'stopping' || status?.phase === 'releasing' || status?.phase === 'opening';
}

/** A read-only observer by default, scoped to the selected session generation. */
export function createPiWebSurface(sessionId: string, generation: number, onDefinitiveRejection?: (requestId: string) => void) {
  const [status, setStatus] = createSignal<PiWebStatus>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [showUnavailable, setShowUnavailable] = createSignal(false);
  const [mutation, setMutation] = createSignal<'switch' | 'cancel'>();
  const [mutationError, setMutationError] = createSignal<string>();
  const [attempt, setAttempt] = createSignal<{ requestId: string; target: PiSurface }>();
  const [rejectedSwitch, setRejectedSwitch] = createSignal<{ id: string; status: number; observation: number }>();
  const lifetime = new AbortController();
  let read: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observation = 0;
  let command = 0;

  const publish = (next: PiWebStatus) => {
    setStatus(previous => next.surface === 'chat' && previous?.surface === 'chat' && next.chatUrl === undefined
      ? { ...next, chatUrl: previous.chatUrl }
      : next);
    const submitted = attempt();
    if (submitted && !isPiWebSwitchPending(next) && (
      (next.phase === 'cancelled' && next.requestId === submitted.requestId)
      || ((next.phase === 'active' || next.phase === 'complete') && next.surface === submitted.target)
    )) {
      setAttempt(undefined);
      setMutationError(undefined);
    }
    setUnavailable(false);
    setShowUnavailable(false);
  };

  const refresh = async () => {
    clearTimeout(timer);
    read?.abort();
    if (lifetime.signal.aborted) return;
    const current = read = new AbortController();
    try {
      const next = await getPiWebStatus(sessionId, generation, AbortSignal.any([current.signal, AbortSignal.timeout(5000)]));
      if (current.signal.aborted) return;
      observation++;
      publish(next);
    } catch (error) {
      if (!current.signal.aborted) {
        const previous = status();
        const transient = !(error instanceof ApiError) || error.status >= 500;
        const settledChat = previous?.surface === 'chat' && !!previous.chatUrl
          && (previous.phase === 'active' || previous.phase === 'complete') && !mutation() && !attempt();
        // A missed poll after returning from a native picker must not resize an
        // already-open composer. Keep the mutation guard immediate.
        if (!settledChat || !transient || unavailable()) setShowUnavailable(true);
        setUnavailable(true);
      }
    } finally {
      if (!current.signal.aborted) {
        timer = setTimeout(() => void refresh(), mutation() || isPiWebSwitchPending(status()) ? 1000 : 5000);
      }
    }
  };

  createEffect(() => { if (!read) void untrack(refresh); });
  onCleanup(() => {
    lifetime.abort();
    read?.abort();
    clearTimeout(timer);
  });

  const mutate = async (kind: 'switch' | 'cancel', send: (signal: AbortSignal) => Promise<PiWebStatus>) => {
    const ownCommand = ++command;
    const observed = observation;
    const requestId = attempt()?.requestId;
    const stillCurrent = () => !lifetime.signal.aborted && ownCommand === command;
    setMutation(kind);
    setMutationError(undefined);
    void refresh(); // Read waiting state even if the switch response arrives after the turn settles.
    try {
      const next = await send(AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
      if (stillCurrent() && observed === observation) publish(next);
    } catch (error) {
      if (stillCurrent()) {
        const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
        if (rejected && kind === 'switch') {
          if (requestId) {
            if (error.status !== 409) onDefinitiveRejection?.(requestId);
            setRejectedSwitch({ id: requestId, status: error.status, observation });
          }
          setAttempt(undefined);
        }
        setMutationError(kind === 'cancel'
          ? 'Could not cancel the switch.'
          : rejected ? 'The Pi switch was not accepted.' : 'Could not confirm the switch.');
      }
    } finally {
      if (stillCurrent()) {
        setMutation(undefined);
        void refresh();
      }
    }
  };

  const retryAttempt = () => {
    const current = status();
    if (current?.recovery === 'reopen-session') return undefined;
    if ((current?.phase === 'failed' || current?.phase === 'uncertain') && current.requestId && current.target) {
      return { requestId: current.requestId, target: current.target };
    }
    return mutationError() ? attempt() : undefined;
  };

  const select = (target: PiSurface) => {
    const current = status();
    if (lifetime.signal.aborted || mutation() || isPiWebSwitchPending(current) || current?.recovery === 'reopen-session') return;
    const retry = retryAttempt();
    if (!retry && current?.surface === target) return;
    if (retry && retry.target !== target) return;
    const requestId = retry?.requestId ?? crypto.randomUUID();
    setAttempt({ requestId, target });
    void mutate('switch', signal => requestPiWebSwitch(sessionId, generation, target, requestId, signal));
  };

  const cancel = () => {
    const current = status();
    const requestId = current?.requestId;
    if (current?.phase !== 'waiting' || !requestId || mutation() === 'cancel' || lifetime.signal.aborted) return;
    void mutate('cancel', signal => cancelPiWebSwitch(sessionId, generation, requestId, signal));
  };

  return {
    status,
    unavailable,
    showUnavailable,
    mutation,
    submittedSwitch: attempt,
    rejectedSwitchId: () => rejectedSwitch()?.id,
    canRetryFailedStartup: (requestId: string) => {
      const current = status();
      const rejection = rejectedSwitch();
      return !unavailable() && !mutation() && current?.phase === 'failed' && current.requestId === requestId
        && (rejection?.id !== requestId || (rejection.status === 409 && observation > rejection.observation));
    },
    switchingTarget: () => !mutationError() ? attempt()?.target : undefined,
    mutationError,
    select,
    cancel,
    retry: () => {
      const retry = retryAttempt();
      if (retry) select(retry.target);
    },
    canRetry: () => Boolean(retryAttempt()) && !isPiWebSwitchPending(status()) && !mutation(),
  };
}
