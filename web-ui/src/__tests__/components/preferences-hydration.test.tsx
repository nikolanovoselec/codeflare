import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import Layout from '../../components/Layout';
import { sessionStore } from '../../stores/session';
import type { UserPreferences } from '../../types';

// Keep the HTTP client, response schemas, preference/session stores, Layout,
// Header and Settings real. Only unrelated rendering/terminal transport is stubbed.
vi.mock('../../components/TerminalArea', () => ({ default: () => <main>Terminal workspace</main> }));
vi.mock('../../components/StoragePanel', () => ({ default: () => null }));
vi.mock('../../components/SplashCursor', () => ({ default: () => null }));
vi.mock('../../stores/storage', () => ({
  storageStore: { fetchStats: vi.fn(), refresh: vi.fn() },
  updateStatsFromBatch: vi.fn(),
}));
vi.mock('../../stores/terminal', () => ({
  terminalStore: { authUrl: null, triggerLayoutResize: vi.fn(), dispose: vi.fn(),
    disposeSession: vi.fn(), registerSessionStoppedCallback: vi.fn() },
  registerProcessNameCallback: vi.fn(), reconnectDisconnectedTerminals: vi.fn(),
  reconnectOnVisibilityReturn: vi.fn(), scheduleDisconnect: vi.fn(), cancelScheduledDisconnect: vi.fn(),
}));

const sessionId = 'abcdef0123456789';
let saved: UserPreferences;
let invalidReply: unknown;
let lastInputAt: string;
let user: Record<string, unknown>;
const writes: Array<Record<string, unknown>> = [];

async function http(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
  if (path === '/api/preferences') {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Partial<UserPreferences>;
      writes.push(patch);
      saved = { ...saved, ...patch };
    }
    return Response.json(invalidReply === undefined ? saved : invalidReply);
  }
  if (path === '/api/user') return Response.json(user);
  if (path === '/api/sessions') return Response.json({ sessions: [{ id: sessionId, name: 'Owned terminal',
    createdAt: lastInputAt, lastAccessedAt: lastInputAt, lastStartedAt: lastInputAt,
    lastActiveAt: lastInputAt, status: 'running', lifecycle: 'running', generation: 1, revision: 1,
    workspace: 'terminal', agentType: 'bash' }] });
  if (path === '/api/sessions/batch-status') return Response.json({ statuses: {
    [sessionId]: { status: 'running', generation: 1, revision: 1, lastActiveAt: lastInputAt, lastStartedAt: lastInputAt },
  } });
  if (path === '/api/sessions/ancillary-status') return Response.json({ maxSessions: 3 });
  if (path === `/api/vault/${sessionId}/status`) return Response.json({ vaultReady: true });
  if (path === '/api/mcp-portals') return Response.json({ portals: [] });
  if (path === '/api/github/status' || path === '/api/cloudflare/status') return Response.json({ connected: false });
  if (path === '/api/llm-keys') return Response.json({});
  return new Response('Not part of this fixture', { status: 404 });
}

async function openSettings() {
  fireEvent.click(await screen.findByTestId('header-settings-button'));
  fireEvent.click(screen.getByTestId('accordion-header-session'));
  const select = screen.getByLabelText('Sleep after inactivity') as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  return select;
}

function mount() {
  window.history.replaceState({}, '', `/app/session/${sessionId}`);
  return render(() => <Layout userName="owner@example.com" userRole="user" userAccessTier="advanced" />);
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(http));
  writes.length = 0;
  invalidReply = undefined;
  localStorage.clear();
  saved = { sleepAfter: '1h', sessionMode: 'default', fastStartEnabled: true };
  lastInputAt = new Date().toISOString();
  user = { email: 'owner@example.com', authenticated: true, bucketName: 'owned-bucket',
    subscriptionTier: 'advanced', hasSubscribed: true, subscribedMode: 'default', allowedModes: ['default', 'advanced'] };
  sessionStore.setSaasMode(true);
  sessionStore.setEnterpriseMode(false);
  // Reset the real store through the same validated read used by the application.
  await sessionStore.loadPreferences();
});

afterEach(() => {
  cleanup();
  sessionStore.stopSessionListPolling();
  sessionStore.stopAllPolling();
  sessionStore.stopR2Polling();
  sessionStore.setActiveSession(null);
  vi.unstubAllGlobals();
});

describe('REQ-SESSION-014 / REQ-VAULT-033 / REQ-IDE-003: HTTP preference hydration', () => {
  it.each(['8h', '12h'] as const)('hydrates saved %s through real Layout/Header/Settings, including the already-started countdown', async sleepAfter => {
    saved = { ...saved, sessionMode: 'advanced', sleepAfter };
    // This owned run already started under this long policy; saving a new policy
    // on a 1h run is deliberately NOT used as evidence of hot timeout mutation.
    const hours = sleepAfter === '8h' ? 8 : 12;
    lastInputAt = new Date(Date.now() - (hours * 60 - 8) * 60_000).toISOString();
    mount();
    expect(await screen.findByTestId('header-vscode-button')).toBeInTheDocument();
    expect(await screen.findByTestId('header-vault-button')).toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
    // Initial session parsing does not carry telemetry; hydrate the real batch-status wire.
    await sessionStore.refreshSessionStatuses();
    fireEvent.click(await screen.findByTestId('header-timer-button'));
    expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent('< 10 min');
    expect(await openSettings()).toHaveValue(sleepAfter);
    expect(screen.getByTestId('session-mode-advanced')).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('session-mode-advanced')).not.toBeDisabled());
  });

  it.each(['8h', '12h'] as const)('saves %s, retains it through an unrelated update and a real remount/read', async sleepAfter => {
    const view = mount();
    const select = await openSettings();
    fireEvent.change(select, { target: { value: sleepAfter } });
    await waitFor(() => expect(sessionStore.preferences.sleepAfter).toBe(sleepAfter));
    expect(saved.sleepAfter).toBe(sleepAfter);
    fireEvent.click(screen.getByTestId('settings-fast-start-toggle'));
    await waitFor(() => expect(sessionStore.preferences.fastStartEnabled).toBe(false));
    expect(select).toHaveValue(sleepAfter);
    expect(saved).toMatchObject({ sleepAfter, fastStartEnabled: false });
    expect(writes).toEqual([{ sleepAfter }, { fastStartEnabled: false }]);
    view.unmount();
    mount();
    expect(await openSettings()).toHaveValue(sleepAfter);
    expect(sessionStore.preferences.fastStartEnabled).toBe(false);
  });

  it('rejects invalid GET and PATCH response values without replacing accepted Advanced state', async () => {
    saved = { ...saved, sessionMode: 'advanced', sleepAfter: '8h' };
    mount();
    expect(await screen.findByTestId('header-vscode-button')).toBeInTheDocument();
    const select = await openSettings();
    await waitFor(() => expect(select).toHaveValue('8h'));
    invalidReply = { sleepAfter: '45m', sessionMode: 'default', fastStartEnabled: false };
    await sessionStore.loadPreferences();
    expect(select).toHaveValue('8h');
    expect(screen.getByTestId('header-vault-button')).toBeInTheDocument();
    invalidReply = { sleepAfter: '24h', sessionMode: 'default', fastStartEnabled: false };
    await sessionStore.updatePreferences({ fastStartEnabled: false });
    expect(sessionStore.preferences).toMatchObject({ sleepAfter: '8h', sessionMode: 'advanced', fastStartEnabled: true });
    expect(screen.getByTestId('header-vscode-button')).toBeInTheDocument();
    expect(select).toHaveValue('8h');
  });

  it.each(['15m', '30m'] as const)('reads legacy %s as a disabled current option, not a new preset', async sleepAfter => {
    saved = { ...saved, sleepAfter };
    mount();
    const select = await openSettings();
    await waitFor(() => expect(select).toHaveValue(sleepAfter));
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.filter(option => !option.disabled).map(option => option.value)).toEqual(['1h', '2h', '4h', '8h', '12h']);
    expect(options.find(option => option.value === sleepAfter)).toBeDisabled();
    expect(saved.sleepAfter).toBe(sleepAfter);
    expect(writes).toEqual([]);
  });

  it('REQ-SUB-014: real user parsing enables entitled default metadata, then denies revoked stale Advanced on reopen', async () => {
    mount();
    await openSettings();
    await waitFor(() => expect(screen.getByTestId('session-mode-advanced')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('session-mode-advanced'));
    await waitFor(() => expect(saved.sessionMode).toBe('advanced'));
    expect(await screen.findByTestId('header-vscode-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-close-button'));
    user = { ...user, subscribedMode: 'advanced', allowedModes: ['default'] };
    await openSettings();
    await waitFor(() => expect(screen.getByTestId('session-mode-advanced')).toBeDisabled());
    expect(saved.sessionMode).toBe('advanced'); // presentation cannot rewrite stored/run policy
  });
});
