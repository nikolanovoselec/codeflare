import { type HostTerminalMode, isPrewarmTimeoutReady } from './terminal-mode.js';

export interface PrewarmOrphanActions {
  disposeDataListener(): void;
  clearReadinessPoll(): void;
  deleteSession(): void;
}

export type PrewarmOrphanOutcome = 'ready' | 'bootstrap_failed';

export function handlePrewarmOrphanExpiry(
  mode: HostTerminalMode,
  herdrBootstrapDone: boolean,
  actions: PrewarmOrphanActions,
): PrewarmOrphanOutcome {
  actions.disposeDataListener();
  actions.clearReadinessPoll();
  actions.deleteSession();
  return isPrewarmTimeoutReady(mode, herdrBootstrapDone) ? 'ready' : 'bootstrap_failed';
}
