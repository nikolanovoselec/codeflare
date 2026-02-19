import { Component, createSignal, createEffect, on, Show, onMount } from 'solid-js';
import {
  mdiClose,
  mdiPaletteOutline,
  mdiCloudSyncOutline,
  mdiCogOutline,
  mdiGestureTapButton,
  mdiLightbulbOnOutline,
} from '@mdi/js';
import Icon from './Icon';
import Button from './ui/Button';
import UserManagement from './UserManagement';
import { loadSettings, saveSettings, defaultSettings, applyAccentColor, isValidHex } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { sessionStore } from '../stores/session';
import { isTouchDevice, isSamsungBrowser } from '../lib/mobile';
import { recreateGettingStartedDocs } from '../api/storage';
import '../styles/settings-panel.css';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserEmail?: string;
  currentUserRole?: 'admin' | 'user';
}

const DEFAULT_ACCENT_HEX = '#3b82f6';

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const [settings, setSettings] = createSignal<Settings>(defaultSettings);
  const [accentHexInput, setAccentHexInput] = createSignal('');
  const [recreateDocsLoading, setRecreateDocsLoading] = createSignal(false);
  const [recreateDocsMessage, setRecreateDocsMessage] = createSignal<string | null>(null);
  const [recreateDocsError, setRecreateDocsError] = createSignal<string | null>(null);

  const isAdmin = () => props.currentUserRole === 'admin';
  const workspaceSyncEnabled = () => sessionStore.preferences.workspaceSyncEnabled !== false;

  const showButtonLabels = () => settings().showButtonLabels !== false;
  const showTips = () => settings().showTips !== false;
  const samsungAddressBarTop = () => settings().samsungAddressBarTop === true;

  // Load settings on mount
  onMount(() => {
    const loaded = loadSettings();
    setSettings(loaded);
    setAccentHexInput(loaded.accentColor || '');
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
          {/* Accent Color Section */}
          <section class="settings-section settings-section-accent">
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

          {/* Button Labels Section — only on mobile */}
          <Show when={isTouchDevice()}>
          <section class="settings-section">
            <div class="settings-section-header">
              <Icon path={mdiGestureTapButton} size={16} />
              <h3 class="settings-section-title">Mobile Buttons</h3>
            </div>
            <div class="setting-row">
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

          {/* Samsung Address Bar Section — only on Samsung Internet */}
          <Show when={isSamsungBrowser}>
          <section class="settings-section">
            <div class="settings-section-header">
              <Icon path={mdiGestureTapButton} size={16} />
              <h3 class="settings-section-title">Samsung Internet</h3>
            </div>
            <div class="setting-row">
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

          {/* Tips & Tricks Section */}
          <section class="settings-section">
            <div class="settings-section-header">
              <Icon path={mdiLightbulbOnOutline} size={16} />
              <h3 class="settings-section-title">Tips & Tricks</h3>
            </div>
            <div class="setting-row">
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

          {/* R2 Sync Section */}
          <section class="settings-section settings-section-sync">
            <div class="settings-section-header">
              <Icon path={mdiCloudSyncOutline} size={16} />
              <h3 class="settings-section-title">R2 Sync</h3>
            </div>
            <div class="setting-row">
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
                Writes files from the repository `tutorials/` folder into your R2 root.
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
          </section>

          {/* User Management Section (admin only) */}
          <Show when={isAdmin()}>
            <UserManagement
              isOpen={props.isOpen}
              currentUserEmail={props.currentUserEmail}
              currentUserRole={props.currentUserRole}
            />
          </Show>

          {/* Administration Section */}
          <Show when={isAdmin()}>
            <section class="settings-section settings-section-4">
              <div class="settings-section-header">
                <Icon path={mdiCogOutline} size={16} />
                <h3 class="settings-section-title">Administration</h3>
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
                    Open Setup
                  </Button>
                </div>
              </div>
            </section>
          </Show>

        </div>
      </aside>
    </>
  );
};

export default SettingsPanel;
