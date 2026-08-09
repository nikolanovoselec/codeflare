import { Component, Show, createSignal, onMount } from 'solid-js';
import { deleteLlmKeys, getLlmKeys, updateLlmKeys } from '../../api/client';
import ProviderRow from './ProviderRow';
import { OpenAIIcon, GeminiIcon } from './BrandIcons';

const LlmKeysSection: Component = () => {
  const [openaiKey, setOpenaiKey] = createSignal('');
  const [geminiKey, setGeminiKey] = createSignal('');
  const [openaiSaving, setOpenaiSaving] = createSignal(false);
  const [openaiMessage, setOpenaiMessage] = createSignal<string | null>(null);
  const [openaiError, setOpenaiError] = createSignal<string | null>(null);
  const [geminiSaving, setGeminiSaving] = createSignal(false);
  const [geminiMessage, setGeminiMessage] = createSignal<string | null>(null);
  const [geminiError, setGeminiError] = createSignal<string | null>(null);
  const [loadState, setLoadState] = createSignal<'pending' | 'error' | 'success'>('pending');
  const [clearAllSaving, setClearAllSaving] = createSignal(false);
  const [clearAllError, setClearAllError] = createSignal<string | null>(null);

  const openaiConnected = () => openaiKey().startsWith('****');
  const geminiConnected = () => geminiKey().startsWith('****');

  const loadKeys = async () => {
    setLoadState('pending');
    try {
      const keys = await getLlmKeys();
      setOpenaiKey(keys.openaiApiKey || '');
      setGeminiKey(keys.geminiApiKey || '');
      setLoadState('success');
    } catch {
      setLoadState('error');
    }
  };

  onMount(() => { void loadKeys(); });

  const handleSaveOpenai = async (token: string) => {
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);
    try {
      const result = await updateLlmKeys({ openaiApiKey: token });
      setOpenaiKey(result.openaiApiKey || '');
      setOpenaiMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const handleDisconnectOpenai = async () => {
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);
    try {
      await updateLlmKeys({ openaiApiKey: null });
      setOpenaiKey('');
      setOpenaiMessage('Disconnected.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const handleSaveGemini = async (token: string) => {
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);
    try {
      const result = await updateLlmKeys({ geminiApiKey: token });
      setGeminiKey(result.geminiApiKey || '');
      setGeminiMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleDisconnectGemini = async () => {
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);
    try {
      await updateLlmKeys({ geminiApiKey: null });
      setGeminiKey('');
      setGeminiMessage('Disconnected.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleClearAll = async () => {
    setClearAllSaving(true);
    setClearAllError(null);
    try {
      await deleteLlmKeys();
      setOpenaiKey('');
      setGeminiKey('');
    } catch (error) {
      setClearAllError(error instanceof Error ? error.message : 'Failed to clear keys.');
    } finally {
      setClearAllSaving(false);
    }
  };

  return (
    <>
      <p class="llm-keys-explanation" data-testid="llm-keys-explanation">
        Optional. Used within Claude Code for code reviews and second opinion discussions with ChatGPT and Gemini.
      </p>
      <ol class="provider-steps">
        <li>Click a button below to open the provider</li>
        <li>Scroll down, confirm and create the API key</li>
        <li>Come back here, paste the key and save</li>
      </ol>

      <Show when={loadState() === 'pending'}>
        <p data-testid="llm-keys-loading" aria-live="polite">Loading saved keys...</p>
      </Show>
      <Show when={loadState() === 'error'}>
        <div data-testid="llm-keys-load-error" role="alert">
          Saved keys could not be loaded.
          <button type="button" data-testid="llm-keys-retry" onClick={() => { void loadKeys(); }}>Retry</button>
        </div>
      </Show>
      <Show when={loadState() === 'success'}>
        <ProviderRow
          icon={OpenAIIcon}
          name="OpenAI"
          brandColor="var(--color-brand-openai)"
          externalUrl="https://platform.openai.com/api-keys"
          externalLabel="Open OpenAI"
          placeholder="sk-..."
          connected={openaiConnected()}
          onSave={(token) => { void handleSaveOpenai(token); }}
          onDisconnect={() => { void handleDisconnectOpenai(); }}
          saving={openaiSaving()}
          disconnecting={openaiSaving()}
          message={openaiMessage()}
          error={openaiError()}
          testId="llm-openai-row"
        />
        <Show when={openaiConnected()}>
          <code data-testid="llm-openai-mask">{openaiKey()}</code>
        </Show>

        <ProviderRow
          icon={GeminiIcon}
          name="Gemini"
          brandColor="var(--color-brand-google)"
          externalUrl="https://aistudio.google.com/apikey"
          externalLabel="Open Google AI Studio"
          placeholder="AI..."
          connected={geminiConnected()}
          onSave={(token) => { void handleSaveGemini(token); }}
          onDisconnect={() => { void handleDisconnectGemini(); }}
          saving={geminiSaving()}
          disconnecting={geminiSaving()}
          message={geminiMessage()}
          error={geminiError()}
          testId="llm-gemini-row"
        />
        <Show when={geminiConnected()}>
          <code data-testid="llm-gemini-mask">{geminiKey()}</code>
        </Show>

        <Show when={openaiConnected() || geminiConnected()}>
          <button
            type="button"
            data-testid="llm-keys-clear-all"
            disabled={clearAllSaving()}
            onClick={() => { void handleClearAll(); }}
          >
            {clearAllSaving() ? 'Clearing...' : 'Clear all keys'}
          </button>
          <Show when={clearAllError()}>
            <span role="alert">{clearAllError()}</span>
          </Show>
        </Show>
      </Show>

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint type-hint" data-testid="llm-keys-hint">
          Keys take effect on next session start. Say "consult LLMs" in Claude Code to use.
        </span>
      </div>
    </>
  );
};

export default LlmKeysSection;
