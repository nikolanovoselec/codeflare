import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import OnboardingPage from '../../components/OnboardingPage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getDeployKeys: vi.fn(),
  updateDeployKeys: vi.fn(),
}));

// Mock ProviderRow to simplify testing
vi.mock('../../components/settings/ProviderRow', () => ({
  default: (props: any) => (
    <div data-testid={props.testId}>
      <span data-testid={`${props.testId}-name`}>{props.name}</span>
      <span data-testid={`${props.testId}-connected`}>{props.connected ? 'connected' : 'disconnected'}</span>
    </div>
  ),
}));

// Mock BrandIcons
vi.mock('../../components/settings/BrandIcons', () => ({
  GitHubIcon: () => <svg data-testid="github-icon" />,
  CloudflareIcon: () => <svg data-testid="cloudflare-icon" />,
}));

// Mock ScrambleText
vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span>{props.text}</span>,
}));

import { getDeployKeys, updateDeployKeys } from '../../api/client';

const mockedGetDeployKeys = vi.mocked(getDeployKeys);
const mockedUpdateDeployKeys = vi.mocked(updateDeployKeys);

describe('OnboardingPage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no tokens connected
    mockedGetDeployKeys.mockResolvedValue({});
    mockedUpdateDeployKeys.mockResolvedValue({});

    // Mock window.location
    originalLocation = window.location;
    mockLocation = { href: '' };
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('renders loading state then shows content', async () => {
    render(() => <OnboardingPage />);

    // After API resolves, content should appear
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-github-section')).toBeInTheDocument();
    });
  });

  it('shows GitHub ProviderRow with connected status when token exists', async () => {
    mockedGetDeployKeys.mockResolvedValue({
      githubToken: '****github',
    });

    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-github-row-connected')).toHaveTextContent('connected');
    });
  });

  it('shows Cloudflare ProviderRow with connected status when token exists', async () => {
    mockedGetDeployKeys.mockResolvedValue({
      cloudflareApiToken: '****cf',
    });

    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-cloudflare-row-connected')).toHaveTextContent('connected');
    });
  });

  it('shows disconnected state for both providers when no tokens', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-github-row-connected')).toHaveTextContent('disconnected');
      expect(screen.getByTestId('onboarding-cloudflare-row-connected')).toHaveTextContent('disconnected');
    });
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
      const claudeCard = screen.getByTestId('onboarding-agent-claude-code');
      expect(claudeCard).toHaveAttribute('href', 'https://console.anthropic.com/');

      const codexCard = screen.getByTestId('onboarding-agent-codex');
      expect(codexCard).toHaveAttribute('href', 'https://platform.openai.com/signup');

      const geminiCard = screen.getByTestId('onboarding-agent-gemini');
      expect(geminiCard).toHaveAttribute('href', 'https://aistudio.google.com/');

      const copilotCard = screen.getByTestId('onboarding-agent-github-copilot');
      expect(copilotCard).toHaveAttribute('href', 'https://github.com/features/copilot');

      const opencodeCard = screen.getByTestId('onboarding-agent-opencode');
      expect(opencodeCard).toHaveAttribute('href', 'https://opencode.ai/');
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

  it('renders section 3 header about coding agent subscription', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      const section = screen.getByTestId('onboarding-agents-section');
      expect(section).toBeInTheDocument();
      expect(section.textContent).toMatch(/at least one/i);
    });
  });
});
