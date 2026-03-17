import { Component, Accessor, Show } from 'solid-js';
import {
  mdiFastForward,
  mdiCloudSyncOutline,
  mdiContentPaste,
  mdiFileDocumentRefreshOutline,
  mdiRobotOutline,
} from '@mdi/js';
import Icon from '../Icon';
import type { Settings } from '../../lib/settings';
import { isTouchDevice } from '../../lib/mobile';

interface SessionSectionProps {
  currentSessionMode: Accessor<'default' | 'advanced'>;
  canUseAdvanced: Accessor<boolean>;
  fastStartEnabled: Accessor<boolean>;
  workspaceSyncEnabled: Accessor<boolean>;
  clipboardAccess: Accessor<boolean>;
  recreateDocsLoading: Accessor<boolean>;
  recreateDocsMessage: Accessor<string | null>;
  recreateDocsError: Accessor<string | null>;
  recreateAgentLoading: Accessor<boolean>;
  recreateAgentMessage: Accessor<string | null>;
  recreateAgentError: Accessor<string | null>;
  onSessionModeChange: (mode: 'default' | 'advanced') => void;
  onFastStartToggle: () => void;
  onWorkspaceSyncToggle: () => void;
  onRecreateDocs: () => void;
  onRecreateAgentConfigs: () => void;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const SessionSection: Component<SessionSectionProps> = (props) => {
  return (
    <>
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
            class={`session-mode-option ${props.currentSessionMode() === 'default' ? 'session-mode-option--selected' : ''}`}
          >
            <input
              type="radio"
              name="session-mode"
              value="default"
              checked={props.currentSessionMode() === 'default'}
              onChange={() => props.onSessionModeChange('default')}
              role="radio"
              aria-checked={props.currentSessionMode() === 'default'}
              data-testid="session-mode-default"
            />
            Default
          </label>
          <label
            class={`session-mode-option ${props.currentSessionMode() === 'advanced' ? 'session-mode-option--selected' : ''} ${!props.canUseAdvanced() ? 'session-mode-option--disabled' : ''}`}
          >
            <input
              type="radio"
              name="session-mode"
              value="advanced"
              checked={props.currentSessionMode() === 'advanced'}
              onChange={() => props.onSessionModeChange('advanced')}
              disabled={!props.canUseAdvanced()}
              role="radio"
              aria-checked={props.currentSessionMode() === 'advanced'}
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
          if (!(e.target as HTMLElement).closest('.toggle')) props.onFastStartToggle();
        }}>
          <label for="settings-fast-start">Fast Start</label>
          <button
            type="button"
            id="settings-fast-start"
            class={`toggle ${props.fastStartEnabled() ? 'toggle-on' : ''}`}
            onClick={props.onFastStartToggle}
            role="switch"
            aria-checked={props.fastStartEnabled()}
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
          if (!(e.target as HTMLElement).closest('.toggle')) props.onWorkspaceSyncToggle();
        }}>
          <label for="settings-workspace-sync">Sync Workspace Folder</label>
          <button
            type="button"
            id="settings-workspace-sync"
            class={`toggle ${props.workspaceSyncEnabled() ? 'toggle-on' : ''}`}
            onClick={props.onWorkspaceSyncToggle}
            role="switch"
            aria-checked={props.workspaceSyncEnabled()}
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
        <div class="settings-admin-actions">
          <button
            type="button"
            class="provider-row-connect-btn"
            style={{ background: '#0891b2' }}
            disabled={props.recreateDocsLoading()}
            onClick={props.onRecreateDocs}
            data-testid="settings-recreate-docs-label"
          >
            <Icon path={mdiFileDocumentRefreshOutline} size={24} style={{ color: 'white' }} />
            <span>{props.recreateDocsLoading() ? 'Recreating...' : 'Recreate Docs & Examples'}</span>
          </button>
          <Show when={props.recreateDocsMessage()}>
            {(message) => (
              <span class="settings-hint" data-testid="settings-recreate-docs-success">{message()}</span>
            )}
          </Show>
          <Show when={props.recreateDocsError()}>
            {(error) => (
              <span class="settings-error" data-testid="settings-recreate-docs-error">{error()}</span>
            )}
          </Show>
          <button
            type="button"
            class="provider-row-connect-btn"
            style={{ background: '#e11d48' }}
            disabled={props.recreateAgentLoading()}
            onClick={props.onRecreateAgentConfigs}
            data-testid="settings-recreate-agent-label"
          >
            <Icon path={mdiRobotOutline} size={24} style={{ color: 'white' }} />
            <span>{props.recreateAgentLoading() ? 'Recreating...' : 'Recreate Agent Skills & Rules'}</span>
          </button>
          <Show when={props.recreateAgentMessage()}>
            {(message) => (
              <span class="settings-hint" data-testid="settings-recreate-agent-success">{message()}</span>
            )}
          </Show>
          <Show when={props.recreateAgentError()}>
            {(error) => (
              <span class="settings-error" data-testid="settings-recreate-agent-error">{error()}</span>
            )}
          </Show>
        </div>
      </section>

      {/* Clipboard -- desktop only */}
      <Show when={!isTouchDevice()}>
        <section class="settings-section">
          <div class="settings-section-header">
            <Icon path={mdiContentPaste} size={16} />
            <h3 class="settings-section-title">Clipboard</h3>
          </div>
          <div class="setting-row setting-row--clickable" onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.toggle')) props.updateSetting('clipboardAccess', !props.clipboardAccess());
          }}>
            <label for="settings-clipboard-access">Allow paste from clipboard</label>
            <button
              type="button"
              id="settings-clipboard-access"
              class={`toggle ${props.clipboardAccess() ? 'toggle-on' : ''}`}
              onClick={() => props.updateSetting('clipboardAccess', !props.clipboardAccess())}
              role="switch"
              aria-checked={props.clipboardAccess()}
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
    </>
  );
};

export default SessionSection;
