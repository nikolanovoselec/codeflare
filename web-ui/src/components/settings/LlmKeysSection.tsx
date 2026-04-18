import { Component, createSignal, onMount } from 'solid-js';
import { getLlmKeys, updateLlmKeys } from '../../api/client';
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

  const openaiConnected = () => openaiKey().startsWith('****');
  const geminiConnected = () => geminiKey().startsWith('****');

  onMount(() => {
    getLlmKeys()
      .then((keys) => {
        if (keys.openaiApiKey) setOpenaiKey(keys.openaiApiKey);
        if (keys.geminiApiKey) setGeminiKey(keys.geminiApiKey);
      })
      .catch(() => {});
  });

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

      <ProviderRow
        icon={OpenAIIcon}
        name="OpenAI"
        brandColor="#10a37f"
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

      <ProviderRow
        icon={GeminiIcon}
        name="Gemini"
        brandColor="#4285f4"
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

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint type-hint" data-testid="llm-keys-hint">
          Keys take effect on next session start. Say "consult LLMs" in Claude Code to use.
        </span>
      </div>
    </>
  );
};

export default LlmKeysSection;
