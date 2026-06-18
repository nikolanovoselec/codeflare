import { createStore } from 'solid-js/store';
import type {
  ActiveWorkspace,
  MultiViewWorkspace,
  SessionWithStatus,
  TerminalViewportClass,
  TerminalWorkspaceState,
  TileLayout,
  VisibleTerminalPane,
} from '../types';

const MULTIVIEW_STORAGE_KEY = 'codeflare:terminalMultiViewWorkspace';
const MULTIVIEW_ID = 'multiview:1' as const;

function paneId(source: VisibleTerminalPane['source'], sessionId: string, terminalId: string): string {
  return `${source === 'multiview' ? 'multiview' : 'session'}:${sessionId}:${terminalId}`;
}

function paneForSession(sessionId: string, terminalId = '1', source: VisibleTerminalPane['source']): VisibleTerminalPane {
  return { id: paneId(source, sessionId, terminalId), sessionId, terminalId, source };
}

function layoutForCount(count: number): Exclude<TileLayout, 'tabbed'> {
  if (count >= 4) return '4-grid';
  if (count === 3) return '3-split';
  return '2-split';
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function liveSessionIds(sessions: SessionWithStatus[]): Set<string> {
  return new Set(
    sessions
      .filter((session) => session.status === 'running' || session.status === 'initializing')
      .map((session) => session.id),
  );
}

function readPersistedMultiView(): MultiViewWorkspace | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MULTIVIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MultiViewWorkspace;
    if (parsed?.id !== MULTIVIEW_ID || !Array.isArray(parsed.memberSessionIds)) return null;
    if (parsed.memberSessionIds.length < 2) return null;
    return {
      id: MULTIVIEW_ID,
      name: 'MultiView #1',
      memberSessionIds: uniqueIds(parsed.memberSessionIds),
      focusedSessionId: parsed.focusedSessionId ?? parsed.memberSessionIds[0] ?? null,
      layout: parsed.layout || layoutForCount(parsed.memberSessionIds.length),
    };
  } catch {
    return null;
  }
}

function persistMultiView(workspace: MultiViewWorkspace | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!workspace) {
      localStorage.removeItem(MULTIVIEW_STORAGE_KEY);
      return;
    }
    localStorage.setItem(MULTIVIEW_STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    // Local persistence is best-effort; never block terminal ownership on it.
  }
}

function initialState(): TerminalWorkspaceState {
  return {
    mode: 'dashboard',
    activeWorkspace: { kind: 'dashboard' },
    panes: [],
    focusedPaneId: null,
    layout: 'tabbed',
    multiView: readPersistedMultiView(),
  };
}

const [state, setState] = createStore<TerminalWorkspaceState>(initialState());

function getMultiViewCapacity(viewport: TerminalViewportClass): number {
  if (viewport === 'desktop') return 4;
  if (viewport === 'tablet') return 2;
  return 0;
}

function validateMultiViewMemberIds(
  memberSessionIds: string[],
  sessions: SessionWithStatus[],
  viewport: TerminalViewportClass,
): string[] {
  const capacity = getMultiViewCapacity(viewport);
  if (capacity === 0) return [];
  const live = liveSessionIds(sessions);
  return uniqueIds(memberSessionIds)
    .filter((id) => live.has(id))
    .slice(0, capacity);
}

function setDashboardWorkspace(): void {
  if (state.mode === 'dashboard' && state.panes.length === 0 && state.focusedPaneId === null) return;
  setState({
    mode: 'dashboard',
    activeWorkspace: { kind: 'dashboard' },
    panes: [],
    focusedPaneId: null,
    layout: 'tabbed',
  });
}

function setSingleSessionWorkspace(sessionId: string, terminalId = '1'): void {
  const pane = paneForSession(sessionId, terminalId, 'session');
  if (
    state.mode === 'single-session'
    && state.activeWorkspace.kind === 'session'
    && state.activeWorkspace.sessionId === sessionId
    && state.panes.length === 1
    && state.panes[0]?.id === pane.id
    && state.focusedPaneId === pane.id
  ) return;
  setState({
    mode: 'single-session',
    activeWorkspace: { kind: 'session', sessionId },
    panes: [pane],
    focusedPaneId: pane.id,
    layout: 'tabbed',
  });
}

function reconcileMultiView(sessions: SessionWithStatus[], viewport: TerminalViewportClass): MultiViewWorkspace | null {
  const workspace = state.multiView;
  if (!workspace) return null;

  if (getMultiViewCapacity(viewport) === 0) {
    if (state.mode === 'multiview') {
      setDashboardWorkspace();
    }
    return null;
  }

  const members = validateMultiViewMemberIds(workspace.memberSessionIds, sessions, viewport);
  if (members.length < 2) {
    closeMultiView();
    return null;
  }

  const next: MultiViewWorkspace = {
    id: MULTIVIEW_ID,
    name: 'MultiView #1',
    memberSessionIds: members,
    focusedSessionId: workspace.focusedSessionId && members.includes(workspace.focusedSessionId)
      ? workspace.focusedSessionId
      : members[0],
    layout: layoutForCount(members.length),
  };

  const changed = workspace.memberSessionIds.length !== next.memberSessionIds.length
    || workspace.memberSessionIds.some((id, index) => id !== next.memberSessionIds[index])
    || workspace.focusedSessionId !== next.focusedSessionId
    || workspace.layout !== next.layout;

  if (changed) {
    setState('multiView', next);
    persistMultiView(next);
    if (state.mode === 'multiview') {
      openMultiView();
    }
  }

  return changed ? next : workspace;
}

function createOrUpdateMultiView(
  memberSessionIds: string[],
  sessions: SessionWithStatus[],
  viewport: TerminalViewportClass,
): boolean {
  const capacity = getMultiViewCapacity(viewport);
  if (capacity === 0) return false;

  const live = liveSessionIds(sessions);
  const members = uniqueIds(memberSessionIds).filter((id) => live.has(id));
  if (members.length < 2 || members.length > capacity) return false;

  const workspace: MultiViewWorkspace = {
    id: MULTIVIEW_ID,
    name: 'MultiView #1',
    memberSessionIds: members,
    focusedSessionId: state.multiView?.focusedSessionId && members.includes(state.multiView.focusedSessionId)
      ? state.multiView.focusedSessionId
      : members[0],
    layout: layoutForCount(members.length),
  };

  setState('multiView', workspace);
  persistMultiView(workspace);
  return true;
}

function openMultiView(): boolean {
  const workspace = state.multiView;
  if (!workspace || workspace.memberSessionIds.length < 2) return false;

  const panes = workspace.memberSessionIds.map((sessionId) => paneForSession(sessionId, '1', 'multiview'));
  const focusedSessionId = workspace.focusedSessionId && workspace.memberSessionIds.includes(workspace.focusedSessionId)
    ? workspace.focusedSessionId
    : workspace.memberSessionIds[0];
  const focusedPaneId = paneId('multiview', focusedSessionId, '1');

  if (
    state.mode === 'multiview'
    && state.panes.length === panes.length
    && state.panes.every((pane, index) => pane.id === panes[index]?.id)
    && state.focusedPaneId === focusedPaneId
    && state.layout === workspace.layout
  ) return true;

  setState({
    mode: 'multiview',
    activeWorkspace: { kind: 'multiview', id: MULTIVIEW_ID },
    panes,
    focusedPaneId,
    layout: workspace.layout,
  });
  return true;
}

function closeMultiView(): void {
  setState('multiView', null);
  persistMultiView(null);
  if (state.mode === 'multiview') {
    setDashboardWorkspace();
  }
}

function setFocusedPane(paneIdValue: string): void {
  const pane = state.panes.find((candidate) => candidate.id === paneIdValue);
  if (!pane) return;
  setState('focusedPaneId', paneIdValue);
  if (state.mode === 'multiview' && state.multiView) {
    const next = { ...state.multiView, focusedSessionId: pane.sessionId };
    setState('multiView', next);
    persistMultiView(next);
  }
}

function resetForTest(): void {
  persistMultiView(null);
  setState({
    mode: 'dashboard',
    activeWorkspace: { kind: 'dashboard' },
    panes: [],
    focusedPaneId: null,
    layout: 'tabbed',
    multiView: null,
  });
}

export const terminalWorkspaceStore = {
  get mode() { return state.mode; },
  get multiView() { return state.multiView; },
  getActiveWorkspace: (): ActiveWorkspace => state.activeWorkspace,
  getVisiblePanes: (): VisibleTerminalPane[] => [...state.panes],
  getFocusedPaneId: (): string | null => state.focusedPaneId,
  getLayout: (): TileLayout => state.layout,
  getMultiView: (): MultiViewWorkspace | null => state.multiView,
  getMultiViewCapacity,
  validateMultiViewMemberIds,
  reconcileMultiView,
  setDashboardWorkspace,
  setSingleSessionWorkspace,
  createOrUpdateMultiView,
  openMultiView,
  closeMultiView,
  setFocusedPane,
  resetForTest,
};
