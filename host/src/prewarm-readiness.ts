import { type HostTerminalMode, isPrewarmTimeoutReady } from './terminal-mode.js';

export interface PrewarmOrphanActions {
  disposeDataListener(): void;
  clearReadinessPoll(): void;
  deleteSession(): void;
}

export type PrewarmOrphanOutcome = 'ready' | 'retained';

export function handlePrewarmOrphanExpiry(
  mode: HostTerminalMode,
  herdrBootstrapDone: boolean,
  actions: PrewarmOrphanActions,
  retainManagedPrimary = false,
): PrewarmOrphanOutcome {
  actions.disposeDataListener();
  actions.clearReadinessPoll();
  const usable = isPrewarmTimeoutReady(mode, herdrBootstrapDone);
  if (usable && retainManagedPrimary) return 'retained';
  actions.deleteSession();
  if (!usable) {
    process.exit(1);
  }
  return 'ready';
}
