import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';

// ── API mock (hoisted so the vi.mock factory can reference it) ──────────────
const mockCloneIntoSession = vi.hoisted(() => vi.fn());

vi.mock('../../api/github', () => ({
  cloneIntoSession: (...args: unknown[]) => mockCloneIntoSession(...args),
}));

// ── Session store mock ──────────────────────────────────────────────────────
// ClonePicker reads `sessions` + `createSessionWithClone`; ClonePickerNewSession
// reads `enterpriseMode`. AGENT_OPTIONS is a plain const imported from
// CreateSessionDialog (no component render), so this mock covers the whole tree.
const sessionStoreState = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; name: string; status: string; agentType?: string }>,
  enterpriseMode: false as boolean,
}));
const mockCreateSessionWithClone = vi.hoisted(() => vi.fn());

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() {
      return sessionStoreState.sessions;
    },
    get enterpriseMode() {
      return sessionStoreState.enterpriseMode;
    },
    get preferences() {
      return { lastAgentType: undefined };
    },
    createSessionWithClone: (...args: unknown[]) => mockCreateSessionWithClone(...args),
  },
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number; class?: string }) => (
    <span data-testid="mock-icon" data-path={props.path} class={props.class} />
  ),
}));

import { mdiPi } from '@mdi/js';
import ClonePicker from '../../components/github/ClonePicker';

const REPO = {
  full_name: 'octocat/hello',
  name: 'hello',
  owner: 'octocat',
  private: false,
  visibility: 'public',
  default_branch: 'main',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderPicker(onClose = () => {}) {
  return render(() => <ClonePicker repo={REPO} onClose={onClose} />);
}

describe('ClonePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreState.sessions = [];
    sessionStoreState.enterpriseMode = false;
    mockCloneIntoSession.mockResolvedValue({ outcome: 'cloned', path: '/home/user/workspace/hello' });
    mockCreateSessionWithClone.mockResolvedValue({ id: 's-new', name: '', status: 'stopped' });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the running group BEFORE the new-session group with a separator between', () => {
    sessionStoreState.sessions = [
      { id: 's1', name: 'Pi #1', status: 'running' },
      { id: 's2', name: 'Claude #1', status: 'running' },
    ];

    const { container } = renderPicker();

    const running = screen.getByTestId('clone-picker-running-group');
    const separator = screen.getByTestId('clone-picker-separator');
    const newGroup = screen.getByTestId('clone-picker-new-group');

    // Structural ordering: running group precedes separator precedes new group.
    const order = [running, separator, newGroup];
    const positions = order.map((el) =>
      Array.prototype.indexOf.call(container.querySelectorAll('*'), el),
    );
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);

    // The separator is exposed as a real separator role.
    expect(separator.getAttribute('role')).toBe('separator');

    // One running row per running session.
    expect(screen.getAllByTestId('clone-picker-session-row')).toHaveLength(2);
  });

  it('lists only running sessions (filters out stopped/initializing)', () => {
    sessionStoreState.sessions = [
      { id: 's1', name: 'Pi #1', status: 'running' },
      { id: 's2', name: 'Old #1', status: 'stopped' },
      { id: 's3', name: 'Boot #1', status: 'initializing' },
    ];

    renderPicker();

    const rows = screen.getAllByTestId('clone-picker-session-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-session-id')).toBe('s1');
  });

  it('renders only the new-session group when there are no running sessions', () => {
    sessionStoreState.sessions = [{ id: 's2', name: 'Old #1', status: 'stopped' }];

    renderPicker();

    expect(screen.queryByTestId('clone-picker-running-group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-separator')).not.toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-new-group')).toBeInTheDocument();
  });

  it('selecting a running session clones with {repo, sessionId} and NO ref', async () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];

    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-session-row'));

    await waitFor(() => expect(mockCloneIntoSession).toHaveBeenCalledTimes(1));
    const arg = mockCloneIntoSession.mock.calls[0][0];
    expect(arg).toEqual({ repo: 'octocat/hello', sessionId: 's1' });
    expect('ref' in arg).toBe(false);
  });

  it('selecting an agent creates a session with the repo and triggers the open path', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));

    await waitFor(() => expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1));
    // createSessionWithClone(repo, agentType) — the store method that runs the
    // existing create → activate → start (navigate) sequence.
    expect(mockCreateSessionWithClone.mock.calls[0][0]).toBe('octocat/hello');
    expect(mockCreateSessionWithClone.mock.calls[0][1]).toBe('pi');
  });

  it('closes after a successful new-session clone (navigation already happened)', async () => {
    const onClose = vi.fn();
    renderPicker(onClose);

    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('renders the collision affordance on a 409 (exists) result', async () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];
    mockCloneIntoSession.mockResolvedValueOnce({ outcome: 'exists' });

    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-session-row'));

    await waitFor(() => expect(screen.getByTestId('clone-picker-result-exists')).toBeInTheDocument());
    // Distinct from the generic failure state.
    expect(screen.queryByTestId('clone-picker-result-failed')).not.toBeInTheDocument();
  });

  it('renders the generic failure state on a non-2xx (failed) result', async () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];
    mockCloneIntoSession.mockResolvedValueOnce({ outcome: 'failed', code: 'CLONE_TIMEOUT' });

    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-session-row'));

    await waitFor(() => expect(screen.getByTestId('clone-picker-result-failed')).toBeInTheDocument());
    expect(screen.queryByTestId('clone-picker-result-exists')).not.toBeInTheDocument();
  });

  it('disables the confirm controls while a clone request is in flight', async () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];
    // A clone that never resolves keeps the picker in the busy phase.
    let resolveClone: (v: unknown) => void = () => {};
    mockCloneIntoSession.mockReturnValueOnce(new Promise((r) => { resolveClone = r; }));

    renderPicker();

    const sessionRow = screen.getByTestId('clone-picker-session-row') as HTMLButtonElement;
    fireEvent.click(sessionRow);

    // While in flight, both the session rows and the agent buttons are disabled.
    await waitFor(() => expect(sessionRow.disabled).toBe(true));
    const agentBtn = screen.getByTestId('clone-picker-agent-pi') as HTMLButtonElement;
    expect(agentBtn.disabled).toBe(true);

    resolveClone({ outcome: 'cloned', path: '/x' });
  });

  it('hides the picker chrome and shows a done affordance after a running-session clone succeeds', async () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];

    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-session-row'));

    await waitFor(() => expect(screen.getByTestId('clone-picker-result-cloned')).toBeInTheDocument());
    // The chooser groups are replaced by the success affordance.
    expect(screen.queryByTestId('clone-picker-running-group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-new-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-done-btn')).toBeInTheDocument();
  });

  it('respects enterprise mode by restricting the agent set', () => {
    sessionStoreState.enterpriseMode = true;

    renderPicker();

    // Enterprise allowlist is copilot/pi/bash — the others are absent.
    expect(screen.getByTestId('clone-picker-agent-pi')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-copilot')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-bash')).toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-codex')).not.toBeInTheDocument();
  });

  it('a running-session row shows the session agent icon and a session-type subtitle', () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'ai-news-digest', status: 'running', agentType: 'pi' }];

    renderPicker();

    const row = screen.getByTestId('clone-picker-session-row');
    // Reuses the session-mode agent icon (Pi) rather than a generic console icon.
    expect(row.querySelector('[data-testid="mock-icon"]')?.getAttribute('data-path')).toBe(mdiPi);
    // Subtitle states which agent the session runs.
    expect(row.querySelector('.clone-picker-option-desc')?.textContent).toContain('Pi');
  });

  it('running-session rows and new-session rows share the option-row layout', () => {
    sessionStoreState.sessions = [{ id: 's1', name: 'x', status: 'running', agentType: 'pi' }];

    renderPicker();

    expect(screen.getByTestId('clone-picker-session-row').classList.contains('clone-picker-option-btn')).toBe(true);
    expect(screen.getByTestId('clone-picker-agent-pi').classList.contains('clone-picker-option-btn')).toBe(true);
  });
});
