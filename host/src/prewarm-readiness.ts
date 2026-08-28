import { type HostTerminalMode, isPrewarmTimeoutReady } from './terminal-mode.js';

export interface PrewarmOrphanActions {
  disposeDataListener(): void;
  clearReadinessPoll(): void;
  deleteSession(): void;
}

export type PrewarmOrphanOutcome = 'ready';

export function handlePrewarmOrphanExpiry(
  mode: HostTerminalMode,
  herdrBootstrapDone: boolean,
  actions: PrewarmOrphanActions,
): PrewarmOrphanOutcome {
  actions.disposeDataListener();
  actions.clearReadinessPoll();
  actions.deleteSession();
  if (!isPrewarmTimeoutReady(mode, herdrBootstrapDone)) {
    process.exit(1);
  }
  return 'ready';
}
