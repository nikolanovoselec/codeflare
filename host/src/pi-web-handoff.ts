// REQ-AGENT-272: the outgoing writer is fenced and released before the next opens.
export type PiSurface = 'chat' | 'terminal';
export type PiWebAdmission = 'read' | 'work' | 'settle';
export interface PiTranscript {
  id: string;
  cwd: string;
  path: string;
}
export interface PiSwitchRequest {
  generation: number;
  target: PiSurface;
  requestId: string;
}
export interface PiSwitchStatus {
  phase: 'active' | 'waiting' | 'stopping' | 'releasing' | 'opening' | 'complete' | 'failed' | 'uncertain' | 'cancelled';
  surface: PiSurface | null;
  target?: PiSurface;
  requestId?: string;
}
interface Options {
  generation: number;
  initialSurface: PiSurface;
  stopWork(surface: PiSurface): Promise<void>;
  waitForIdle(surface: PiSurface, signal: AbortSignal): Promise<void>;
  // Undefined proves release never began and the source needs to settle again.
  release(surface: PiSurface): Promise<PiTranscript | undefined>;
  // False proves no destination writer remains. A throw leaves ownership unknown.
  open(surface: PiSurface, transcript: PiTranscript): Promise<boolean>;
  confirmOpen?(surface: PiSurface, transcript: PiTranscript): boolean;
  onChange?(status: PiSwitchStatus): void;
}

export function createPiWebHandoff(options: Options) {
  let state: PiSwitchStatus = { phase: 'active', surface: options.initialSurface };
  let current: { input: PiSwitchRequest; abort: AbortController; result: Promise<PiSwitchStatus> } | undefined;
  let released: PiTranscript | undefined;
  const requests = new Map<Promise<void>, PiWebAdmission>();

  const status = (): PiSwitchStatus => ({ ...state });
  function set(next: PiSwitchStatus): void {
    // Publish synchronously: private launcher admission changes in this tick.
    // If publishing fails, the next writer must never be opened.
    options.onChange?.(next);
    state = next;
  }
  function permits(surface: PiSurface, kind: PiWebAdmission): boolean {
    // With the old writer already released, the stock Chat frame can open
    // its exact bound transcript and answer a native startup dialog.
    if (state.phase === 'opening') return surface === 'chat' && state.target === 'chat' && kind !== 'work';
    if (state.surface !== surface) return false;
    if (state.phase === 'waiting' || state.phase === 'stopping') return kind !== 'work';
    return state.phase === 'active' || state.phase === 'cancelled' || state.phase === 'complete' || state.phase === 'failed';
  }
  function admit(surface: PiSurface, kind: PiWebAdmission): (() => void) | undefined {
    if (!permits(surface, kind)) return undefined;
    let done!: () => void;
    const pending = new Promise<void>(resolve => { done = resolve; });
    requests.set(pending, kind);
    return () => { requests.delete(pending); done(); };
  }
  async function switchTo(input: PiSwitchRequest): Promise<PiSwitchStatus> {
    if (input.generation !== options.generation) throw new Error('Pi workspace generation changed');
    const { requestId, target } = input;
    if (current) {
      if (current.input.requestId !== requestId || current.input.target !== target) {
        throw new Error('Another Pi switch is in progress');
      }
      return current.result;
    }
    if (state.requestId === requestId && state.target !== target) throw new Error('Switch request target changed');
    if (state.phase === 'uncertain') {
      if (state.requestId !== requestId) throw new Error('The previous Pi writer is unconfirmed');
      // Only a matching late launch receipt can reconcile; a retry never
      // dispatches a second launch while ownership is uncertain.
      if (released && options.confirmOpen?.(target, released)) {
        set({ requestId, target, phase: 'complete', surface: target });
        released = undefined;
      }
      return status();
    }
    if (state.surface === target) return status();
    if (!state.surface && (state.requestId !== requestId || !released)) throw new Error('Retry the previous Pi switch');
    const source = state.surface;
    const abort = new AbortController();
    const attempt = { requestId, target };
    if (source) set({ ...attempt, phase: 'waiting', surface: source });
    const result = Promise.resolve().then(async () => {
      if (source) {
        try {
          // Earlier admitted web POSTs may start work after admission. Wait for
          // them before reading runtime idle; track later dialog/abort I/O too.
          await new Promise<void>((resolve, reject) => {
            const cancelled = () => reject(abort.signal.reason);
            if (abort.signal.aborted) { cancelled(); return; }
            abort.signal.addEventListener('abort', cancelled, { once: true });
            void Promise.all([...requests].filter(([, kind]) => kind === 'work').map(([done]) => done)).then(() => {
              abort.signal.removeEventListener('abort', cancelled);
              resolve();
            });
          });
          abort.signal.throwIfAborted();
          set({ ...attempt, phase: 'stopping', surface: source });
          await options.stopWork(source);
        } catch {
          set({ ...attempt, phase: abort.signal.aborted ? 'cancelled' : 'failed', surface: source });
          return status();
        }
        do {
          try { await options.waitForIdle(source, abort.signal); }
          catch {
            set({ ...attempt, phase: 'failed', surface: source });
            return status();
          }
          set({ ...attempt, phase: 'releasing', surface: source });
          // Reads can open stock sessions. Drain them and any admitted answers
          // before release; an answer might have introduced new work.
          await Promise.all(requests.keys());
          try { released = await options.release(source); }
          catch {
            set({ ...attempt, phase: 'uncertain', surface: null });
            return status();
          }
          if (!released) set({ ...attempt, phase: 'stopping', surface: source });
        } while (!released);
      }
      const transcript = released;
      if (!transcript) throw new Error('No Pi transcript was released');
      set({ ...attempt, phase: 'opening', surface: null });
      let opened: boolean;
      try { opened = await options.open(target, transcript); }
      catch {
        set({ ...attempt, phase: 'uncertain', surface: null });
        return status();
      }
      set({ ...attempt, phase: opened ? 'complete' : 'failed', surface: opened ? target : null });
      if (opened) released = undefined;
      return status();
    }).finally(() => { current = undefined; });
    current = { input, abort, result };
    return result;
  }
  function cancel(input: Pick<PiSwitchRequest, 'generation' | 'requestId'>): boolean {
    if (input.generation !== options.generation || state.phase !== 'waiting'
      || current?.input.requestId !== input.requestId) return false;
    current.abort.abort();
    return true;
  }
  function openInitialChat(requestId: string, transcript: PiTranscript): Promise<PiSwitchStatus> {
    if (state.phase !== 'active' || state.surface !== 'chat' || current) throw new Error('Pi workspace already initialized');
    released = transcript;
    set({ phase: 'opening', surface: null, target: 'chat', requestId });
    return switchTo({ generation: options.generation, target: 'chat', requestId });
  }
  return { status, switchTo, openInitialChat, cancel, permits, admit };
}
