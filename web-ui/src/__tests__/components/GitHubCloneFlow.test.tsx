import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

// Reuse the session-store fixture boundaries: terminal transport is irrelevant
// to creation, and the start peer acknowledges the resulting session.
vi.mock('../../stores/terminal', () => ({
  terminalStore: { dispose: vi.fn(), disposeSession: vi.fn(), triggerLayoutResize: vi.fn(),
    ownsSession: () => false, registerSessionStoppedCallback: vi.fn() },
  registerProcessNameCallback: vi.fn(), sendInputToTerminal: () => false,
}));
vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  startSession: (_id: string, _progress: unknown, complete: (generation: number) => void) => {
    queueMicrotask(() => complete(1));
    return () => {};
  },
}));

import ClonePicker from '../../components/github/ClonePicker';
import { sessionStore } from '../../stores/session';

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStore.setAllowedAgents(null); });

it('REQ-GITHUB-004 AC4: choosing a new-session agent sends the eventual creation request without a ref', async () => {
  sessionStore.setAllowedAgents(['pi']);
  sessionStore.setEnterpriseMode(false);
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/sessions') return new Response(JSON.stringify({ session: {
      id: 'cloneflow123', name: 'hello', agentType: 'pi', workspace: 'vscode', terminalMode: 'classic',
      createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z',
    } }));
    if (url === '/api/preferences') return new Response(JSON.stringify({ lastAgentType: 'pi' }));
    throw new Error(`Unexpected creation peer: ${url}`);
  });
  render(() => <ClonePicker repo={{ full_name: 'octocat/hello', name: 'hello', owner: 'octocat',
    private: false, visibility: 'public', default_branch: 'trunk', updated_at: '2026-01-01T00:00:00Z' }} onClose={() => {}} />);
  fireEvent.click(screen.getByTestId('clone-picker-agent-pi'));
  await waitFor(() => expect(sessionStore.sessions.find(session => session.id === 'cloneflow123')?.status).toBe('running'));
  expect(requests.filter(request => request.url === '/api/sessions')).toEqual([
    { url: '/api/sessions', body: { name: 'hello', agentType: 'pi', clone: { repo: 'octocat/hello' } } },
  ]);
  expect(sessionStore.sessions.find(session => session.id === 'cloneflow123'))
    .toMatchObject({ name: 'hello', agentType: 'pi', status: 'running' });
});
