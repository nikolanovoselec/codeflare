import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionWithStatus } from '../../types';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';

const session = (id: string, status: SessionWithStatus['status'] = 'running'): SessionWithStatus => ({
  id,
  name: id,
  createdAt: '2026-06-18T00:00:00Z',
  lastAccessedAt: '2026-06-18T00:00:00Z',
  status,
});

describe('terminalWorkspaceStore visible pane ownership', () => {
  beforeEach(() => {
    terminalWorkspaceStore.resetForTest();
  });

  it('REQ-TERM-011: dashboard workspace has no visible terminal panes', () => {
    terminalWorkspaceStore.setSingleSessionWorkspace('session-a', '1');
    terminalWorkspaceStore.setDashboardWorkspace();

    expect(terminalWorkspaceStore.getActiveWorkspace()).toEqual({ kind: 'dashboard' });
    expect(terminalWorkspaceStore.getVisiblePanes()).toEqual([]);
    expect(terminalWorkspaceStore.getFocusedPaneId()).toBeNull();
  });

  it('REQ-TERM-011: single-session workspace exposes exactly one visible pane', () => {
    terminalWorkspaceStore.setSingleSessionWorkspace('session-a', '2');

    expect(terminalWorkspaceStore.getActiveWorkspace()).toEqual({ kind: 'session', sessionId: 'session-a' });
    expect(terminalWorkspaceStore.getVisiblePanes()).toEqual([
      { id: 'session:session-a:2', sessionId: 'session-a', terminalId: '2', source: 'session' },
    ]);
    expect(terminalWorkspaceStore.getFocusedPaneId()).toBe('session:session-a:2');
  });

  it('REQ-TERM-012: desktop MultiView accepts two to four live sessions', () => {
    const sessions = [session('a'), session('b'), session('c'), session('d'), session('e')];

    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b', 'c', 'd'], sessions, 'desktop')).toBe(true);
    expect(terminalWorkspaceStore.openMultiView()).toBe(true);

    expect(terminalWorkspaceStore.getActiveWorkspace()).toEqual({ kind: 'multiview', id: 'multiview:1' });
    expect(terminalWorkspaceStore.getVisiblePanes().map((pane) => pane.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(terminalWorkspaceStore.getLayout()).toBe('4-grid');

    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b', 'c', 'd', 'e'], sessions, 'desktop')).toBe(false);
    expect(terminalWorkspaceStore.getMultiView()?.memberSessionIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('REQ-TERM-012: tablet MultiView accepts exactly two live sessions', () => {
    const sessions = [session('a'), session('b'), session('c')];

    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b'], sessions, 'tablet')).toBe(true);
    expect(terminalWorkspaceStore.openMultiView()).toBe(true);
    expect(terminalWorkspaceStore.getVisiblePanes().map((pane) => pane.sessionId)).toEqual(['a', 'b']);
    expect(terminalWorkspaceStore.getLayout()).toBe('2-split');

    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b', 'c'], sessions, 'tablet')).toBe(false);
    expect(terminalWorkspaceStore.getMultiView()?.memberSessionIds).toEqual(['a', 'b']);
  });

  it('REQ-TERM-012: mobile cannot create MultiView', () => {
    const sessions = [session('a'), session('b')];

    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b'], sessions, 'mobile')).toBe(false);
    expect(terminalWorkspaceStore.getMultiView()).toBeNull();
    expect(terminalWorkspaceStore.openMultiView()).toBe(false);
  });

  it('REQ-TERM-012: mobile reconciliation hides but preserves an existing MultiView', () => {
    const sessions = [session('a'), session('b')];
    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b'], sessions, 'desktop')).toBe(true);
    expect(terminalWorkspaceStore.openMultiView()).toBe(true);

    const reconciled = terminalWorkspaceStore.reconcileMultiView(sessions, 'mobile');

    expect(reconciled).toBeNull();
    expect(terminalWorkspaceStore.getMultiView()?.memberSessionIds).toEqual(['a', 'b']);
    expect(terminalWorkspaceStore.getActiveWorkspace()).toEqual({ kind: 'dashboard' });
    expect(terminalWorkspaceStore.getVisiblePanes()).toEqual([]);
  });

  it('REQ-TERM-013: validation keeps only running or initializing sessions within viewport capacity', () => {
    const sessions = [session('a'), session('b', 'stopped'), session('c', 'initializing'), session('d'), session('e')];

    expect(terminalWorkspaceStore.validateMultiViewMemberIds(['a', 'b', 'c', 'd', 'e'], sessions, 'desktop')).toEqual(['a', 'c', 'd', 'e']);
    expect(terminalWorkspaceStore.validateMultiViewMemberIds(['a', 'b', 'c', 'd'], sessions, 'tablet')).toEqual(['a', 'c']);
    expect(terminalWorkspaceStore.validateMultiViewMemberIds(['a', 'c'], sessions, 'mobile')).toEqual([]);
  });

  it('REQ-TERM-013: reconciliation drops stopped members before reopening MultiView', () => {
    const sessions = [session('a'), session('b'), session('c')];
    expect(terminalWorkspaceStore.createOrUpdateMultiView(['a', 'b', 'c'], sessions, 'desktop')).toBe(true);

    const reconciled = terminalWorkspaceStore.reconcileMultiView([session('a'), session('b', 'stopped'), session('c')], 'desktop');

    expect(reconciled?.memberSessionIds).toEqual(['a', 'c']);
    expect(terminalWorkspaceStore.openMultiView()).toBe(true);
    expect(terminalWorkspaceStore.getVisiblePanes().map((pane) => pane.sessionId)).toEqual(['a', 'c']);
  });
});
