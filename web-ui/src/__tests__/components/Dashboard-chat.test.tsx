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
}));

const session: SessionWithStatus = {
  id: 'abcdef0123456789', name: 'Editor Pi', workspace: 'vscode',
  agentType: 'pi', terminalMode: 'classic', status: 'running', generation: 7,
  tabConfig: [{ id: '1', command: 'pi', label: 'Pi' }],
  createdAt: '2026-10-29T00:00:00Z', lastAccessedAt: '2026-10-29T00:00:00Z',
};
function mount(candidate = session) {
  const [opened, setOpened] = createSignal('');
  render(() => <>
    <Dashboard sessions={[candidate]} viewState="dashboard"
      onCreateSession={() => {}} onStartSession={() => {}} onStopSession={() => {}}
      onDeleteSession={() => {}} onOpenVscodeSession={() => {}} onOpenSessionById={() => {}}
      onOpenChatSession={id => setOpened(`${id}:chat`)}
      onOpenTerminalSession={id => setOpened(`${id}:terminal`)} />
    <output aria-label="Explicit entry">{opened()}</output>
  </>);
}
afterEach(cleanup);

describe('Dashboard explicit primary surface entry', () => {
  it.each(['Chat', 'Terminal'] as const)('REQ-AGENT-224: existing card menu explicitly opens eligible Pi in %s without changing normal selection', async surface => {
    mount();
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    await fireEvent.click(screen.getByRole('button', { name: `Open in ${surface}` }));
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent(`${session.id}:${surface.toLowerCase()}`);
    expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
  });

  it.each([
    { status: 'stopped' as const }, { status: 'stopping' as const },
    { agentType: 'bash' as const },
    { tabConfig: [{ id: '1', command: 'bash' as const, label: 'Shell' }] },
  ])('REQ-AGENT-224: card menu excludes non-running or non-Pi primary entry %j', async overrides => {
    mount({ ...session, ...overrides });
    await fireEvent.click(screen.getByTestId(`session-stat-card-${session.id}-menu`));
    expect(screen.queryByRole('button', { name: 'Open in Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Explicit entry')).toHaveTextContent('');
  });
});
