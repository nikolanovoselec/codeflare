export type BackendLifecycle = 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping';
export interface OrderedProjection {
  lifecycle: BackendLifecycle;
  generation?: number;
  revision?: number;
  editorReady?: boolean;
  incidentDeadlineMs?: number;
  [key: string]: unknown;
}

export interface TerminalPresentation {
  lifecycle: BackendLifecycle;
  label: string;
  color: string;
  mounted: boolean;
  dispose: boolean;
  deadlineExpired?: boolean;
  persistedState?: never;
}

export function terminalPresentation(projection: OrderedProjection, local: { terminalConnected: boolean; nowMs?: number }): TerminalPresentation {
  if (projection.lifecycle === 'running') {
    return { lifecycle: projection.lifecycle, label: local.terminalConnected ? 'ACTIVE' : 'IDLE', color: local.terminalConnected ? 'green' : 'blue', mounted: true, dispose: false };
  }
  if (projection.lifecycle === 'starting' || projection.lifecycle === 'unreachable' || projection.lifecycle === 'stopping') {
    return {
      lifecycle: projection.lifecycle,
      label: projection.lifecycle === 'starting' ? 'STARTING' : projection.lifecycle === 'unreachable' ? 'UNREACHABLE' : 'STOPPING',
      color: 'yellow', mounted: true, dispose: false,
      deadlineExpired: projection.incidentDeadlineMs !== undefined && local.nowMs !== undefined && local.nowMs >= projection.incidentDeadlineMs,
    };
  }
  return { lifecycle: projection.lifecycle, label: projection.lifecycle.toUpperCase(), color: 'gray', mounted: false, dispose: true };
}

export function vscodePresentation(projection: OrderedProjection, local: { transportReachable: boolean }) {
  const stopped = projection.lifecycle === 'stopped';
  return {
    indicator: projection.lifecycle === 'starting' ? 'yellow' : stopped ? 'gray' : 'green',
    mounted: !stopped,
    connectivityNotice: { visible: projection.lifecycle === 'unreachable' || !local.transportReachable, role: 'status' },
  };
}

export function applyOrderedProjection(current: OrderedProjection, incoming: OrderedProjection): OrderedProjection {
  if (current.generation !== undefined && incoming.generation !== undefined) {
    if (incoming.generation < current.generation) return current;
    if (incoming.generation === current.generation
      && current.revision !== undefined
      && incoming.revision !== undefined
      && incoming.revision < current.revision) return current;
  }
  return incoming;
}

/** Lifecycle states whose workspace remains mounted and selectable. */
export function isMountedLifecycle(lifecycle: BackendLifecycle): boolean {
  return lifecycle !== 'stopped';
}

export function applyStatusFailure<T extends OrderedProjection>(current: T, _error: unknown): T & { mounted: true; statusUnavailable: true } {
  return { ...current, mounted: true, statusUnavailable: true };
}
