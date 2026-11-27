import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';

// ── API mock (hoisted so the vi.mock factory can reference it) ──────────────
const mockCloneIntoSession = vi.hoisted(() => vi.fn());

vi.mock('../../api/github', () => ({
  cloneIntoSession: (...args: unknown[]) => mockCloneIntoSession(...args),
}));

// ── Session store mock ──────────────────────────────────────────────────────
// ClonePicker reads `sessions` and delegates both clone paths; ClonePickerNewSession
// reads `enterpriseMode` + `allowedAgents`. AGENT_OPTIONS is a plain const
// imported from lib/agent-catalog (no component render), so this mock covers
// the whole tree.
const sessionStoreState = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; name: string; status: string; agentType?: string }>,
  enterpriseMode: false as boolean,
  allowedAgents: null as string[] | null,
  readSessions: null as (() => Array<{ id: string; name: string; status: string }>) | null,
}));
const mockCreateSessionWithClone = vi.hoisted(() => vi.fn());
const mockRetryCloneStart = vi.hoisted(() => vi.fn());

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() {
      return sessionStoreState.readSessions?.() ?? sessionStoreState.sessions;
    },
    get enterpriseMode() {
      return sessionStoreState.enterpriseMode;
    },
    get allowedAgents() {
      return sessionStoreState.allowedAgents;
    },
    get preferences() {
      return { lastAgentType: undefined };
    },
    createSessionWithClone: (...args: unknown[]) => mockCreateSessionWithClone(...args),
    canRetryCloneStart: (id: string) => {
      const status = (sessionStoreState.readSessions?.() ?? sessionStoreState.sessions).find(session => session.id === id)?.status;
      return status === 'stopped' || status === 'error';
    },
    retryCloneStart: (...args: unknown[]) => mockRetryCloneStart(...args),
    cloneRepositoryIntoSession: (...args: unknown[]) => mockCloneIntoSession(...args),
  },
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number; class?: string }) => (
    <span data-testid="mock-icon" data-path={props.path} class={props.class} />
  ),
}));

import { mdiPi } from '@mdi/js';
import ClonePicker from '../../components/github/ClonePicker';
import { cloneAttempt, forgetCloneAttempt, setCloneAttempt } from '../../stores/clone-attempts';

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
  const [open, setOpen] = createSignal(true);
  return render(() => <Show when={open()}>
    <ClonePicker repo={REPO} onClose={() => { setOpen(false); onClose(); }} />
  </Show>);
}

// REQ-GITHUB-004: Clone a repository into a session

describe('ClonePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreState.sessions = [];
    sessionStoreState.readSessions = null;
    sessionStoreState.enterpriseMode = false;
    sessionStoreState.allowedAgents = ['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'pi', 'bash'];
    mockCloneIntoSession.mockResolvedValue({ outcome: 'cloned', path: '/home/user/workspace/hello' });
    mockCreateSessionWithClone.mockResolvedValue({ sessionId: 's-new', started: true });
    mockRetryCloneStart.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    setCloneAttempt(REPO.full_name);
    setCloneAttempt(REPO.full_name, undefined, 'chat');
  });

  it('Vibe offers only Pi destinations and never retries a non-Pi Code clone', async () => {
    sessionStoreState.enterpriseMode = true;
    sessionStoreState.allowedAgents = ['copilot', 'pi', 'bash'];
    sessionStoreState.sessions = [
      { id: 'pi-running', name: 'Running Pi', status: 'running', agentType: 'pi' },
      { id: 'code-running', name: 'Running Codex', status: 'running', agentType: 'codex' },
      { id: 'code-failed', name: 'Saved Codex', status: 'stopped', agentType: 'codex' },
    ];
    setCloneAttempt(REPO.full_name, { phase: 'failed', sessionId: 'code-failed' });
    render(() => <ClonePicker repo={REPO} vibeOnly onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /^Running Pi/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Running Codex|^Retry Start|^Codex/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-copilot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-bash')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^New Pi session/ }));
    await waitFor(() => expect(mockCreateSessionWithClone).toHaveBeenCalledWith(REPO.full_name, 'pi', 'chat'));
  });

  it('preserves the saved Code retry after a successful Vibe clone of the same repository', async () => {
    sessionStoreState.sessions = [{ id: 'code-saved', name: 'Code clone', status: 'stopped', agentType: 'codex' }];
    setCloneAttempt(REPO.full_name, { phase: 'failed', sessionId: 'code-saved' });
    const close = vi.fn();
    render(() => <ClonePicker repo={REPO} vibeOnly onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: /^New Pi session/ }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    cleanup();
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Start' }));
    await waitFor(() => expect(mockRetryCloneStart).toHaveBeenCalledWith('code-saved'));
  });

  it('retries the original Chat surface from Code after a failed Vibe clone', async () => {
    sessionStoreState.sessions = [{ id: 'chat-saved', name: 'Vibe clone', status: 'stopped', agentType: 'pi' }];
    mockCreateSessionWithClone.mockResolvedValueOnce({ sessionId: 'chat-saved', started: false });
    render(() => <ClonePicker repo={REPO} vibeOnly onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^New Pi session/ }));
    await screen.findByRole('button', { name: 'Retry Start' });
    cleanup();
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Start' }));
    await waitFor(() => expect(mockRetryCloneStart).toHaveBeenCalledWith('chat-saved', 'chat'));
    expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1);
  });

  it('renders the running group before the new-session group through shared option rows', () => {
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

    // One running row per running session, using the same option-row layout as new-session agents.
    const runningRows = screen.getAllByTestId('clone-picker-session-row');
    const newRows = newGroup.querySelectorAll('.clone-picker-option-btn');
    expect(runningRows).toHaveLength(2);
    expect(newRows.length).toBeGreaterThan(0);
    expect(runningRows[0].className).toBe(newRows[0].className);
    expect(runningRows[0].querySelector('.clone-picker-option-info')?.className)
      .toBe(newRows[0].querySelector('.clone-picker-option-info')?.className);
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

  it('selecting an agent delegates cloned-session workspace routing to the store', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));

    await waitFor(() => expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1));
    // Store owns server-selected workspace routing after creation.
    expect(mockCreateSessionWithClone.mock.calls[0][0]).toBe('octocat/hello');
    expect(mockCreateSessionWithClone.mock.calls[0][1]).toBe('pi');
  });

  it('retries Start on the saved session rather than creating another session', async () => {
    sessionStoreState.sessions = [{ id: 's-new', name: 'hello', status: 'error' }];
    mockCreateSessionWithClone.mockResolvedValueOnce({ sessionId: 's-new', started: false });
    mockRetryCloneStart.mockResolvedValueOnce(false);
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /^Pi\s*Minimal, extensible coding harness$/ }));
    const retry = await screen.findByRole('button', { name: 'Retry Start' });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockRetryCloneStart.mock.calls).toEqual([['s-new'], ['s-new']]);
    expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1);
  });

  it('focuses Close and preserves the pending launch across dismissal and reopen', async () => {
    sessionStoreState.sessions = [{ id: 's-new', name: 'hello', status: 'error' }];
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    mockCreateSessionWithClone.mockReturnValueOnce(pending);
    const onClose = vi.fn();
    renderPicker(onClose);
    const pi = screen.getByRole('button', { name: /^Pi\s*Minimal, extensible coding harness$/ });
    pi.focus();
    fireEvent.click(pi);
    expect(pi).toBeDisabled();
    const close = screen.getByRole('button', { name: 'Close clone picker' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    renderPicker();
    expect(screen.getByRole('status')).toHaveTextContent('Starting session…');
    expect(screen.getByTestId('clone-picker-agent-pi')).toBeDisabled();
    finish({ sessionId: 's-new', started: false });
    await pending;
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Start' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockRetryCloneStart).toHaveBeenCalledWith('s-new');
    expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed Start that settles while closed, even across catalog omissions', async () => {
    const saved = { id: 's-new', name: 'hello', status: 'error' };
    const [sessions, setSessions] = createSignal([saved]);
    sessionStoreState.readSessions = sessions;
    let fail!: () => void;
    const pending = new Promise(resolve => { fail = () => resolve({ sessionId: saved.id, started: false }); });
    mockCreateSessionWithClone.mockReturnValueOnce(pending);
    renderPicker();
    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));
    fireEvent.click(screen.getByRole('button', { name: 'Close clone picker' }));
    fail();
    await pending;
    renderPicker();
    const retry = await screen.findByRole('button', { name: 'Retry Start' });
    expect(retry).toBeEnabled();
    setSessions([]);
    expect(retry).toBeDisabled();
    expect(screen.queryByTestId('clone-picker-agent-pi')).not.toBeInTheDocument();
    setSessions([saved]);
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockRetryCloneStart).toHaveBeenCalledWith(saved.id);
    expect(mockCreateSessionWithClone).toHaveBeenCalledTimes(1);
  });

  it('offers new sessions on reopen after deletion despite a late Start result', async () => {
    let finish!: () => void;
    const pending = new Promise(resolve => { finish = () => resolve({ sessionId: 's-deleted', started: false }); });
    mockCreateSessionWithClone.mockImplementationOnce(() => {
      const attempt = cloneAttempt(REPO.full_name);
      if (attempt?.phase === 'creating') setCloneAttempt(REPO.full_name, { ...attempt, sessionId: 's-deleted' });
      return pending;
    });
    renderPicker();
    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));
    fireEvent.click(screen.getByRole('button', { name: 'Close clone picker' }));
    forgetCloneAttempt('s-deleted');
    finish();
    await pending;
    renderPicker();
    expect(screen.getByTestId('clone-picker-agent-pi')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry Start' })).not.toBeInTheDocument();
  });

  it('closes after a successful new-session clone (navigation already happened)', async () => {
    const onClose = vi.fn();
    renderPicker(onClose);

    fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it.each(['cloned', 'exists', 'failed'] as const)('REQ-GITHUB-320 AC6: closes immediately and stays closed after a %s clone outcome', async outcome => {
    sessionStoreState.sessions = [{ id: 's1', name: 'Pi #1', status: 'running' }];
    let resolveClone!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveClone = resolve; });
    mockCloneIntoSession.mockReturnValueOnce(pending);
    renderPicker();

    fireEvent.click(screen.getByTestId('clone-picker-session-row'));

    expect(screen.queryByRole('dialog', { name: 'Clone repository' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-backdrop')).not.toBeInTheDocument();
    resolveClone({ outcome, ...(outcome === 'cloned' ? { path: '/workspace/hello' } : {}) });
    await pending;
    expect(screen.queryByRole('dialog', { name: 'Clone repository' })).not.toBeInTheDocument();
  });

  it('disables controls while launching and keeps the picker open after a cancelled repository launch', async () => {
    const [sessions, setSessions] = createSignal([{ id: 's1', name: 'Pi #1', status: 'running' }, { id: 's-new', name: 'hello', status: 'stopping' }]);
    sessionStoreState.readSessions = sessions;
    let resolveCreate!: (value: unknown) => void;
    mockCreateSessionWithClone.mockReturnValueOnce(new Promise(resolve => { resolveCreate = resolve; }));
    renderPicker();

    const agentBtn = screen.getByTestId('clone-picker-agent-pi') as HTMLButtonElement;
    fireEvent.click(agentBtn);

    expect(agentBtn.disabled).toBe(true);
    expect((screen.getByTestId('clone-picker-session-row') as HTMLButtonElement).disabled).toBe(true);
    // The session store returns no successful launch after Stop cancels Start.
    resolveCreate({ sessionId: 's-new', started: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Clone failed. Please try again.');
    expect(screen.getByRole('dialog', { name: 'Clone repository' })).toBeVisible();
    const retry = screen.getByRole('button', { name: 'Retry Start' });
    expect(retry).toBeDisabled();
    setSessions(rows => rows.map(row => row.id === 's-new' ? { ...row, status: 'stopped' } : row));
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('withholds new-session agent choices until /api/user hydrates', () => {
    sessionStoreState.allowedAgents = null;

    renderPicker();

    expect(screen.queryByTestId('clone-picker-agent-pi')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-claude-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-new-group').querySelectorAll('[data-testid^="clone-picker-agent-"]')).toHaveLength(0);
  });

  it('renders only the wizard-activated agents delivered by /api/user in enterprise mode', () => {
    sessionStoreState.enterpriseMode = true;
    sessionStoreState.allowedAgents = ['pi', 'bash'];

    renderPicker();

    expect(screen.getByTestId('clone-picker-agent-pi')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-bash')).toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-copilot')).not.toBeInTheDocument();
  });

  it('renders only build-installed agents outside enterprise mode', () => {
    sessionStoreState.enterpriseMode = false;
    sessionStoreState.allowedAgents = ['claude-code', 'codex', 'pi', 'bash'];

    renderPicker();

    expect(screen.getByTestId('clone-picker-agent-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-codex')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-pi')).toBeInTheDocument();
    expect(screen.getByTestId('clone-picker-agent-bash')).toBeInTheDocument();
    expect(screen.queryByTestId('clone-picker-agent-copilot')).not.toBeInTheDocument();
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
