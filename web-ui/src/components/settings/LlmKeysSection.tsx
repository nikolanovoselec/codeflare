import { Component, createSignal, onMount } from 'solid-js';
import { getLlmKeys, updateLlmKeys } from '../../api/client';
import ProviderRow from './ProviderRow';
import ConnectProviderModal from './ConnectProviderModal';
import type { ProviderConfig } from './ConnectProviderModal';
import { OpenAIIcon, GeminiIcon } from './BrandIcons';

const OPENAI_PROVIDER: ProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  icon: OpenAIIcon,
  brandColor: '#10a37f',
  externalUrl: 'https://platform.openai.com/api-keys',
  externalLabel: 'Open OpenAI',
  placeholder: 'sk-...',
  instructions: [
    'Click "Open OpenAI" to go to your API keys page',
    'Click "Create new secret key" and copy it',
    'Paste the key below and click Save',
  ],
};

const GEMINI_PROVIDER: ProviderConfig = {
  id: 'gemini',
  name: 'Gemini',
  icon: GeminiIcon,
  brandColor: '#4285f4',
  externalUrl: 'https://aistudio.google.com/apikey',
  externalLabel: 'Open Google AI Studio',
  placeholder: 'AI...',
  instructions: [
    'Click "Open Google AI Studio" to go to your API keys page',
    'Click "Create API key" and copy it',
    'Paste the key below and click Save',
  ],
};

const LlmKeysSection: Component = () => {
  const [openaiKey, setOpenaiKey] = createSignal('');
  const [geminiKey, setGeminiKey] = createSignal('');
  const [openaiSaving, setOpenaiSaving] = createSignal(false);
  const [openaiMessage, setOpenaiMessage] = createSignal<string | null>(null);
  const [openaiError, setOpenaiError] = createSignal<string | null>(null);
  const [geminiSaving, setGeminiSaving] = createSignal(false);
  const [geminiMessage, setGeminiMessage] = createSignal<string | null>(null);
  const [geminiError, setGeminiError] = createSignal<string | null>(null);
  const [modalProvider, setModalProvider] = createSignal<string | null>(null);

  const openaiConnected = () => openaiKey().startsWith('****');
  const geminiConnected = () => geminiKey().startsWith('****');

  onMount(() => {
    getLlmKeys()
      .then((keys) => {
        if (keys.openaiApiKey) setOpenaiKey(keys.openaiApiKey);
        if (keys.geminiApiKey) setGeminiKey(keys.geminiApiKey);
      })
      .catch(() => { /* keys not loaded */ });
  });

  const handleSaveOpenai = async (token: string) => {
    if (openaiSaving()) return;
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);

    try {
      const result = await updateLlmKeys({ openaiApiKey: token });
      setOpenaiKey(result.openaiApiKey || '');
      setOpenaiMessage('OpenAI connected. Takes effect on next session start.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed to save OpenAI key.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const handleDisconnectOpenai = async () => {
    if (openaiSaving()) return;
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);

    try {
      await updateLlmKeys({ openaiApiKey: null });
      setOpenaiKey('');
      setOpenaiMessage('OpenAI disconnected.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed to disconnect OpenAI.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const handleSaveGemini = async (token: string) => {
    if (geminiSaving()) return;
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);

    try {
      const result = await updateLlmKeys({ geminiApiKey: token });
      setGeminiKey(result.geminiApiKey || '');
      setGeminiMessage('Gemini connected. Takes effect on next session start.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed to save Gemini key.');
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleDisconnectGemini = async () => {
    if (geminiSaving()) return;
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);

    try {
      await updateLlmKeys({ geminiApiKey: null });
      setGeminiKey('');
      setGeminiMessage('Gemini disconnected.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed to disconnect Gemini.');
    } finally {
      setGeminiSaving(false);
    }
  };

  return (
    <>
      <p class="llm-keys-explanation" data-testid="llm-keys-explanation">
        Optional. These keys let you consult external AI models (GPT, Gemini) for second opinions while coding. Used by the "Consult LLM" tool in Claude Code sessions.
      </p>
      <p class="llm-keys-links" data-testid="llm-keys-links">
        Get keys: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI Platform</a> · <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>
      </p>

      <ProviderRow
        icon={OpenAIIcon}
        name="OpenAI"
        connected={openaiConnected()}
        onConnect={() => { setOpenaiMessage(null); setOpenaiError(null); setModalProvider('openai'); }}
        onDisconnect={() => { void handleDisconnectOpenai(); }}
        disconnecting={openaiSaving()}
        testId="llm-openai-row"
      />

      <ProviderRow
        icon={GeminiIcon}
        name="Gemini"
        connected={geminiConnected()}
        onConnect={() => { setGeminiMessage(null); setGeminiError(null); setModalProvider('gemini'); }}
        onDisconnect={() => { void handleDisconnectGemini(); }}
        disconnecting={geminiSaving()}
        testId="llm-gemini-row"
      />

      <ConnectProviderModal
        isOpen={modalProvider() === 'openai'}
        provider={OPENAI_PROVIDER}
        onClose={() => setModalProvider(null)}
        onSave={(token) => { void handleSaveOpenai(token); }}
        connectedToken={openaiConnected() ? openaiKey() : undefined}
        saving={openaiSaving()}
        message={openaiMessage()}
        error={openaiError()}
      />

      <ConnectProviderModal
        isOpen={modalProvider() === 'gemini'}
        provider={GEMINI_PROVIDER}
        onClose={() => setModalProvider(null)}
        onSave={(token) => { void handleSaveGemini(token); }}
        connectedToken={geminiConnected() ? geminiKey() : undefined}
        saving={geminiSaving()}
        message={geminiMessage()}
        error={geminiError()}
      />

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint" data-testid="llm-keys-hint">
          Keys take effect on next session start. Used by the consult-llm MCP tool.
        </span>
      </div>
    </>
  );
};

export default LlmKeysSection;
