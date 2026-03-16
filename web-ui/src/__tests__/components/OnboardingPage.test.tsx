import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import OnboardingPage from '../../components/OnboardingPage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getDeployKeys: vi.fn(),
  updateDeployKeys: vi.fn(),
  getLlmKeys: vi.fn(),
  updateLlmKeys: vi.fn(),
  markOnboardingComplete: vi.fn().mockResolvedValue({ success: true }),
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
  AnthropicIcon: () => <svg data-testid="anthropic-icon" />,
  OpenAIIcon: () => <svg data-testid="openai-icon" />,
  GeminiIcon: () => <svg data-testid="gemini-icon" />,
}));

// Mock ScrambleText
vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span>{props.text}</span>,
}));

import { getDeployKeys, updateDeployKeys, getLlmKeys, updateLlmKeys } from '../../api/client';

const mockedGetDeployKeys = vi.mocked(getDeployKeys);
const mockedUpdateDeployKeys = vi.mocked(updateDeployKeys);
const mockedGetLlmKeys = vi.mocked(getLlmKeys);
const mockedUpdateLlmKeys = vi.mocked(updateLlmKeys);

describe('OnboardingPage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no tokens connected
    mockedGetDeployKeys.mockResolvedValue({});
    mockedUpdateDeployKeys.mockResolvedValue({});
    mockedGetLlmKeys.mockResolvedValue({});
    mockedUpdateLlmKeys.mockResolvedValue({});

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

  it('renders Claude Code ProviderRow', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-anthropic-row')).toBeInTheDocument();
    });
  });

  it('renders Codex ProviderRow', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-codex-row')).toBeInTheDocument();
    });
  });

  it('renders Gemini ProviderRow', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-gemini-row')).toBeInTheDocument();
    });
  });

  it('shows 3-step provider instructions', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      const ol = document.querySelector('ol.provider-steps');
      expect(ol).toBeInTheDocument();
      expect(ol!.querySelectorAll('li').length).toBe(3);
    });
  });

  it('Section 3 title is Connect Coding Agents', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText('Connect Coding Agents')).toBeInTheDocument();
    });
  });

  it('OpenCode and Bash info badges present', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText('OpenCode')).toBeInTheDocument();
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
  });

  it('Copilot shows connected when GitHub connected', async () => {
    mockedGetDeployKeys.mockResolvedValue({ githubToken: '****gh' });

    render(() => <OnboardingPage />);

    await waitFor(() => {
      const copilotRow = screen.getByTestId('onboarding-copilot-row');
      expect(copilotRow).toBeInTheDocument();
      expect(copilotRow.textContent).toMatch(/connected/i);
    });
  });

  it('Copilot shows disconnected when GitHub not connected', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      const copilotRow = screen.getByTestId('onboarding-copilot-row');
      expect(copilotRow).toBeInTheDocument();
      expect(copilotRow.textContent).toMatch(/disconnected/i);
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

  it('renders section 3 header about coding agents', async () => {
    render(() => <OnboardingPage />);

    await waitFor(() => {
      const section = screen.getByTestId('onboarding-agents-section');
      expect(section).toBeInTheDocument();
      expect(section.textContent).toMatch(/Connect Coding Agents/i);
    });
  });
});
