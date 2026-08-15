import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
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
vi.mock('../../api/github', () => ({
  getGithubStatus: () => mockGetGithubStatus(),
  disconnectGithub: vi.fn().mockResolvedValue({ success: true }),
  githubConnectUrl: () => '/api/github/connect',
}));
vi.mock('../../api/cloudflare', () => ({
  getCloudflareStatus: () => mockGetCloudflareStatus(),
  disconnectCloudflare: vi.fn().mockResolvedValue({ success: true }),
  selectCloudflareAccount: vi.fn().mockResolvedValue({ success: true, accountId: 'a' }),
  cloudflareConnectUrl: () => '/api/cloudflare/connect',
}));

vi.mock('../../components/ScrambleText', () => ({
  default: (props: { text: string }) => <span>{props.text}</span>,
}));

describe('OnboardingPage / REQ-AUTH-015 (onboarding-mode public landing page)', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: false });
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: false });

    originalLocation = window.location;
    mockLocation = { href: '' };
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

  it('shows the Cloudflare card connected when the status reports a connection', async () => {
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'acct-1' });
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('cloudflare-connected-badge')).toBeInTheDocument();
    });
  });

  it('shows the connect affordance (with the connect URL) for both providers when disconnected', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('github-connect-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('github-connect-btn').getAttribute('data-href')).toContain('/api/github/connect');
    expect(screen.getByTestId('cloudflare-connect-btn').getAttribute('data-href')).toContain('/api/cloudflare/connect');
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
