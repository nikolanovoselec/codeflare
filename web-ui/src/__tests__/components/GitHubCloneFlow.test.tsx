import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

// Reuse the session-store fixture boundaries: terminal transport is irrelevant
// to creation, and the start peer acknowledges the resulting session.
vi.mock('../../stores/terminal', () => ({
  terminalStore: { dispose: vi.fn(), disposeSession: vi.fn(), triggerLayoutResize: vi.fn(),
    ownsSession: () => false, registerSessionStoppedCallback: vi.fn() },
  registerProcessNameCallback: vi.fn(), sendInputToTerminal: () => false,
}));
import RepoRow from '../../components/github/RepoRow';
import { sessionStore } from '../../stores/session';

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStore.setAllowedAgents(null); });

it('REQ-GITHUB-004 AC4: choosing a new-session agent sends the eventual creation request without a ref', async () => {
  await verifyCloneLaunch(false);
});

it('Vibe creates and starts a Pi Chat clone without choosing an agent', async () => {
  await verifyCloneLaunch(true);
});

it('retries a saved Vibe clone from Code on its original Chat surface', async () => {
  sessionStore.setAllowedAgents(['pi', 'codex']);
  const id = 'retrychat123';
  const repo = { full_name: 'octocat/retry', name: 'retry', owner: 'octocat',
    private: false, visibility: 'public', default_branch: 'trunk', updated_at: '2026-01-01T00:00:00Z' };
  const startRequests: unknown[] = [];
  let creates = 0;
  let finishRetry!: (response: Response) => void;
  const retryClaim = new Promise<Response>(resolve => { finishRetry = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/sessions') {
      creates++;
      return Response.json({ session: { id, name: 'retry', agentType: 'pi', workspace: 'terminal', terminalMode: 'classic',
        createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z' } });
    }
    if (url === `/api/container/start?sessionId=${id}`) {
      startRequests.push(JSON.parse(String(init?.body ?? 'null')));
      return startRequests.length === 1 ? Response.json({ error: 'Start rejected' }, { status: 400 }) : retryClaim;
    }
    if (url === `/api/container/startup-status?sessionId=${id}`) return Response.json({
      stage: 'ready', generation: 1, revision: 1, progress: 100, message: 'Ready',
      details: { bucketName: 'fixture', container: 'fixture', path: '/workspace' },
    });
    throw new Error(`Unexpected clone peer: ${url}`);
  });
  render(() => <RepoRow repo={repo} vibeOnly />);
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  fireEvent.click(screen.getByRole('button', { name: /^New Pi session/ }));
  await screen.findByRole('button', { name: 'Retry Start' });
  cleanup();
  sessionStore.setActiveSession(null);
  render(() => <RepoRow repo={repo} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry Start' }));
  try {
    await waitFor(() => expect(startRequests).toEqual([{ surface: 'chat' }, { surface: 'chat' }]));
    expect(creates).toBe(1);
    expect(sessionStore.activeSessionId).toBe(id);
    expect(sessionStore.sessions.find(session => session.id === id)?.status).toBe('initializing');
  } finally { finishRetry(Response.json({ generation: 1 })); }
  await waitFor(() => expect(sessionStore.sessions.find(session => session.id === id)?.status).toBe('running'));
});

async function verifyCloneLaunch(vibeOnly: boolean) {
  sessionStore.setAllowedAgents(['pi', 'codex']);
  sessionStore.setEnterpriseMode(false);
  const id = vibeOnly ? 'clonevibe123' : 'cloneflow123';
  const agentType = vibeOnly ? 'pi' : 'codex';
  const surface = vibeOnly ? { surface: 'chat' } : {};
  const startUrl = `/api/container/start?sessionId=${id}`;
  let finishStart!: (response: Response) => void;
  const startClaim = new Promise<Response>(resolve => { finishStart = resolve; });
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/sessions') return new Response(JSON.stringify({ session: {
      id, name: 'hello', agentType, workspace: vibeOnly ? 'terminal' : 'vscode', terminalMode: 'classic',
      createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z',
    } }));
    if (url === startUrl) return startClaim;
    if (url === `/api/container/startup-status?sessionId=${id}`) return Response.json({
      stage: 'ready', generation: 1, revision: 1, progress: 100, message: 'Ready',
      details: { bucketName: 'fixture', container: 'fixture', path: '/workspace' },
    });
    if (url === '/api/preferences') return Response.json({ lastAgentType: agentType });
    throw new Error(`Unexpected creation peer: ${url}`);
  });
  render(() => <RepoRow vibeOnly={vibeOnly} repo={{ full_name: 'octocat/hello', name: 'hello', owner: 'octocat',
    private: false, visibility: 'public', default_branch: 'trunk', updated_at: '2026-01-01T00:00:00Z' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
  if (vibeOnly) {
    expect(screen.queryByTestId('clone-picker-agent-codex')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^New Pi session/ }));
  } else {
    expect(screen.getByTestId('clone-picker-agent-pi')).toBeEnabled();
    fireEvent.click(screen.getByTestId('clone-picker-agent-codex'));
  }
  try {
    await waitFor(() => expect(requests.find(request => request.url === startUrl)?.url).toBe(startUrl));
    expect(sessionStore.sessions.find(session => session.id === id)?.status).toBe('initializing');
    if (vibeOnly) expect(sessionStore.activeSessionId).toBe(id);
  } finally { finishStart(Response.json({ generation: 1 })); }
  await waitFor(() => expect(sessionStore.sessions.find(session => session.id === id)?.status).toBe('running'));
  expect(requests.filter(request => request.url === '/api/sessions')).toEqual([
    { url: '/api/sessions', body: { name: 'hello', agentType, clone: { repo: 'octocat/hello' }, ...surface } },
  ]);
  expect(requests.filter(request => request.url === startUrl)).toEqual([
    { url: startUrl, body: vibeOnly ? surface : undefined },
  ]);
  expect(sessionStore.sessions.find(session => session.id === id))
    .toMatchObject({ name: 'hello', agentType, status: 'running' });
}
