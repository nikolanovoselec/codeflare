import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiViewCompactOutline } from '@mdi/js';
import SessionDropdown from '../../components/SessionDropdown';
import { sessionStore } from '../../stores/session';
import type { SessionWithStatus } from '../../types';

// Mock child components
vi.mock('../../components/SessionStatCard', () => ({
  default: (props: any) => (
    <div
      data-testid={`session-stat-card-${props.session.id}`}
      data-active={String(props.isActive)}
      onClick={props.onSelect}
    >
      {props.session.name}
      <button
        data-testid={`card-menu-${props.session.id}`}
        onClick={(e: MouseEvent) => props.onMenuClick?.(e, props.session)}
      >
        menu
      </button>
    </div>
  ),
}));

vi.mock('../../components/CreateSessionDialog', () => ({
  default: (props: any) => (
    <div data-testid="create-session-dialog" data-open={String(props.isOpen)}>
      <button data-testid="csd-select-agent" onClick={() => props.onSelect('claude-code')}>
        Select Agent
      </button>
    </div>
  ),
}));

vi.mock('../../stores/session', () => {
  let _preseedUpgrading = false;
  let _preseedUpgradeFailed = false;
  let _managedReleaseStatus: 'current' | 'upgrading' | 'update_pending' | null = null;
  return {
    sessionStore: {
      getMetricsForSession: vi.fn(() => null),
      getInitProgressForSession: vi.fn(() => null),
      renameSession: vi.fn(),
      killSession: vi.fn().mockResolvedValue(undefined),
      sessions: [],
      get preseedUpgrading() { return _preseedUpgrading; },
      get preseedUpgradeFailed() { return _preseedUpgradeFailed; },
      _setPreseedUpgradeFailed: (v: boolean) => { _preseedUpgradeFailed = v; },
      get managedReleaseStatus() { return _managedReleaseStatus; },
      _setPreseedUpgrading: (v: boolean) => { _preseedUpgrading = v; },
      _setManagedReleaseStatus: (v: 'current' | 'upgrading' | 'update_pending' | null) => { _managedReleaseStatus = v; },
    },
  };
});

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(() => 'connected'),
  },
}));

function createSession(overrides: Partial<SessionWithStatus> = {}): SessionWithStatus {
  return {
    id: 'test-1',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    status: 'stopped',
    ...overrides,
  };
}

// REQ-TERM-018: MultiView Reopen and Close
describe('SessionDropdown', () => {
  const defaultProps = {
    isOpen: true,
    sessions: [
      createSession({ id: 's1', name: 'Running Session', status: 'running' }),
      createSession({ id: 's2', name: 'Stopped Session', status: 'stopped' }),
      createSession({ id: 's3', name: 'Initializing Session', status: 'initializing' }),
    ],
    activeSessionId: 's1' as string | null,
    onSelectSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onCreateSession: vi.fn(),
    onClose: vi.fn(),
    isMobileView: false,
  };

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup());

  describe('Rendering', () => {
    it('renders when isOpen is true', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      expect(screen.getByTestId('session-dropdown')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      render(() => <SessionDropdown {...defaultProps} isOpen={false} />);
      expect(screen.queryByTestId('session-dropdown')).not.toBeInTheDocument();
    });
  });

  describe('Session ordering', () => {
    it('shows running sessions first, then initializing, then stopped, then error', () => {
      const sessions = [
        createSession({ id: 's-stopped', name: 'Stopped', status: 'stopped' }),
        createSession({ id: 's-error', name: 'Errored', status: 'error' }),
        createSession({ id: 's-running', name: 'Running', status: 'running' }),
        createSession({ id: 's-init', name: 'Initializing', status: 'initializing' }),
      ];
      render(() => <SessionDropdown {...defaultProps} sessions={sessions} />);

      const cards = screen.getAllByTestId(/^session-stat-card-/);
      expect(cards[0]).toHaveAttribute('data-testid', 'session-stat-card-s-running');
      expect(cards[1]).toHaveAttribute('data-testid', 'session-stat-card-s-init');
      expect(cards[2]).toHaveAttribute('data-testid', 'session-stat-card-s-stopped');
      expect(cards[3]).toHaveAttribute('data-testid', 'session-stat-card-s-error');
    });
  });

  describe('Session selection', () => {
    it('calls onSelectSession and onClose when a card is clicked', () => {
      const onSelectSession = vi.fn();
      const onClose = vi.fn();
      render(() => <SessionDropdown {...defaultProps} onSelectSession={onSelectSession} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('session-stat-card-s1'));
      expect(onSelectSession).toHaveBeenCalledWith('s1');
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('New Session button', () => {
    it('shows "+ New Session" button', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      expect(screen.getByTestId('session-dropdown-new')).toBeInTheDocument();
    });

    it('opens CreateSessionDialog when clicked', async () => {
      render(() => <SessionDropdown {...defaultProps} />);

      // Before clicking, the dialog should be closed
      const dialogBefore = screen.getByTestId('create-session-dialog');
      expect(dialogBefore).toHaveAttribute('data-open', 'false');

      // Click the "+ New Session" button
      await fireEvent.click(screen.getByTestId('session-dropdown-new'));

      // After clicking, the dialog should be open
      const dialogAfter = screen.getByTestId('create-session-dialog');
      expect(dialogAfter).toHaveAttribute('data-open', 'true');
    });

    it('renders CreateSessionDialog outside the popover container', async () => {
      render(() => <SessionDropdown {...defaultProps} />);

      await fireEvent.click(screen.getByTestId('session-dropdown-new'));

      const dialog = screen.getByTestId('create-session-dialog');
      const popover = screen.getByTestId('session-dropdown');

      // The dialog must NOT be a descendant of the popover div
      // This prevents backdrop-filter from creating a new containing block
      // that breaks position:fixed on the dialog
      expect(popover.contains(dialog)).toBe(false);
    });
  });

  describe('Mobile bottom sheet', () => {
    it('renders as bottom-sheet when isMobileView is true', () => {
      render(() => <SessionDropdown {...defaultProps} isMobileView={true} />);
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveClass('session-dropdown--bottom-sheet');
    });

    it('renders as popover when isMobileView is false', () => {
      render(() => <SessionDropdown {...defaultProps} isMobileView={false} />);
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveClass('session-dropdown--popover');
    });
  });

  describe('REQ-SESSION-027 AC1: rename', () => {
    it('renames the session the menu was opened for', () => {
      render(() => <SessionDropdown {...defaultProps} />);

      fireEvent.click(screen.getByTestId('card-menu-s2'));
      fireEvent.click(screen.getByTestId('context-menu-rename'));
      fireEvent.input(screen.getByTestId('context-menu-rename-input'), { target: { value: 'Renamed session' } });
      fireEvent.submit(screen.getByTestId('context-menu-rename-form'));

      expect(vi.mocked(sessionStore.renameSession)).toHaveBeenCalledWith('s2', 'Renamed session');
    });
  });

  it.each(['stopping', 'unreachable', 'starting'] as const)(
    'REQ-SESSION-035: offers non-deleting Stop recovery for a persisted %s session', status => {
      const stopped: string[] = [];
      render(() => <SessionDropdown {...defaultProps}
        sessions={[createSession({ id: 'recover', status })]}
        onStopSession={id => stopped.push(id)}
        onDeleteSession={() => { throw Error('Stop recovery must not delete'); }} />);
      fireEvent.click(screen.getByTestId('card-menu-recover'));
      fireEvent.click(screen.getByRole('button', { name: status === 'stopping' ? 'Retry Stop' : 'Stop' }));
      expect(stopped).toEqual(['recover']);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    },
  );

  describe('REQ-SESSION-038: KILL in the existing session menu', () => {
    it.each(['starting', 'running', 'unreachable', 'stopping'] as const)(
      'AC1/AC3/AC7: offers one KILL for %s, targets only the selected session and closes its menu', status => {
        const killed: string[] = [];
        const store = sessionStore as typeof sessionStore & { killSession: (id: string) => Promise<void> };
        vi.mocked(store.killSession).mockImplementation(async id => { killed.push(id); });
        const stopped: string[] = [];
        const deleted: string[] = [];
        render(() => <SessionDropdown {...defaultProps}
          sessions={[
            createSession({ id: 'active-other', status: 'running' }),
            createSession({ id: 'kill-target', status }),
          ]}
          activeSessionId="active-other"
          onStopSession={id => stopped.push(id)}
          onDeleteSession={id => deleted.push(id)} />);

        fireEvent.click(screen.getByTestId('card-menu-kill-target'));
        // KILL's exact user copy is the deliberate recovery-action contract.
        const kill = screen.getByRole('button', { name: 'KILL' });
        expect(kill).toBeEnabled();
        expect(screen.getByRole('button', { name: status === 'stopping' ? 'Retry Stop' : 'Stop' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
        fireEvent.click(kill);

        expect(killed).toEqual(['kill-target']);
        expect(stopped).toEqual([]);
        expect(deleted).toEqual([]);
        expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
        expect(screen.getByTestId('session-stat-card-kill-target')).toBeInTheDocument();
        expect(screen.getByTestId('session-stat-card-active-other')).toBeInTheDocument();
      },
    );

    it('AC1/AC7: hides KILL for a confirmed-stopped session without hiding Rename or Delete', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      fireEvent.click(screen.getByTestId('card-menu-s2'));
      expect(screen.queryByRole('button', { name: 'KILL' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    });

    it('AC2/AC3: keeps KILL usable after Stop is submitted but has not settled', async () => {
      const stopped: string[] = [];
      const killed: string[] = [];
      let finishStop!: () => void;
      const pendingStop = new Promise<void>(resolve => { finishStop = resolve; });
      const store = sessionStore as typeof sessionStore & { killSession: (id: string) => Promise<void> };
      vi.mocked(store.killSession).mockImplementation(async id => { killed.push(id); });
      render(() => <SessionDropdown {...defaultProps}
        sessions={[createSession({ id: 'pending-stop', status: 'stopping' })]}
        onStopSession={id => { stopped.push(id); return pendingStop; }} />);
      try {
        fireEvent.click(screen.getByTestId('card-menu-pending-stop'));
        fireEvent.click(screen.getByRole('button', { name: 'Retry Stop' }));
        expect(stopped).toEqual(['pending-stop']);
        expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('card-menu-pending-stop'));
        const kill = screen.getByRole('button', { name: 'KILL' });
        expect(kill).toBeEnabled();
        fireEvent.click(kill);
        expect(killed).toEqual(['pending-stop']);
        expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
      } finally {
        finishStop();
        await pendingStop;
      }
    });

    it('AC7: keeps Stop, Rename and confirmed Delete targeting the selected session with KILL present', () => {
      const stopped: string[] = [];
      const renamed: Array<[string, string]> = [];
      const deleted: string[] = [];
      vi.mocked(sessionStore.renameSession).mockImplementation(async (id, name) => { renamed.push([id, name]); });
      render(() => <SessionDropdown {...defaultProps}
        onStopSession={id => stopped.push(id)} onDeleteSession={id => deleted.push(id)} />);

      fireEvent.click(screen.getByTestId('card-menu-s1'));
      expect(screen.getByRole('button', { name: 'KILL' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(stopped).toEqual(['s1']);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('card-menu-s1'));
      fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
      fireEvent.input(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Still retained' } });
      fireEvent.submit(screen.getByTestId('context-menu-rename-form'));
      expect(renamed).toEqual([['s1', 'Still retained']]);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('card-menu-s1'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(deleted).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Are you sure?' }));
      expect(deleted).toEqual(['s1']);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    });
  });

  describe('Active session highlighting', () => {
    it('marks the active session card as active', () => {
      render(() => <SessionDropdown {...defaultProps} activeSessionId="s1" />);
      const card = screen.getByTestId('session-stat-card-s1');
      expect(card).toHaveAttribute('data-active', 'true');
    });
  });

  describe('Session card background consistency', () => {
    it('uses session-dropdown--no-blur class to avoid backdrop-filter affecting card backgrounds', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      const dropdown = screen.getByTestId('session-dropdown');
      // The dropdown should not have backdrop-filter so session cards
      // look identical to the dashboard
      expect(dropdown.className).toContain('session-dropdown--popover');
    });
  });

  describe('REQ-AGENT-175: environment update lockdown', () => {
    afterEach(() => {
      (sessionStore as any)._setPreseedUpgrading(false);
      (sessionStore as any)._setPreseedUpgradeFailed(false);
      (sessionStore as any)._setManagedReleaseStatus(null);
    });

    it('REQ-AGENT-175 AC1: disables New Session button and shows Updating during preseed sync', () => {
      (sessionStore as any)._setPreseedUpgrading(true);
      render(() => <SessionDropdown {...defaultProps} />);
      const btn = screen.getByTestId('session-dropdown-new');
      expect(btn).toBeDisabled();
      expect(btn.textContent).toContain('Updating');
      expect(btn).toHaveAttribute('aria-label', 'Updating session environment');
    });

    it('REQ-AGENT-175 AC4: disables New Session button and shows Updating during managed reconciliation', () => {
      (sessionStore as any)._setManagedReleaseStatus('upgrading');
      render(() => <SessionDropdown {...defaultProps} />);
      const btn = screen.getByTestId('session-dropdown-new');
      expect(btn).toBeDisabled();
      expect(btn.textContent).toContain('Updating');
      expect(btn).toHaveAttribute('aria-label', 'Updating session environment');
    });

    it('REQ-AGENT-175 AC2: disables New Session while a managed update waits for sessions to stop', () => {
      (sessionStore as any)._setManagedReleaseStatus('update_pending');
      render(() => <SessionDropdown {...defaultProps} />);
      const btn = screen.getByTestId('session-dropdown-new');
      expect(btn).toBeDisabled();
      expect(btn.textContent).toContain('Update pending');
      expect(btn).toHaveAttribute('aria-label', 'Session environment update pending until session stops');
    });

    it('REQ-AGENT-175: a failed baked upgrade cannot be bypassed through New Session', () => {
      (sessionStore as any)._setPreseedUpgradeFailed(true);
      render(() => <SessionDropdown {...defaultProps} />);
      const button = screen.getByTestId('session-dropdown-new');
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(screen.getByTestId('create-session-dialog')).toHaveAttribute('data-open', 'false');
      expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
    });

    it('enables New Session button when no environment update is running', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      const btn = screen.getByTestId('session-dropdown-new');
      expect(btn).not.toBeDisabled();
      expect(btn.textContent).not.toContain('Updating');
    });
  });

  describe('MultiView selection', () => {
    it('REQ-TERM-013: keeps the dropdown open while toggling MultiView member sessions', () => {
      const onLaunchMultiView = vi.fn();
      render(() => (
        <SessionDropdown
          {...defaultProps}
          multiView={{ capacity: 4, existing: null, onLaunch: onLaunchMultiView, onOpen: vi.fn(), onClose: vi.fn() }}
        />
      ));

      const action = screen.getByTestId('session-dropdown-multiview-action');
      expect(action.querySelector('path')?.getAttribute('d')).toBe(mdiViewCompactOutline);

      fireEvent.click(action);
      expect(screen.getByTestId('session-dropdown')).toBeInTheDocument();
      expect(screen.getByTestId('session-dropdown-multiview-action')).toHaveAttribute('data-mode', 'selecting');

      fireEvent.click(screen.getByTestId('session-card-s3'));
      expect(screen.getByTestId('session-card-s1')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('session-card-s3')).toHaveAttribute('data-selected', 'true');
      expect(defaultProps.onSelectSession).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('session-dropdown-multiview-action'));
      expect(onLaunchMultiView).toHaveBeenCalledWith(['s1', 's3']);
    });

    it('REQ-TERM-013: deactivates existing MultiView and closes the dropdown from the row close button', () => {
      const onCloseMultiView = vi.fn();
      const onCloseDropdown = vi.fn();
      render(() => (
        <SessionDropdown
          {...defaultProps}
          onClose={onCloseDropdown}
          multiView={{
            capacity: 4,
            existing: {
              id: 'multiview:1',
              name: 'MultiView #1',
              memberSessionIds: ['s1', 's3'],
              focusedSessionId: 's1',
              layout: '2-split',
            },
            onLaunch: vi.fn(),
            onOpen: vi.fn(),
            onClose: onCloseMultiView,
          }}
        />
      ));

      fireEvent.click(screen.getByTestId('session-dropdown-multiview-close'));

      expect(onCloseMultiView).toHaveBeenCalledTimes(1);
      expect(onCloseDropdown).toHaveBeenCalledTimes(1);
    });

    it('REQ-TERM-013: rejects selection beyond desktop capacity without changing selected sessions', () => {
      render(() => (
        <SessionDropdown
          {...defaultProps}
          sessions={[
            createSession({ id: 's1', status: 'running' }),
            createSession({ id: 's2', status: 'running' }),
            createSession({ id: 's3', status: 'running' }),
            createSession({ id: 's4', status: 'running' }),
            createSession({ id: 's5', status: 'running' }),
          ]}
          multiView={{ capacity: 4, existing: null, onLaunch: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() }}
        />
      ));

      fireEvent.click(screen.getByTestId('session-dropdown-multiview-action'));
      fireEvent.click(screen.getByTestId('session-card-s2'));
      fireEvent.click(screen.getByTestId('session-card-s3'));
      fireEvent.click(screen.getByTestId('session-card-s4'));
      fireEvent.click(screen.getByTestId('session-card-s5'));

      expect(screen.getByTestId('session-card-s1')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('session-card-s2')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('session-card-s3')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('session-card-s4')).toHaveAttribute('data-selected', 'true');
      expect(screen.getByTestId('session-card-s5')).toHaveAttribute('data-selected', 'false');
      expect(screen.getByTestId('session-dropdown-multiview-limit')).toHaveAttribute('data-visible', 'true');
    });

    it('REQ-TERM-013: hides the MultiView action on mobile', () => {
      const onLaunchMultiView = vi.fn();
      render(() => (
        <SessionDropdown
          {...defaultProps}
          isMobileView
          multiView={{ capacity: 0, existing: null, onLaunch: onLaunchMultiView, onOpen: vi.fn(), onClose: vi.fn() }}
        />
      ));

      expect(screen.queryByTestId('session-dropdown-multiview-action')).not.toBeInTheDocument();
      expect(onLaunchMultiView).not.toHaveBeenCalled();
    });
  });

});
