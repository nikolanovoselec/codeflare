import { Component, createSignal, createEffect, on, Show, onMount, JSX } from 'solid-js';
import {
  mdiClose,
  mdiPaletteOutline,
  mdiCloudSyncOutline,
  mdiCogOutline,
  mdiFastForward,
  mdiContentPaste,
  mdiKeyVariant,
  mdiChevronDown,
} from '@mdi/js';
import Icon from './Icon';
import Button from './ui/Button';
import { loadSettings, saveSettings, defaultSettings, applyAccentColor, isValidHex } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { sessionStore } from '../stores/session';
import { isTouchDevice, isSamsungBrowser } from '../lib/mobile';
import { recreateGettingStartedDocs, recreateAgentConfigs } from '../api/storage';
import { getLlmKeys, updateLlmKeys } from '../api/client';
import '../styles/settings-panel.css';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserEmail?: string;
  currentUserRole?: 'admin' | 'user';
}

type AccordionGroup = 'appearance' | 'session' | 'llm' | 'admin';

interface AccordionSectionProps {
  group: AccordionGroup;
  title: string;
  subtitle: string;
  isOpen: boolean;
  onToggle: () => void;
  children: JSX.Element;
}

/*
 * AccordionSection — single-open accordion pattern
 *
 * - Only one group is expanded at a time; clicking a collapsed header opens it
 *   and closes the current one. Clicking the open header is a no-op.
 * - Resets to "Appearance" whenever the parent panel is closed and reopened.
 * - ARIA follows the WAI-ARIA Accordion Pattern: h3 wraps button (not vice
 *   versa), button has aria-expanded & aria-controls, content region has
 *   role="region" and aria-labelledby.
 * - Collapse animation uses CSS grid-template-rows (0fr → 1fr, 250ms).
 *   The inner wrapper uses visibility: hidden (delayed) to prevent keyboard
 *   focus from reaching collapsed content.
 */
const AccordionSection: Component<AccordionSectionProps> = (props) => {
  const headerId = () => `accordion-header-${props.group}`;
  const panelId = () => `accordion-panel-${props.group}`;

  return (
    <div class="settings-group">
      <h3 class="settings-group-heading">
        <button
          type="button"
          class="accordion-header"
          aria-expanded={props.isOpen}
          aria-controls={panelId()}
          id={headerId()}
          data-testid={headerId()}
          onClick={() => props.onToggle()}
        >
          <span class={`accordion-chevron ${props.isOpen ? 'accordion-chevron--open' : ''}`}>
            <Icon path={mdiChevronDown} size={20} />
          </span>
          <span class="accordion-header-text">
            <span class="settings-group-title">{props.title}</span>
            <Show when={!props.isOpen}>
              <span class="accordion-subtitle" data-testid={`accordion-subtitle-${props.group}`}>
                {props.subtitle}
              </span>
            </Show>
          </span>
        </button>
      </h3>
      <div
        class={`accordion-body ${props.isOpen ? 'accordion-body--open' : ''}`}
        id={panelId()}
        data-testid={panelId()}
        role="region"
        aria-labelledby={headerId()}
        aria-hidden={!props.isOpen}
      >
        <div class="accordion-body-inner">
          {props.children}
        </div>
      </div>
    </div>
  );
};

const DEFAULT_ACCENT_HEX = '#3b82f6';

const ACCORDION_SUBTITLES: Record<AccordionGroup, string> = {
  appearance: 'Colors, tips & display preferences',
  session: 'Startup behavior & workspace sync',
  llm: 'Optional — connect GPT & Gemini for second opinions',
  admin: 'Setup wizard & user management',
};

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [settings, setSettings] = createSignal<Settings>(defaultSettings);
  const [accentHexInput, setAccentHexInput] = createSignal('');
  const [recreateDocsLoading, setRecreateDocsLoading] = createSignal(false);
  const [recreateDocsMessage, setRecreateDocsMessage] = createSignal<string | null>(null);
  const [recreateDocsError, setRecreateDocsError] = createSignal<string | null>(null);
  const [recreateAgentLoading, setRecreateAgentLoading] = createSignal(false);
  const [recreateAgentMessage, setRecreateAgentMessage] = createSignal<string | null>(null);
  const [recreateAgentError, setRecreateAgentError] = createSignal<string | null>(null);
  const [llmOpenaiKey, setLlmOpenaiKey] = createSignal('');
  const [llmGeminiKey, setLlmGeminiKey] = createSignal('');
  const [llmKeysSaving, setLlmKeysSaving] = createSignal(false);
  const [llmKeysMessage, setLlmKeysMessage] = createSignal<string | null>(null);
  const [llmKeysError, setLlmKeysError] = createSignal<string | null>(null);
  const [openGroup, setOpenGroup] = createSignal<AccordionGroup>('appearance');

  // Reset accordion to Appearance when panel is closed then reopened (false → true)
  createEffect(on(
    () => props.isOpen,
    (isOpen, prevIsOpen) => {
      if (isOpen && prevIsOpen === false) {
        setOpenGroup('appearance');
      }
    }
  ));

  const handleAccordionClick = (group: AccordionGroup) => {
    if (openGroup() !== group) setOpenGroup(group);
  };

  const isAdmin = () => props.currentUserRole === 'admin';
  const workspaceSyncEnabled = () => sessionStore.preferences.workspaceSyncEnabled !== false;
  const fastStartEnabled = () => sessionStore.preferences.fastStartEnabled !== false;
  const currentSessionMode = () => sessionStore.preferences.sessionMode ?? 'default';

  const showButtonLabels = () => settings().showButtonLabels !== false;
  const showTips = () => settings().showTips !== false;
  const samsungAddressBarTop = () => settings().samsungAddressBarTop !== false;
  const clipboardAccess = () => settings().clipboardAccess === true;

  // Load settings on mount
  onMount(() => {
    const loaded = loadSettings();
    setSettings(loaded);
    setAccentHexInput(loaded.accentColor || '');

    // Load masked LLM keys
    getLlmKeys()
      .then((keys) => {
        if (keys.openaiApiKey) setLlmOpenaiKey(keys.openaiApiKey);
        if (keys.geminiApiKey) setLlmGeminiKey(keys.geminiApiKey);
      })
      .catch(() => { /* ignore — keys not loaded */ });
  });

  // Save settings whenever they change (deferred to skip initial mount)
  createEffect(on(() => settings(), (s) => saveSettings(s), { defer: true }));

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // Handle Escape key to close panel
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.isOpen) {
      props.onClose();
    }
  };

  // Handle backdrop click
  const handleBackdropClick = () => {
    props.onClose();
  };

  const handleWorkspaceSyncToggle = () => {
    void sessionStore.updatePreferences({ workspaceSyncEnabled: !workspaceSyncEnabled() });
  };

  const handleFastStartToggle = () => {
    void sessionStore.updatePreferences({ fastStartEnabled: !fastStartEnabled() });
  };

  const handleSessionModeChange = (mode: 'default' | 'advanced') => {
    if (mode === currentSessionMode()) return;
    void sessionStore.updatePreferences({ sessionMode: mode });
  };

  const handleRecreateDocs = async () => {
    if (recreateDocsLoading()) return;

    setRecreateDocsLoading(true);
    setRecreateDocsMessage(null);
    setRecreateDocsError(null);

    try {
      const result = await recreateGettingStartedDocs();
      setRecreateDocsMessage(
        `Recreated ${result.written.length} getting-started file(s) in your R2 root.`
      );
    } catch (error) {
      setRecreateDocsError(
        error instanceof Error
          ? error.message
          : 'Failed to recreate getting-started documentation.'
      );
    } finally {
      setRecreateDocsLoading(false);
    }
  };

  const handleRecreateAgentConfigs = async () => {
    if (recreateAgentLoading()) return;

    setRecreateAgentLoading(true);
    setRecreateAgentMessage(null);
    setRecreateAgentError(null);

    try {
      const result = await recreateAgentConfigs();
      const parts = [`Recreated ${result.written.length} agent config file(s).`];
      if (result.deleted && result.deleted.length > 0) {
        parts.push(`Removed ${result.deleted.length} file(s) from previous mode.`);
      }
      setRecreateAgentMessage(parts.join(' '));
    } catch (error) {
      setRecreateAgentError(
        error instanceof Error
          ? error.message
          : 'Failed to recreate agent configurations.'
      );
    } finally {
      setRecreateAgentLoading(false);
    }
  };

  const handleSaveLlmKeys = async () => {
    if (llmKeysSaving()) return;

    setLlmKeysSaving(true);
    setLlmKeysMessage(null);
    setLlmKeysError(null);

    try {
      const payload: { openaiApiKey?: string | null; geminiApiKey?: string | null } = {};

      // Skip masked values (already stored) — only send changes
      const openai = llmOpenaiKey();
      if (openai === '') {
        payload.openaiApiKey = null; // clear
      } else if (!openai.startsWith('****')) {
        payload.openaiApiKey = openai; // new value
      }

      const gemini = llmGeminiKey();
      if (gemini === '') {
        payload.geminiApiKey = null; // clear
      } else if (!gemini.startsWith('****')) {
        payload.geminiApiKey = gemini; // new value
      }

      const result = await updateLlmKeys(payload);
      // Update inputs with masked values from server
      setLlmOpenaiKey(result.openaiApiKey || '');
      setLlmGeminiKey(result.geminiApiKey || '');
      setLlmKeysMessage('Keys saved. Takes effect on next session start.');
    } catch (error) {
      setLlmKeysError(
        error instanceof Error ? error.message : 'Failed to save LLM keys.'
      );
    } finally {
      setLlmKeysSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        class={`settings-backdrop ${props.isOpen ? 'open' : ''}`}
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        data-testid="settings-backdrop"
      />

      {/* Panel */}
      <aside
        class={`settings-panel ${props.isOpen ? 'open' : ''}`}
        data-testid="settings-panel"
        role="dialog"
        aria-label="Settings"
        aria-hidden={!props.isOpen}
      >
        {/* Header */}
        <header class="settings-header">
          <h2 class="settings-title">Settings</h2>
          <button
            type="button"
            class="settings-close-button"
            onClick={() => props.onClose()}
            title="Close settings"
            data-testid="settings-close-button"
          >
            <Icon path={mdiClose} size={20} />
          </button>
        </header>

        {/* Content */}
        <div class="settings-content">
          {/* ── Appearance ── */}
          <AccordionSection
            group="appearance"
            title="Appearance"
            subtitle={ACCORDION_SUBTITLES.appearance}
            isOpen={openGroup() === 'appearance'}
            onToggle={() => handleAccordionClick('appearance')}
          >
            {/* Accent Color */}
            <section class="settings-section">
              <div class="settings-section-header">
                <Icon path={mdiPaletteOutline} size={16} />
                <h3 class="settings-section-title">Accent Color</h3>
              </div>
              <p class="settings-hint" style={{ "margin-bottom": "var(--space-2)" }}>
                Customize the UI accent color
              </p>
              <div class="accent-color-row">
                <span
                  class="accent-color-swatch"
                  style={{
                    background: accentHexInput() && isValidHex(accentHexInput())
                      ? (accentHexInput().startsWith('#') ? accentHexInput() : `#${accentHexInput()}`)
                      : DEFAULT_ACCENT_HEX,
                  }}
                  data-testid="accent-color-swatch"
                />
                <input
                  type="text"
                  class="accent-color-input"
                  value={accentHexInput()}
                  placeholder={DEFAULT_ACCENT_HEX}
                  maxLength={7}
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck={false}
                  onInput={(e) => {
                    const val = e.currentTarget.value;
                    setAccentHexInput(val);
                    if (isValidHex(val)) {
                      const normalized = val.startsWith('#') ? val : `#${val}`;
                      applyAccentColor(normalized);
                      updateSetting('accentColor', normalized);
                    }
                  }}
                  data-testid="accent-color-input"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAccentHexInput('');
                    applyAccentColor(undefined);
                    updateSetting('accentColor', undefined as unknown as Settings['accentColor']);
                  }}
                  data-testid="accent-color-reset"
                >
                  Reset
                </Button>
              </div>
              <a
                class="accent-color-link"
                href="https://htmlcolorcodes.com/color-picker/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Find colors at htmlcolorcodes.com
              </a>
            </section>

            {/* Tips & Tricks */}
            <section class="settings-section">
              <div class="setting-row setting-row--clickable" onClick={(e) => {
                if (!(e.target as HTMLElement).closest('.toggle')) updateSetting('showTips', !showTips());
              }}>
                <label for="settings-show-tips">Show tips on dashboard</label>
                <button
                  type="button"
                  id="settings-show-tips"
                  class={`toggle ${showTips() ? 'toggle-on' : ''}`}
                  onClick={() => updateSetting('showTips', !showTips())}
                  role="switch"
                  aria-checked={showTips()}
                  data-testid="settings-show-tips-toggle"
                >
                  <span class="toggle-thumb" />
                </button>
              </div>
              <div class="setting-row setting-row--column-gap">
                <span class="settings-hint">
                  Show rotating tips & tricks on the dashboard. When disabled, a welcome card is shown instead.
                </span>
              </div>
            </section>

            {/* Button Labels — mobile only */}
            <Show when={isTouchDevice()}>
              <section class="settings-section">
                <div class="setting-row setting-row--clickable" onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('.toggle')) updateSetting('showButtonLabels', !showButtonLabels());
                }}>
                  <label for="settings-button-labels">Show button labels</label>
                  <button
                    type="button"
                    id="settings-button-labels"
                    class={`toggle ${showButtonLabels() ? 'toggle-on' : ''}`}
                    onClick={() => updateSetting('showButtonLabels', !showButtonLabels())}
                    role="switch"
                    aria-checked={showButtonLabels()}
                    data-testid="settings-button-labels-toggle"
                  >
                    <span class="toggle-thumb" />
                  </button>
                </div>
                <div class="setting-row setting-row--column-gap">
                  <span class="settings-hint">
                    Briefly show text labels next to floating terminal buttons when the keyboard opens.
                  </span>
                </div>
              </section>
            </Show>

            {/* Samsung — Samsung only */}
            <Show when={isSamsungBrowser}>
              <section class="settings-section">
                <div class="setting-row setting-row--clickable" onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('.toggle')) updateSetting('samsungAddressBarTop', !samsungAddressBarTop());
                }}>
                  <label for="settings-samsung-bar-top">Address bar at top</label>
                  <button
                    type="button"
                    id="settings-samsung-bar-top"
                    class={`toggle ${samsungAddressBarTop() ? 'toggle-on' : ''}`}
                    onClick={() => updateSetting('samsungAddressBarTop', !samsungAddressBarTop())}
                    role="switch"
                    aria-checked={samsungAddressBarTop()}
                    data-testid="settings-samsung-bar-top-toggle"
                  >
                    <span class="toggle-thumb" />
                  </button>
                </div>
                <div class="setting-row setting-row--column-gap">
                  <span class="settings-hint">
                    Enable if your Samsung Internet address bar is at the top. Fixes keyboard button positioning.
                  </span>
                </div>
              </section>
            </Show>
          </AccordionSection>

          {/* ── Session Defaults ── */}
          <AccordionSection
            group="session"
            title="Session Defaults"
            subtitle={ACCORDION_SUBTITLES.session}
            isOpen={openGroup() === 'session'}
            onToggle={() => handleAccordionClick('session')}
          >
            {/* Session Mode */}
            <section class="settings-section">
              <div class="settings-section-header">
                <h3 class="settings-section-title">Session Mode</h3>
              </div>
              <div
                class="session-mode-control"
                role="radiogroup"
                aria-label="Session mode"
                data-testid="session-mode-control"
              >
                <label
                  class={`session-mode-option ${currentSessionMode() === 'default' ? 'session-mode-option--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="session-mode"
                    value="default"
                    checked={currentSessionMode() === 'default'}
                    onChange={() => handleSessionModeChange('default')}
                    role="radio"
                    aria-checked={currentSessionMode() === 'default'}
                    data-testid="session-mode-default"
                  />
                  Default
                </label>
                <label
                  class={`session-mode-option ${currentSessionMode() === 'advanced' ? 'session-mode-option--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="session-mode"
                    value="advanced"
                    checked={currentSessionMode() === 'advanced'}
                    onChange={() => handleSessionModeChange('advanced')}
                    role="radio"
                    aria-checked={currentSessionMode() === 'advanced'}
                    data-testid="session-mode-advanced"
                  />
                  Advanced
                </label>
              </div>
              <div class="setting-row setting-row--column-gap">
                <span class="settings-hint" data-testid="session-mode-hint">
                  Controls which AI skills and rules are preseeded. Click "Recreate" below to apply.
                </span>
              </div>
            </section>

            {/* Agent Startup / Fast Start */}
            <section class="settings-section">
              <div class="settings-section-header">
                <Icon path={mdiFastForward} size={16} />
                <h3 class="settings-section-title">Agent Startup</h3>
              </div>
              <div class="setting-row setting-row--clickable" onClick={(e) => {
                if (!(e.target as HTMLElement).closest('.toggle')) handleFastStartToggle();
              }}>
                <label for="settings-fast-start">Fast Start</label>
                <button
                  type="button"
                  id="settings-fast-start"
                  class={`toggle ${fastStartEnabled() ? 'toggle-on' : ''}`}
                  onClick={handleFastStartToggle}
                  role="switch"
                  aria-checked={fastStartEnabled()}
                  data-testid="settings-fast-start-toggle"
                >
                  <span class="toggle-thumb" />
                </button>
              </div>
              <div class="setting-row setting-row--column-gap">
                <span class="settings-hint" data-testid="settings-fast-start-hint">
                  Launch pre-installed CLI versions for instant startup. Turn off to allow tools to auto-update on launch (slower startup, latest features).
                </span>
              </div>
            </section>

            {/* R2 Sync */}
            <section class="settings-section">
              <div class="settings-section-header">
                <Icon path={mdiCloudSyncOutline} size={16} />
                <h3 class="settings-section-title">R2 Sync</h3>
              </div>
              <div class="setting-row setting-row--clickable" onClick={(e) => {
                if (!(e.target as HTMLElement).closest('.toggle')) handleWorkspaceSyncToggle();
              }}>
                <label for="settings-workspace-sync">Sync Workspace Folder</label>
                <button
                  type="button"
                  id="settings-workspace-sync"
                  class={`toggle ${workspaceSyncEnabled() ? 'toggle-on' : ''}`}
                  onClick={handleWorkspaceSyncToggle}
                  role="switch"
                  aria-checked={workspaceSyncEnabled()}
                  data-testid="settings-workspace-sync-toggle"
                >
                  <span class="toggle-thumb" />
                </button>
              </div>
              <div class="setting-row setting-row--column-gap">
                <span class="settings-hint" data-testid="settings-workspace-sync-hint">
                  Workspace sync increases startup time. Prefer cloning repositories fresh inside each session.
                  Restart the session after changing this switch for it to take effect.
                </span>
              </div>
              <div class="setting-row setting-row--column-gap">
                <div class="setting-row setting-row--split" data-testid="settings-recreate-docs-row">
                  <span class="settings-hint settings-hint--primary" data-testid="settings-recreate-docs-label">
                    Recreate getting-started documentation
                  </span>
                  <div class="settings-recreate-docs-action">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={recreateDocsLoading()}
                      onClick={() => { void handleRecreateDocs(); }}
                    >
                      Recreate
                    </Button>
                  </div>
                </div>
                <span class="settings-hint" data-testid="settings-recreate-docs-hint">
                  Writes files from the repository `preseed/tutorials/` folder into your R2 root.
                </span>
                <Show when={recreateDocsMessage()}>
                  {(message) => (
                    <span class="settings-hint" data-testid="settings-recreate-docs-success">{message()}</span>
                  )}
                </Show>
                <Show when={recreateDocsError()}>
                  {(error) => (
                    <span class="settings-error" data-testid="settings-recreate-docs-error">{error()}</span>
                  )}
                </Show>
              </div>
              <div class="setting-row setting-row--column-gap">
                <div class="setting-row setting-row--split" data-testid="settings-recreate-agent-row">
                  <span class="settings-hint settings-hint--primary" data-testid="settings-recreate-agent-label">
                    Recreate AI agent skills & rules
                  </span>
                  <div class="settings-recreate-docs-action">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={recreateAgentLoading()}
                      onClick={() => { void handleRecreateAgentConfigs(); }}
                    >
                      Recreate
                    </Button>
                  </div>
                </div>
                <span class="settings-hint" data-testid="settings-recreate-agent-hint">
                  Writes AI agent configuration files (skills, rules) into your R2 storage.
                </span>
                <Show when={recreateAgentMessage()}>
                  {(message) => (
                    <span class="settings-hint" data-testid="settings-recreate-agent-success">{message()}</span>
                  )}
                </Show>
                <Show when={recreateAgentError()}>
                  {(error) => (
                    <span class="settings-error" data-testid="settings-recreate-agent-error">{error()}</span>
                  )}
                </Show>
              </div>
            </section>

            {/* Clipboard — desktop only */}
            <Show when={!isTouchDevice()}>
              <section class="settings-section">
                <div class="settings-section-header">
                  <Icon path={mdiContentPaste} size={16} />
                  <h3 class="settings-section-title">Clipboard</h3>
                </div>
                <div class="setting-row setting-row--clickable" onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('.toggle')) updateSetting('clipboardAccess', !clipboardAccess());
                }}>
                  <label for="settings-clipboard-access">Allow paste from clipboard</label>
                  <button
                    type="button"
                    id="settings-clipboard-access"
                    class={`toggle ${clipboardAccess() ? 'toggle-on' : ''}`}
                    onClick={() => updateSetting('clipboardAccess', !clipboardAccess())}
                    role="switch"
                    aria-checked={clipboardAccess()}
                    data-testid="settings-clipboard-access-toggle"
                  >
                    <span class="toggle-thumb" />
                  </button>
                </div>
                <div class="setting-row setting-row--column-gap">
                  <span class="settings-hint">
                    Allow right-click paste from clipboard. Works best in Chrome; unreliable in other browsers. When enabled, your browser may prompt for clipboard permission.
                  </span>
                </div>
              </section>
            </Show>
          </AccordionSection>

          {/* ── LLM API Keys (advanced mode only) ── */}
          <Show when={currentSessionMode() === 'advanced'}>
            <AccordionSection
              group="llm"
              title="LLM API Keys"
              subtitle={ACCORDION_SUBTITLES.llm}
              isOpen={openGroup() === 'llm'}
              onToggle={() => handleAccordionClick('llm')}
            >
              <p class="llm-keys-explanation" data-testid="llm-keys-explanation">
                Optional. These keys let you consult external AI models (GPT, Gemini) for second opinions while coding. Used by the "Consult LLM" tool in Claude Code sessions.
              </p>
              <p class="llm-keys-links" data-testid="llm-keys-links">
                Get keys: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI Platform</a> · <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>
              </p>

              <section class="settings-section">
                <div class="settings-section-header">
                  <Icon path={mdiKeyVariant} size={16} />
                  <h3 class="settings-section-title">Provider Keys</h3>
                </div>
                <div class="setting-row setting-row--column-gap">
                  <label for="settings-llm-openai-key">OpenAI API Key</label>
                  <input
                    type="password"
                    id="settings-llm-openai-key"
                    class="llm-key-input"
                    value={llmOpenaiKey()}
                    placeholder="sk-..."
                    autocomplete="off"
                    onInput={(e) => setLlmOpenaiKey(e.currentTarget.value)}
                    data-testid="settings-llm-openai-key"
                  />
                </div>
                <div class="setting-row setting-row--column-gap">
                  <label for="settings-llm-gemini-key">Gemini API Key</label>
                  <input
                    type="password"
                    id="settings-llm-gemini-key"
                    class="llm-key-input"
                    value={llmGeminiKey()}
                    placeholder="AI..."
                    autocomplete="off"
                    onInput={(e) => setLlmGeminiKey(e.currentTarget.value)}
                    data-testid="settings-llm-gemini-key"
                  />
                </div>
                <div class="setting-row setting-row--column-gap">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={llmKeysSaving()}
                    onClick={() => { void handleSaveLlmKeys(); }}
                    data-testid="settings-llm-keys-save"
                  >
                    Save Keys
                  </Button>
                  <span class="settings-hint" data-testid="settings-llm-keys-hint">
                    Keys take effect on next session start. Used by the consult-llm MCP tool.
                  </span>
                  <Show when={llmKeysMessage()}>
                    {(message) => (
                      <span class="settings-hint" data-testid="settings-llm-keys-success">{message()}</span>
                    )}
                  </Show>
                  <Show when={llmKeysError()}>
                    {(error) => (
                      <span class="settings-error" data-testid="settings-llm-keys-error">{error()}</span>
                    )}
                  </Show>
                </div>
              </section>
            </AccordionSection>
          </Show>

          {/* ── Administration (admin only) ── */}
          <Show when={isAdmin()}>
            <AccordionSection
              group="admin"
              title="Administration"
              subtitle={ACCORDION_SUBTITLES.admin}
              isOpen={openGroup() === 'admin'}
              onToggle={() => handleAccordionClick('admin')}
            >
              <section class="settings-section">
                <div class="settings-section-header">
                  <Icon path={mdiCogOutline} size={16} />
                  <h3 class="settings-section-title">Setup</h3>
                </div>
                <div class="setting-row setting-row--column-gap">
                  <span class="settings-hint">
                    Re-run the setup wizard to reconfigure domain, users, or secrets
                  </span>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { window.location.href = '/setup'; }}
                    >
                      Open Setup & User Management
                    </Button>
                  </div>
                  <span class="settings-hint" data-testid="settings-r2-warning">
                    Changing your Cloudflare API token requires re-running setup. R2 credentials and per-user storage tokens depend on the API token — without re-running, file sync and new sessions will break.
                  </span>
                </div>
              </section>
            </AccordionSection>
          </Show>

        </div>
      </aside>
    </>
  );
};

export default SettingsPanel;
