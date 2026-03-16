import { Component, createSignal, onMount } from 'solid-js';
import { getLlmKeys, updateLlmKeys, getDeployKeys, updateDeployKeys, getPreferences, updatePreferences } from '../../api/client';
import type { DeployKeysResponse, LlmKeysResponse } from '../../api/client';
import ProviderRow from './ProviderRow';
import { AnthropicIcon, OpenAIIcon, GeminiIcon, GitHubIcon } from './BrandIcons';

// GitHub fine-grained PAT URL with Copilot scopes appended
const GITHUB_COPILOT_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Codeflare&description=Push+%26+deploy+from+Codeflare&expires_in=90'
  + '&contents=write&administration=write&workflows=write&actions=write&actions_variables=write'
  + '&pull_requests=write&issues=write&deployments=write&environments=write&pages=write'
  + '&secrets=write&statuses=write&repository_hooks=write&merge_queues=write'
  + '&security_events=write&custom_properties=write&discussions=write'
  + '&metadata=read&email_addresses=read'
  + '&user_copilot_requests=read&copilot_messages=read&copilot_editor_context=read';

const LlmKeysSection: Component = () => {
  // Anthropic state
  const [anthropicKey, setAnthropicKey] = createSignal('');
  const [anthropicSaving, setAnthropicSaving] = createSignal(false);
  const [anthropicMessage, setAnthropicMessage] = createSignal<string | null>(null);
  const [anthropicError, setAnthropicError] = createSignal<string | null>(null);

  // OpenAI state
  const [openaiKey, setOpenaiKey] = createSignal('');
  const [openaiSaving, setOpenaiSaving] = createSignal(false);
  const [openaiMessage, setOpenaiMessage] = createSignal<string | null>(null);
  const [openaiError, setOpenaiError] = createSignal<string | null>(null);

  // Gemini state
  const [geminiKey, setGeminiKey] = createSignal('');
  const [geminiSaving, setGeminiSaving] = createSignal(false);
  const [geminiMessage, setGeminiMessage] = createSignal<string | null>(null);
  const [geminiError, setGeminiError] = createSignal<string | null>(null);

  // Copilot state (uses GitHub deploy key)
  const [copilotKey, setCopilotKey] = createSignal('');
  const [copilotSaving, setCopilotSaving] = createSignal(false);
  const [copilotMessage, setCopilotMessage] = createSignal<string | null>(null);
  const [copilotError, setCopilotError] = createSignal<string | null>(null);

  // Consult LLM toggle
  const [consultLlmEnabled, setConsultLlmEnabled] = createSignal(false);

  const anthropicConnected = () => anthropicKey().startsWith('****');
  const openaiConnected = () => openaiKey().startsWith('****');
  const geminiConnected = () => geminiKey().startsWith('****');
  const copilotConnected = () => copilotKey().startsWith('****');

  onMount(() => {
    getLlmKeys()
      .then((keys: LlmKeysResponse) => {
        if (keys.anthropicApiKey) setAnthropicKey(keys.anthropicApiKey);
        if (keys.openaiApiKey) setOpenaiKey(keys.openaiApiKey);
        if (keys.geminiApiKey) setGeminiKey(keys.geminiApiKey);
      })
      .catch(() => {});

    getDeployKeys()
      .then((keys: DeployKeysResponse) => {
        if (keys.githubToken) setCopilotKey(keys.githubToken);
      })
      .catch(() => {});

    getPreferences()
      .then((prefs) => {
        if (prefs.consultLlmEnabled) setConsultLlmEnabled(true);
      })
      .catch(() => {});
  });

  // Anthropic handlers
  const handleSaveAnthropic = async (token: string) => {
    setAnthropicSaving(true);
    setAnthropicMessage(null);
    setAnthropicError(null);
    try {
      const result = await updateLlmKeys({ anthropicApiKey: token });
      setAnthropicKey(result.anthropicApiKey || '');
      setAnthropicMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setAnthropicError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setAnthropicSaving(false);
    }
  };

  const handleDisconnectAnthropic = async () => {
    setAnthropicSaving(true);
    setAnthropicMessage(null);
    setAnthropicError(null);
    try {
      await updateLlmKeys({ anthropicApiKey: null });
      setAnthropicKey('');
      setAnthropicMessage('Disconnected.');
    } catch (error) {
      setAnthropicError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setAnthropicSaving(false);
    }
  };

  // OpenAI handlers
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

  // Gemini handlers
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

  // Copilot handlers (uses deploy keys / GitHub token)
  const handleSaveCopilot = async (token: string) => {
    setCopilotSaving(true);
    setCopilotMessage(null);
    setCopilotError(null);
    try {
      const result = await updateDeployKeys({ githubToken: token });
      setCopilotKey(result.githubToken || '');
      setCopilotMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setCopilotSaving(false);
    }
  };

  const handleDisconnectCopilot = async () => {
    setCopilotSaving(true);
    setCopilotMessage(null);
    setCopilotError(null);
    try {
      await updateDeployKeys({ githubToken: null });
      setCopilotKey('');
      setCopilotMessage('Disconnected.');
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setCopilotSaving(false);
    }
  };

  // Consult LLM toggle handler
  const handleConsultLlmToggle = async () => {
    const newValue = !consultLlmEnabled();
    setConsultLlmEnabled(newValue);
    try {
      await updatePreferences({ consultLlmEnabled: newValue });
    } catch {
      // Revert on failure
      setConsultLlmEnabled(!newValue);
    }
  };

  return (
    <>
      <p class="llm-keys-explanation" data-testid="llm-keys-explanation">
        Connect your API keys so coding agents can run inside Codeflare sessions.
      </p>
      <ol class="provider-steps">
        <li>Click a button below to open the provider</li>
        <li>Scroll down, confirm and create the <span style={{ color: '#4ade80' }}>API KEY</span></li>
        <li>Come back here, paste the key and save</li>
      </ol>

      <ProviderRow
        icon={AnthropicIcon}
        name="Anthropic"
        brandColor="#d4a27f"
        externalUrl="https://console.anthropic.com/settings/keys"
        externalLabel="Open Anthropic"
        placeholder="sk-ant-..."
        connected={anthropicConnected()}
        onSave={(token) => { void handleSaveAnthropic(token); }}
        onDisconnect={() => { void handleDisconnectAnthropic(); }}
        saving={anthropicSaving()}
        disconnecting={anthropicSaving()}
        message={anthropicMessage()}
        error={anthropicError()}
        testId="llm-anthropic-row"
      />

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

      <ProviderRow
        icon={GitHubIcon}
        name="Copilot"
        brandColor="#6e5494"
        externalUrl={GITHUB_COPILOT_TOKEN_URL}
        externalLabel="Open GitHub"
        placeholder="github_pat_..."
        connected={copilotConnected()}
        onSave={(token) => { void handleSaveCopilot(token); }}
        onDisconnect={() => { void handleDisconnectCopilot(); }}
        saving={copilotSaving()}
        disconnecting={copilotSaving()}
        message={copilotMessage()}
        error={copilotError()}
        testId="llm-copilot-row"
      />

      <div class="setting-row" style={{ "margin-top": "var(--space-3)", gap: "var(--space-2)" }}>
        <label for="consult-llm-toggle" style={{ flex: '1' }}>
          Enable "consult LLMs" in Claude Code
        </label>
        <input
          type="checkbox"
          id="consult-llm-toggle"
          data-testid="consult-llm-toggle"
          checked={consultLlmEnabled()}
          disabled={!openaiConnected() && !geminiConnected()}
          onChange={() => { void handleConsultLlmToggle(); }}
        />
      </div>

      <div class="setting-row setting-row--column-gap" style={{ "margin-top": "var(--space-2)" }}>
        <span class="settings-hint" data-testid="llm-keys-hint">
          Keys take effect on next session start.
        </span>
      </div>

      <div class="setting-row" style={{ "margin-top": "var(--space-2)", gap: "var(--space-3)" }}>
        <span class="provider-row-badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>
          OpenCode <span style={{ "font-weight": "normal", "margin-left": "4px" }}>Uses keys above</span>
        </span>
        <span class="provider-row-badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>
          Bash <span style={{ "font-weight": "normal", "margin-left": "4px" }}>Always available</span>
        </span>
      </div>
    </>
  );
};

export default LlmKeysSection;
