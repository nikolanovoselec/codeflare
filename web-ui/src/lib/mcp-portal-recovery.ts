import { getMcpPortalStatuses, recoverMcpPortal } from '../api/mcp-portals';
import { ApiError } from '../api/fetch-helper';
import { dashboardPath, parseSessionPath } from './session-path';

const STORAGE_KEY = 'codeflare-mcp-recovery';
export type McpReturnOutcome = 'connected' | 'reconnect';
type RecoveryState = { owner: string; attempted: string[]; returnPath: string; pending?: string; outcome?: McpReturnOutcome };
const canonicalPath = (path: string) => path === dashboardPath() || parseSessionPath(path) !== undefined;

/** Browser-only retry guard and canonical view intent; never stores OAuth credentials. */
export function createMcpPortalRecovery(owner: string, navigate: (url: string) => void, onAuthError: (error: unknown) => void,
  onReturn?: (outcome: McpReturnOutcome | undefined) => void) {
  let state: RecoveryState = { owner, attempted: [], returnPath: dashboardPath() };
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (stored && typeof stored === 'object' && 'owner' in stored && stored.owner === owner
      && 'attempted' in stored && Array.isArray(stored.attempted)
      && stored.attempted.every(item => typeof item === 'string' && item.length <= 2048)
      && 'returnPath' in stored && typeof stored.returnPath === 'string' && canonicalPath(stored.returnPath)
      && (!('pending' in stored) || typeof stored.pending === 'string' && stored.attempted.includes(stored.pending))
      && (!('outcome' in stored) || stored.outcome === 'connected' || stored.outcome === 'reconnect')) {
      state = stored as RecoveryState;
    }
  } catch { /* No trustworthy recovery intent: do not restore a stored location. */ }
  const save = () => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
    catch { return false; }
  };
  const returned = new URLSearchParams(window.location.search).get('mcp');
  if (returned === 'connected' || returned === 'reconnect') {
    state.outcome = returned;
    if (state.pending) {
      // Fixed callback landing is cleaned before Layout performs owned-session reconciliation.
      window.history.replaceState({}, '', state.returnPath);
      delete state.pending;
    } else {
      const params = new URLSearchParams(window.location.search);
      params.delete('mcp');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    save();
  }
  onReturn?.(state.outcome);

  let disposed = false;
  let navigating = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const pause = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const active = () => !disposed && !navigating && document.visibilityState !== 'hidden';
  const run = async () => {
    try {
      const portals = await getMcpPortalStatuses();
      if (!active()) return;
      const keys = new Set(portals.map(portal => `${portal.name}\n${portal.url}`));
      state.attempted = state.attempted.filter(key => keys.has(key));
      for (const portal of portals) {
        if (!active()) return;
        const key = `${portal.name}\n${portal.url}`;
        const attempted = state.attempted.includes(key);
        const result = await recoverMcpPortal(portal.name, !attempted);
        if (!active()) return;
        if (result.state === 'ready') {
          state.attempted = state.attempted.filter(item => item !== key);
          save();
        } else if (result.state === 'authorization' && !attempted) {
          const url = new URL(result.url);
          if (url.protocol !== 'https:' || url.username || url.password) continue;
          state.attempted.push(key);
          delete state.outcome;
          state.pending = key;
          state.returnPath = canonicalPath(window.location.pathname) ? window.location.pathname : dashboardPath();
          // Without a durable per-tab guard, an OAuth return could loop. Fail closed.
          if (!save()) { delete state.pending; continue; }
          navigating = true;
          navigate(url.href);
          return;
        }
      }
    } catch (error) {
      if (disposed) return;
      if (error instanceof ApiError && (error.status === 401 || error.authRedirect)) {
        disposed = true;
        onAuthError(error);
      }
      // Transient errors wait for the next visible pass; never manufacture an OAuth redirect.
    }
  };
  const check = (): Promise<void> => {
    pause();
    if (!active()) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = undefined;
      if (active()) timer = setTimeout(() => { void check(); }, 60_000);
    });
    return inFlight;
  };
  return { check, pause, dispose() { disposed = true; pause(); } };
}
