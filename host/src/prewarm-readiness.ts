import { type HostTerminalMode, isPrewarmTimeoutReady } from './terminal-mode.js';

export interface PrewarmOrphanActions {
  disposeDataListener(): void;
  clearReadinessPoll(): void;
  deleteSession(): void;
  terminateHost(): void;
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
  if (!isPrewarmTimeoutReady(mode, herdrBootstrapDone)) {
    actions.terminateHost();
    return 'bootstrap_failed';
  }
  return 'ready';
}
