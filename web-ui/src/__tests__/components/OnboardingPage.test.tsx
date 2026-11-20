import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@solidjs/testing-library';
import OnboardingPage from '../../components/OnboardingPage';

// api/client: only the non-connect endpoints OnboardingPage still uses.
vi.mock('../../api/client', () => ({
  markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
  getAuthStatus: vi.fn().mockResolvedValue(null),
  getPreferences: vi.fn().mockResolvedValue(null),
  updatePreferences: vi.fn().mockResolvedValue(undefined),
}));

// Connect now flows through the OAuth status/disconnect APIs (via createConnections).
const mockGetGithubStatus = vi.fn();
const mockGetCloudflareStatus = vi.fn();
const mockDisconnectCloudflare = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../api/github', () => ({
  getGithubStatus: () => mockGetGithubStatus(),
  disconnectGithub: vi.fn().mockResolvedValue({ success: true }),
  githubConnectUrl: () => '/api/github/connect',
}));
vi.mock('../../api/cloudflare', () => ({
  getCloudflareStatus: () => mockGetCloudflareStatus(),
  disconnectCloudflare: () => mockDisconnectCloudflare(),
  selectCloudflareAccount: vi.fn().mockResolvedValue({ success: true, accountId: 'a' }),
  cloudflareConnectUrl: () => '/api/cloudflare/connect',
}));

vi.mock('../../components/ScrambleText', () => ({
  default: (props: { text: string }) => <span>{props.text}</span>,
}));

describe('OnboardingPage / REQ-AUTH-015 (onboarding-mode public landing page)', () => {
  let mockLocation: { href: string; search: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: false });
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: false });

    originalLocation = window.location;
    mockLocation = { href: '', search: '' };
    Object.defineProperty(window, 'location', { value: mockLocation, writable: true });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('renders loading state then shows content', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-github-section')).toBeInTheDocument();
    });
  });

  // Caller-side oracle for the PageFooter extraction: deleting <PageFooter />
  // from this page must fail here, not just in PageFooter's own test.
  it('renders the shared page footer', async () => {
    const { container } = render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('.page-footer').length).toBe(2);
    });
  });

  it('shows the GitHub card connected when the status reports a connection', async () => {
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: true, login: 'octocat' });
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('github-connected-badge')).toBeInTheDocument();
    });
    expect(screen.getByTestId('github-identity')).toHaveTextContent('octocat');
  });

  it('REQ-AGENT-018 AC5: connected Guided Setup offers Cloudflare Disconnect but not Re-authorize', async () => {
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'acct-1' });
    render(() => <OnboardingPage />);
    const cloudflare = within(await screen.findByTestId('onboarding-cloudflare-section'));
    expect(await cloudflare.findByTestId('cloudflare-connected-badge')).toBeVisible();
    expect(cloudflare.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(cloudflare.queryByRole('button', { name: 'Re-authorize' })).not.toBeInTheDocument();
    expect(cloudflare.queryByRole('button', { name: 'Retry authorization' })).not.toBeInTheDocument();
  });

  it.each([
    ['error', 'Cloudflare authorization could not be completed. Try again.'],
    ['no-accounts', 'No Cloudflare accounts were authorized. Choose a Cloudflare account you can access and try again.'],
  ])('offers retry beside Cloudflare Connect after an OAuth %s return', async (outcome, message) => {
    mockLocation.search = `?cloudflare=${outcome}`;
    render(() => <OnboardingPage />);
    const cloudflare = within(await screen.findByTestId('onboarding-cloudflare-section'));
    expect(cloudflare.getByRole('alert')).toHaveTextContent(message);
    expect(cloudflare.getByRole('button', { name: 'Connect Cloudflare' })).toBeEnabled();
    expect(cloudflare.queryByRole('button', { name: 'Re-authorize' })).not.toBeInTheDocument();
  });

  it.each(['error', 'no-accounts'])('retries OAuth %s with a saved Guided Setup grant only after explicit tier selection', async (outcome) => {
    mockLocation.search = `?cloudflare=${outcome}`;
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'saved' });
    render(() => <OnboardingPage />);
    const cloudflare = within(await screen.findByTestId('onboarding-cloudflare-section'));
    const retry = () => cloudflare.getByRole('button', { name: 'Retry authorization' });
    expect(cloudflare.getByRole('alert')).toBeVisible();
    fireEvent.click(retry());
    const proceed = () => cloudflare.getByRole('button', { name: 'Continue to Cloudflare' });
    expect(proceed()).toBeDisabled();
    for (const name of ['Minimal', 'Recommended', 'Advanced']) {
      expect(cloudflare.getByRole('radio', { name })).not.toBeChecked();
    }
    expect(mockLocation.href).toBe('');
    fireEvent.click(cloudflare.getByRole('radio', { name: 'Advanced' }));
    fireEvent.click(cloudflare.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(retry()).toHaveFocus());
    expect(cloudflare.getByText('saved', { exact: true })).toBeVisible();
    expect(cloudflare.queryByRole('button', { name: 'Re-authorize' })).not.toBeInTheDocument();
    expect(mockLocation.href).toBe('');
    expect(mockDisconnectCloudflare).not.toHaveBeenCalled();

    fireEvent.click(retry());
    expect(proceed()).toBeDisabled();
    fireEvent.click(cloudflare.getByRole('radio', { name: 'Minimal' }));
    fireEvent.click(proceed());
    expect(mockLocation.href).toBe('/api/cloudflare/connect?tier=minimal');
    expect(mockDisconnectCloudflare).not.toHaveBeenCalled();
  });

  it.each(['another control', 'the page body'])('reloads missing Cloudflare accounts without restarting OAuth or reclaiming focus from %s', async (destination) => {
    mockLocation.search = '?cloudflare=select-account';
    let finishRead!: (value: { configured: true; connected: true; accounts: { id: string; name: string }[] }) => void;
    mockGetCloudflareStatus.mockResolvedValueOnce({ configured: true, connected: true })
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    render(() => <OnboardingPage />);
    const cloudflare = within(await screen.findByTestId('onboarding-cloudflare-section'));
    expect(cloudflare.queryByRole('combobox')).not.toBeInTheDocument();
    const retry = cloudflare.getByRole('button', { name: 'Retry loading accounts' });
    retry.focus();
    fireEvent.click(retry);
    const focusTarget = destination === 'another control'
      ? screen.getByRole('link', { name: 'Skip and continue to Codeflare' }) : document.body;
    if (focusTarget === document.body) retry.blur();
    else focusTarget.focus();
    expect(document.activeElement).toBe(focusTarget);
    finishRead({ configured: true, connected: true, accounts: [{ id: 'a', name: 'Account A' }] });
    expect(within(await cloudflare.findByRole('combobox')).getByRole('option', { name: 'Account A' })).toHaveValue('a');
    await waitFor(() => expect(cloudflare.queryByRole('button', { name: 'Retry loading accounts' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(focusTarget);
    expect(mockLocation.href).toBe('');
    expect(mockDisconnectCloudflare).not.toHaveBeenCalled();
  });

  it('shows the existing Cloudflare account picker on a Guided Setup account-selection return', async () => {
    mockLocation.search = '?cloudflare=select-account';
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true,
      accounts: [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }] });
    render(() => <OnboardingPage />);
    const cloudflare = within(await screen.findByTestId('onboarding-cloudflare-section'));
    const picker = within(cloudflare.getByRole('combobox'));
    expect(picker.getByRole('option', { name: 'Account A' })).toHaveValue('a');
    expect(picker.getByRole('option', { name: 'Account B' })).toHaveValue('b');
    expect(cloudflare.queryByRole('alert')).not.toBeInTheDocument();
  });

  // REQ-AGENT-028: both provider parents own the recommended default and selected-tier navigation.
  it('shows the connect affordance (with the connect URL) for both providers when disconnected', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('github-connect-btn')).toBeInTheDocument();
    });
    for (const provider of ['github', 'cloudflare']) {
      expect(screen.getByTestId(`${provider}-tier-recommended`)).toBeChecked();
      fireEvent.click(screen.getByTestId(`${provider}-connect-btn`));
      expect(mockLocation.href).toBe(`/api/${provider}/connect?tier=recommended`);
      fireEvent.click(screen.getByTestId(`${provider}-tier-minimal`));
      expect(screen.getByTestId(`${provider}-tier-minimal`)).toBeChecked();
      expect(screen.getByTestId(`${provider}-tier-recommended`)).not.toBeChecked();
      fireEvent.click(screen.getByTestId(`${provider}-connect-btn`));
      expect(mockLocation.href).toBe(`/api/${provider}/connect?tier=minimal`);
    }
  });

  it('renders the six installable coding agents and replaces Gemini with Antigravity', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      const cards = document.querySelectorAll('.onboarding-agent-card');
      expect(cards).toHaveLength(6);
      for (const id of ['claude-code', 'codex', 'antigravity', 'github-copilot', 'opencode', 'pi']) {
        expect(screen.getByTestId(`onboarding-agent-${id}`)).toBeInTheDocument();
      }
      expect(screen.queryByTestId('onboarding-agent-gemini')).not.toBeInTheDocument();
    });
  });

  it('coding agent cards link to their current provider or subscription guidance', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-agent-claude-code')).toHaveAttribute('href', 'https://claude.ai/upgrade');
      expect(screen.getByTestId('onboarding-agent-codex')).toHaveAttribute('href', 'https://chatgpt.com/pricing/');
      expect(screen.getByTestId('onboarding-agent-antigravity')).toHaveAttribute('href', 'https://antigravity.google/');
      expect(screen.getByTestId('onboarding-agent-github-copilot')).toHaveAttribute('href', 'https://github.com/features/copilot');
      expect(screen.getByTestId('onboarding-agent-opencode')).toHaveAttribute('href', 'https://opencode.ai/docs/providers/');
      expect(screen.getByTestId('onboarding-agent-pi')).toHaveAttribute('href', 'https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md');
    });
  });

  it('shows provider-family subscription support on every coding agent card', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => expect(screen.getByTestId('onboarding-agent-pi-providers')).toBeInTheDocument());

    const expected = {
      'claude-code': ['Anthropic'],
      codex: ['OpenAI'],
      antigravity: ['Google'],
      'github-copilot': ['Microsoft / GitHub'],
      opencode: ['OpenAI', 'Microsoft / GitHub', 'GitLab', 'OpenCode'],
      pi: ['Anthropic', 'OpenAI', 'Microsoft / GitHub', 'xAI', 'OpenRouter', 'Radius'],
    };
    for (const [agent, providers] of Object.entries(expected)) {
      const group = screen.getByTestId(`onboarding-agent-${agent}-providers`);
      expect(Array.from(group.querySelectorAll('[data-provider]')).map((badge) => badge.textContent)).toEqual(providers);
    }
  });

  it('has skip button that navigates to /app/', async () => {
    render(() => <OnboardingPage />);
    const skipBtn = screen.getByTestId('onboarding-skip');
    expect(skipBtn).toBeInTheDocument();
    expect(skipBtn).toHaveAttribute('href', '/app/');
  });

  it('has continue button that navigates to /app/', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      const continueBtn = screen.getByTestId('onboarding-continue');
      expect(continueBtn).toBeInTheDocument();
      expect(continueBtn).toHaveAttribute('href', '/app/');
    });
  });

  it('renders the coding-agent subscription section', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      const section = screen.getByTestId('onboarding-agents-section');
      expect(section).toBeInTheDocument();
      expect(section.textContent).toMatch(/at least one/i);
    });
  });

  it('REQ-AUTH-015 AC2: the idle-timeout selector offers the paying 15m-4h options', async () => {
    render(() => <OnboardingPage />);
    const select = (await waitFor(() => screen.getByTestId('onboarding-timeout-select'))) as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['15m', '30m', '1h', '2h', '4h']);
  });
});
