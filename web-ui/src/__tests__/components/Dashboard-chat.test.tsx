import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import Dashboard from '../../components/Dashboard';
import type { SessionWithStatus } from '../../types';

// Keep the card/menu boundary real; unrelated dashboard panels are not part of
// the explicit session-surface entry contract.
vi.mock('../../components/StorageBrowser', () => ({ default: () => null }));
vi.mock('../../components/github/GitHubPanel', () => ({ default: () => null }));
vi.mock('../../components/StatCards', () => ({ default: () => null }));
vi.mock('../../components/TipsRotator', () => ({ default: () => null }));
vi.mock('../../components/KittScanner', () => ({ default: () => null }));
vi.mock('../../components/CreateSessionDialog', () => ({ default: () => null }));
vi.mock('../../components/SessionLimitPopup', () => ({ default: () => null }));
vi.mock('../../components/OperatorActivityButton', () => ({ default: () => null }));
vi.mock('../../stores/github', () => ({ githubStore: { enabled: false, loadStatus() {} } }));
vi.mock('../../stores/storage', () => ({ storageStore: { fetchStats() {}, stats: null, previewFile: null } }));
vi.mock('../../stores/session', () => ({
  sessionStore: {
    preferences: { sessionMode: 'advanced' }, sessions: [], r2Ready: true,
    isAtSessionLimit: () => false, startR2Polling() {},
    getMetricsForSession: () => null, getInitProgressForSession: () => null,
  }, isAtUsageQuota: () => false,
  getUsageState: () => ({ monthlySeconds: 0, monthlyQuotaSeconds: null }),
}));

const session: SessionWithStatus = {
  id: 'abcdef0123456789', name: 'Normal Pi', workspace: 'terminal',
  agentType: 'pi', terminalMode: 'classic', status: 'running', generation: 7, editorReady: true,
  tabConfig: [{ id: '1', command: 'pi', label: 'Pi' }],
  createdAt: '2026-10-29T00:00:00Z', lastAccessedAt: '2026-10-29T00:00:00Z',
};
function mount(candidate = session) {
  const [opened, setOpened] = createSignal('');
  const [catalog, setCatalog] = createSignal([candidate]);
  render(() => <>
    <Dashboard sessions={catalog()} viewState="dashboard"
      onCreateSession={() => {}} onStartSession={id => setOpened(`${id}:start`)} onStopSession={id => setOpened(`${id}:stop`)}
      onDeleteSession={id => setOpened(`${id}:delete`)} onOpenVscodeSession={id => setOpened(`${id}:editor`)} onOpenSessionById={id => setOpened(`${id}:selection`)}
      onOpenChatSession={id => setOpened(`${id}:chat`)}
      onOpenTerminalSession={id => setOpened(`${id}:terminal`)} />
    <output aria-label="Explicit entry">{opened()}</output>
  </>);
  return (next: SessionWithStatus) => setCatalog([next]);
}
afterEach(cleanup);

describe('Dashboard explicit primary surface entry', () => {
  it.each(['Chat', 'Terminal'] as const)('REQ-IDE-056 AC7: Normal Pi card menu opens %s without changing session selection', async surface => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: `Activate session ${session.name}` }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:selection`);
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    await fireEvent.click(screen.getByRole('button', { name: `Open in ${surface}` }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:${surface.toLowerCase()}`);
    expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
  });

  it.each(['classic', 'herdr'] as const)('REQ-IDE-056 AC7: exclusive %s VS Code hides Chat and Terminal while opening the ready editor', async terminalMode => {
    mount({ ...session, workspace: 'vscode', terminalMode });
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:stop`);
    await fireEvent.click(screen.getByRole('button', { name: `Activate session ${session.name}` }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:editor`);
  });

  it.each([
    { status: 'stopped' as const, editorReady: false, editorReadyError: false, expected: 'start' },
    { status: 'error' as const, editorReady: false, editorReadyError: true, expected: 'start' },
    { status: 'running' as const, editorReady: false, editorReadyError: true, expected: 'start' },
    { status: 'unreachable' as const, editorReady: true, editorReadyError: false, expected: 'editor' },
  ])('REQ-IDE-056 AC7: exclusive VS Code retains $status editor activation and recovery without shared entry', async candidate => {
    const { expected, ...state } = candidate;
    mount({ ...session, ...state, workspace: 'vscode' });
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    if (candidate.status !== 'stopped') expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Are you sure?' }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:delete`);
    await fireEvent.click(screen.getByRole('button', { name: `Activate session ${session.name}` }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:${expected}`);
  });

  it('REQ-IDE-056 AC7: exclusive VS Code keeps preparing editor non-actionable and shared entries hidden', async () => {
    mount({ ...session, workspace: 'vscode', editorReady: false });
    expect(screen.queryByRole('button', { name: `Activate session ${session.name}` })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByLabelText('Explicit entry')).toBeEmptyDOMElement();
  });

  it.each([undefined, 'claude-code', 'bash'] as const)('REQ-AGENT-224: configured primary Pi opens both surfaces when the legacy creation agent is %s', async agentType => {
    mount({ ...session, agentType });
    for (const surface of ['Chat', 'Terminal'] as const) {
      await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
      await fireEvent.click(screen.getByRole('button', { name: `Open in ${surface}` }));
      expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:${surface.toLowerCase()}`);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    }
  });

  it('REQ-AGENT-224: an open card menu withdraws explicit entry after authoritative stop', async () => {
    const update = mount();
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.getByRole('button', { name: 'Open in Chat' })).toBeInTheDocument();
    update({ ...session, status: 'stopped' });
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Explicit entry')).toBeEmptyDOMElement();
  });

  it.each([
    { status: 'stopped' as const }, { status: 'stopping' as const },
    { agentType: 'bash' as const, tabConfig: undefined },
    { tabConfig: [{ id: '1', command: 'bash' as const, label: 'Shell' }] },
  ])('REQ-AGENT-224: card menu excludes non-running or non-Pi primary entry %j', async overrides => {
    mount({ ...session, ...overrides });
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Explicit entry')).toBeEmptyDOMElement();
  });
});
