import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/client', () => ({
  getLlmKeys: vi.fn(),
  updateLlmKeys: vi.fn(),
}));

import LlmKeysSection from '../../../components/settings/LlmKeysSection';
import { getLlmKeys, updateLlmKeys } from '../../../api/client';

const mockGetLlmKeys = vi.mocked(getLlmKeys);
const mockUpdateLlmKeys = vi.mocked(updateLlmKeys);

describe('LlmKeysSection / REQ-AGENT-020', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmKeys.mockResolvedValue({});
    mockUpdateLlmKeys.mockResolvedValue({});
  });

  afterEach(() => cleanup());

  it('shows pending state without editable disconnected controls until loading succeeds', () => {
    mockGetLlmKeys.mockReturnValue(new Promise(() => {}));

    render(() => <LlmKeysSection />);

    expect(screen.getByTestId('llm-keys-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('llm-openai-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('llm-gemini-row')).not.toBeInTheDocument();
  });

  it('shows a load error without provider controls and retries through the existing API', async () => {
    mockGetLlmKeys
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ openaiApiKey: '****1234' });

    render(() => <LlmKeysSection />);

    expect(await screen.findByTestId('llm-keys-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('llm-openai-row')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('llm-keys-retry'));

    expect(await screen.findByTestId('llm-openai-row')).toBeInTheDocument();
    expect(mockGetLlmKeys).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('llm-openai-mask')).toHaveTextContent('****1234');
  });

  it('renders editable disconnected controls only after a successful empty response', async () => {
    render(() => <LlmKeysSection />);

    expect(await screen.findByTestId('llm-openai-row')).toBeInTheDocument();
    expect(screen.getByTestId('llm-gemini-row')).toBeInTheDocument();
    expect(screen.queryByTestId('llm-keys-loading')).not.toBeInTheDocument();
    // Intentional visible-copy contract: the row identifies the provider; the action is concise.
    expect(screen.getByRole('button', { name: 'Connect to OpenAI' })).toHaveTextContent(/^Connect$/);
    expect(screen.getByRole('button', { name: 'Connect to Gemini' })).toHaveTextContent(/^Connect$/);
  });

  it('renders only server-returned masks for connected keys', async () => {
    mockGetLlmKeys.mockResolvedValue({
      openaiApiKey: '****7890',
      geminiApiKey: '****abcd',
    });

    render(() => <LlmKeysSection />);

    expect(await screen.findByTestId('llm-openai-mask')).toHaveTextContent('****7890');
    expect(screen.getByTestId('llm-gemini-mask')).toHaveTextContent('****abcd');
    expect(document.body.textContent).not.toContain('sk-full-secret');
  });

  it('replaces a submitted full key with the mask returned by the server', async () => {
    mockUpdateLlmKeys.mockResolvedValue({ openaiApiKey: '****wxyz' });
    render(() => <LlmKeysSection />);
    await screen.findByTestId('llm-openai-row');

    fireEvent.click(screen.getByRole('button', { name: 'Connect to OpenAI' }));
    fireEvent.input(screen.getByTestId('llm-openai-row-input'), { target: { value: 'sk-full-secret-wxyz' } });
    fireEvent.click(screen.getByTestId('llm-openai-row-save'));

    expect(await screen.findByTestId('llm-openai-mask')).toHaveTextContent('****wxyz');
    expect(document.body.textContent).not.toContain('sk-full-secret-wxyz');
  });

  it('REQ-AGENT-020 AC3: per-provider Disconnect removes keys without a bulk action', async () => {
    const saved: { openaiApiKey?: string; geminiApiKey?: string } = {
      openaiApiKey: '****7890', geminiApiKey: '****abcd',
    };
    mockGetLlmKeys.mockResolvedValue({ ...saved });
    mockUpdateLlmKeys.mockImplementation(async (changes) => {
      for (const key of ['openaiApiKey', 'geminiApiKey'] as const) {
        if (changes[key] === null) delete saved[key];
      }
      return { ...saved };
    });
    render(() => <LlmKeysSection />);
    await screen.findByTestId('llm-openai-mask');

    // Intentional UI contract: credential removal belongs to each provider row.
    expect(screen.queryByRole('button', { name: 'Clear all keys' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('llm-openai-row')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect to OpenAI' })).toBeInTheDocument();
    expect(screen.getByTestId('llm-gemini-mask')).toHaveTextContent('****abcd');
    expect(saved).toEqual({ geminiApiKey: '****abcd' });

    fireEvent.click(within(screen.getByTestId('llm-gemini-row')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect to Gemini' })).toBeInTheDocument();
    expect(screen.queryByTestId('llm-gemini-mask')).not.toBeInTheDocument();
    expect(saved).toEqual({});
  });

  it('REQ-AGENT-020 AC3: failed Disconnect preserves both connected providers', async () => {
    mockGetLlmKeys.mockResolvedValue({ openaiApiKey: '****7890', geminiApiKey: '****abcd' });
    mockUpdateLlmKeys.mockRejectedValue(new Error('Could not disconnect.'));
    render(() => <LlmKeysSection />);
    await screen.findByTestId('llm-openai-mask');

    const disconnect = within(screen.getByTestId('llm-openai-row')).getByRole('button', { name: 'Disconnect' });
    fireEvent.click(disconnect);
    expect(disconnect).toBeDisabled();
    await waitFor(() => expect(disconnect).toBeEnabled());
    expect(screen.getByTestId('llm-openai-mask')).toHaveTextContent('****7890');
    expect(screen.getByTestId('llm-gemini-mask')).toHaveTextContent('****abcd');
    expect(screen.queryByRole('button', { name: 'Connect to OpenAI' })).not.toBeInTheDocument();
  });
});
