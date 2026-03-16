import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import LlmKeysSection from '../../components/settings/LlmKeysSection';

const mockGetLlmKeys = vi.hoisted(() => vi.fn());
const mockUpdateLlmKeys = vi.hoisted(() => vi.fn());
const mockGetDeployKeys = vi.hoisted(() => vi.fn());
const mockUpdateDeployKeys = vi.hoisted(() => vi.fn());
const mockGetPreferences = vi.hoisted(() => vi.fn());
const mockUpdatePreferences = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({
  getLlmKeys: (...args: unknown[]) => mockGetLlmKeys(...args),
  updateLlmKeys: (body: unknown) => mockUpdateLlmKeys(body),
  getDeployKeys: (...args: unknown[]) => mockGetDeployKeys(...args),
  updateDeployKeys: (body: unknown) => mockUpdateDeployKeys(body),
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  updatePreferences: (body: unknown) => mockUpdatePreferences(body),
}));

describe('LlmKeysSection Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmKeys.mockResolvedValue({});
    mockUpdateLlmKeys.mockResolvedValue({});
    mockGetDeployKeys.mockResolvedValue({});
    mockUpdateDeployKeys.mockResolvedValue({});
    mockGetPreferences.mockResolvedValue({});
    mockUpdatePreferences.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  describe('provider rows', () => {
    it('renders all 4 ProviderRows', async () => {
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('llm-anthropic-row')).toBeInTheDocument();
        expect(screen.getByTestId('llm-openai-row')).toBeInTheDocument();
        expect(screen.getByTestId('llm-gemini-row')).toBeInTheDocument();
        expect(screen.getByTestId('llm-copilot-row')).toBeInTheDocument();
      });
    });

    it('Anthropic connected when key exists', async () => {
      mockGetLlmKeys.mockResolvedValue({ anthropicApiKey: '****1234' });
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('llm-anthropic-row-badge')).toBeInTheDocument();
      });
    });

    it('Anthropic save calls updateLlmKeys', async () => {
      mockUpdateLlmKeys.mockResolvedValueOnce({ anthropicApiKey: '****test' });

      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Connect to Anthropic/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Connect to Anthropic/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('llm-anthropic-row-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('llm-anthropic-row-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'sk-ant-test' } });
      fireEvent.click(screen.getByTestId('llm-anthropic-row-save'));

      await waitFor(() => {
        expect(mockUpdateLlmKeys).toHaveBeenCalledWith({ anthropicApiKey: 'sk-ant-test' });
      });
    });

    it('Anthropic disconnect sends null', async () => {
      mockGetLlmKeys.mockResolvedValue({ anthropicApiKey: '****1234' });
      mockUpdateLlmKeys.mockResolvedValueOnce({});

      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Disconnect').length).toBeGreaterThan(0);
      });

      const disconnectButtons = screen.getAllByText('Disconnect');
      fireEvent.click(disconnectButtons[0]);

      await waitFor(() => {
        expect(mockUpdateLlmKeys).toHaveBeenCalledWith({ anthropicApiKey: null });
      });
    });

    it('Copilot connected when GitHub masked', async () => {
      mockGetDeployKeys.mockResolvedValue({ githubToken: '****gh' });
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('llm-copilot-row-badge')).toBeInTheDocument();
      });
    });
  });

  describe('consult-llm toggle', () => {
    it('default unchecked', async () => {
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        const toggle = screen.getByTestId('consult-llm-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(false);
      });
    });

    it('disabled when no OpenAI/Gemini key connected', async () => {
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        const toggle = screen.getByTestId('consult-llm-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(true);
      });
    });

    it('enabled when at least one LLM key connected', async () => {
      mockGetLlmKeys.mockResolvedValue({ openaiApiKey: '****oai' });
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        const toggle = screen.getByTestId('consult-llm-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(false);
      });
    });
  });

  describe('info badges', () => {
    it('OpenCode badge shows "Uses keys above" text', async () => {
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Uses keys above/)).toBeInTheDocument();
      });
    });

    it('Bash badge shows "Always available" text', async () => {
      render(() => <LlmKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Always available/)).toBeInTheDocument();
      });
    });
  });
});
