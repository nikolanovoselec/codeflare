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

  it('shows 5 coding agent cards with correct names', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-agent-claude-code')).toBeInTheDocument();
      expect(screen.getByTestId('onboarding-agent-codex')).toBeInTheDocument();
      expect(screen.getByTestId('onboarding-agent-gemini')).toBeInTheDocument();
      expect(screen.getByTestId('onboarding-agent-github-copilot')).toBeInTheDocument();
      expect(screen.getByTestId('onboarding-agent-opencode')).toBeInTheDocument();
    });
  });

  it('coding agent cards link to correct signup URLs', async () => {
    render(() => <OnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-agent-claude-code')).toHaveAttribute('href', 'https://console.anthropic.com/');
      expect(screen.getByTestId('onboarding-agent-codex')).toHaveAttribute('href', 'https://platform.openai.com/signup');
      expect(screen.getByTestId('onboarding-agent-gemini')).toHaveAttribute('href', 'https://aistudio.google.com/');
      expect(screen.getByTestId('onboarding-agent-github-copilot')).toHaveAttribute('href', 'https://github.com/features/copilot');
      expect(screen.getByTestId('onboarding-agent-opencode')).toHaveAttribute('href', 'https://opencode.ai/');
    });
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
});
