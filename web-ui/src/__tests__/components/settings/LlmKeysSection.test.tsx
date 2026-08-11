import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/client', () => ({
  getLlmKeys: vi.fn(),
  updateLlmKeys: vi.fn(),
  deleteLlmKeys: vi.fn(),
}));

import LlmKeysSection from '../../../components/settings/LlmKeysSection';
import { deleteLlmKeys, getLlmKeys, updateLlmKeys } from '../../../api/client';

const mockGetLlmKeys = vi.mocked(getLlmKeys);
const mockUpdateLlmKeys = vi.mocked(updateLlmKeys);
const mockDeleteLlmKeys = vi.mocked(deleteLlmKeys);

describe('LlmKeysSection / REQ-AGENT-020', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLlmKeys.mockResolvedValue({});
    mockUpdateLlmKeys.mockResolvedValue({});
    mockDeleteLlmKeys.mockResolvedValue(undefined);
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

  it('clears every key through the clear-all API and updates the visible state after success', async () => {
    mockGetLlmKeys.mockResolvedValue({
      openaiApiKey: '****7890',
      geminiApiKey: '****abcd',
    });
    render(() => <LlmKeysSection />);
    await screen.findByTestId('llm-keys-clear-all');

    fireEvent.click(screen.getByTestId('llm-keys-clear-all'));

    await waitFor(() => expect(mockDeleteLlmKeys).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId('llm-openai-mask')).not.toBeInTheDocument());
    expect(screen.queryByTestId('llm-gemini-mask')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect to OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect to Gemini' })).toBeInTheDocument();
  });
});
