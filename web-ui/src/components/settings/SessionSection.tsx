import { Component, Accessor, Show } from 'solid-js';
import {
  mdiFastForward,
  mdiBellOutline,
  mdiConsoleLine,
  mdiCloudSyncOutline,
  mdiContentPaste,
  mdiFileDocumentRefreshOutline,
  mdiFileTree,
  mdiRobotOutline,
  mdiTimerSandComplete,
} from '@mdi/js';
import Icon from '../Icon';
import type { Settings } from '../../lib/settings';
import type { AgentNotificationEnablement } from '../../lib/agent-notifications';
import type { SessionWorkspace } from '../../types';
import { isTouchDevice, needsHomeScreenInstallForNotifications } from '../../lib/mobile';
import AdminActionButton from './AdminActionButton';

interface SessionSectionProps {
  enterpriseMode?: Accessor<boolean>;
  saasMode?: Accessor<boolean>;
  currentSessionMode: Accessor<'default' | 'advanced'>;
  defaultWorkspace: Accessor<SessionWorkspace>;
  canUseAdvanced: Accessor<boolean>;
  fastStartEnabled: Accessor<boolean>;
  herdrEnabled: Accessor<boolean>;
  workspaceSyncEnabled: Accessor<boolean>;
  clipboardAccess: Accessor<boolean>;
  notificationPermission: Accessor<AgentNotificationEnablement>;
  notificationEnabled?: Accessor<boolean>;
  sleepAfter: Accessor<string>;
  canChangeSleepAfter: Accessor<boolean>;
  isFreeUser: Accessor<boolean>;
  recreateDocsLoading: Accessor<boolean>;
  recreateDocsMessage: Accessor<string | null>;
  recreateDocsError: Accessor<string | null>;
  recreateAgentLoading: Accessor<boolean>;
  recreateAgentMessage: Accessor<string | null>;
  recreateAgentError: Accessor<string | null>;
  onSessionModeChange: (mode: 'default' | 'advanced') => void;
  onDefaultWorkspaceChange: (workspace: SessionWorkspace) => void;
  onFastStartToggle: () => void;
  onHerdrToggle: () => void;
  onWorkspaceSyncToggle: () => void;
  onEnableAgentNotifications: () => void;
  onSleepAfterChange: (value: string) => void;
  onRecreateDocs: () => void;
  onRecreateAgentConfigs: () => void;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const SessionSection: Component<SessionSectionProps> = (props) => {
  const notificationEnabled = () => props.notificationEnabled?.()
    ?? props.notificationPermission() === 'granted';

  return (
    <>
      {/* Session Mode — REQ-ENTERPRISE-008 AC3: the Standard/Pro selector is SaaS-tier
          framing (in enterprise every user is implicitly Pro/advanced, and onboarding /
          default deployments have no Standard/Pro plans), so it renders only in SaaS
          mode. No-op when saasMode is unset/absent (treated as not SaaS). */}
      <Show when={props.saasMode?.()}>
      <section class="settings-section">
        <div class="settings-section-header">
          <h3 class="settings-section-title type-section-header">Session Mode</h3>
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
            Standard
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
            Pro
          </label>
        </div>
        <div class="setting-row setting-row--column-gap">
          <span class="settings-hint type-hint" data-testid="session-mode-hint">
            Controls which AI skills and rules are preseeded. Skills update automatically when you switch modes.
          </span>
        </div>
      </section>
      </Show>

      <Show when={props.enterpriseMode?.() || props.currentSessionMode() === 'advanced'}>
        <section class="settings-section">
          <div class="settings-section-header">
            <Icon path={mdiFileTree} size={16} aria-hidden="true" data-testid="default-workspace-icon" />
            <h3 class="settings-section-title type-section-header">Default workspace</h3>
          </div>
          <div
            class="session-mode-control"
            role="radiogroup"
            aria-label="Default workspace"
            data-testid="default-workspace-control"
          >
            <label class={`session-mode-option ${props.defaultWorkspace() === 'terminal' ? 'session-mode-option--selected' : ''}`}>
              <input
                type="radio"
                name="default-workspace"
                value="terminal"
                checked={props.defaultWorkspace() === 'terminal'}
                onChange={() => props.onDefaultWorkspaceChange('terminal')}
                role="radio"
                aria-checked={props.defaultWorkspace() === 'terminal'}
                data-testid="default-workspace-terminal"
              />
              Terminal
            </label>
            <label class={`session-mode-option ${props.defaultWorkspace() === 'vscode' ? 'session-mode-option--selected' : ''}`}>
              <input
                type="radio"
                name="default-workspace"
                value="vscode"
                checked={props.defaultWorkspace() === 'vscode'}
                onChange={() => props.onDefaultWorkspaceChange('vscode')}
                role="radio"
                aria-checked={props.defaultWorkspace() === 'vscode'}
                data-testid="default-workspace-vscode"
              />
              VS Code
            </label>
          </div>
          <div class="setting-row setting-row--column-gap">
            <span class="settings-hint type-hint" data-testid="default-workspace-hint">
              Applies to new sessions. Existing sessions keep their current workspace.
            </span>
          </div>
        </section>
      </Show>

      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiConsoleLine} size={16} aria-hidden="true" data-testid="settings-herdr-icon" />
          <h3 class="settings-section-title type-section-header">Terminal Experience</h3>
        </div>
        <div class="setting-row setting-row--clickable" onClick={(event) => {
          if (!(event.target as HTMLElement).closest('.toggle')) props.onHerdrToggle();
        }}>
          <label class="type-label settings-label-with-badge" for="settings-herdr">
            Use Herdr terminal
            <span class="settings-beta-badge" data-testid="settings-herdr-beta">beta</span>
          </label>
          <button
            type="button"
            id="settings-herdr"
            class={`toggle ${props.herdrEnabled() ? 'toggle-on' : ''}`}
            onClick={props.onHerdrToggle}
            role="switch"
            aria-checked={props.herdrEnabled()}
            data-testid="settings-herdr-toggle"
          >
            <span class="toggle-thumb" />
          </button>
        </div>
        <div class="setting-row setting-row--column-gap">
          <span class="settings-hint type-hint" data-testid="settings-herdr-hint">
            Use Herdr for terminal workspaces, splits, panes, and built-in agent status. Leave off to use Codeflare’s standard terminal tabs and tiling. Applies to new sessions.
          </span>
        </div>
      </section>

      {/* Agent Startup / Fast Start */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiFastForward} size={16} />
          <h3 class="settings-section-title type-section-header">Agent Startup</h3>
        </div>
        <div class="setting-row setting-row--clickable" onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.toggle')) props.onFastStartToggle();
        }}>
          <label class="type-label" for="settings-fast-start">Fast Start</label>
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
          <span class="settings-hint type-hint" data-testid="settings-fast-start-hint">
            Launch pre-installed CLI versions for instant startup. Turn off to allow tools to auto-update on launch (slower startup, latest features).
          </span>
        </div>
      </section>

      {/* Native agent notifications */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiBellOutline} size={16} />
          <h3 class="settings-section-title type-section-header">Agent Notifications</h3>
        </div>
        <div class="setting-row">
          <label class="type-label" for="settings-agent-notifications">Notify this device</label>
          <button
            type="button"
            id="settings-agent-notifications"
            class={`toggle ${notificationEnabled() ? 'toggle-on' : ''}`}
            onClick={props.onEnableAgentNotifications}
            role="switch"
            aria-checked={notificationEnabled()}
            data-testid="settings-agent-notifications"
          >
            <span class="toggle-thumb" />
          </button>
        </div>
        <div class="setting-row setting-row--column-gap">
          <span
            class="settings-hint type-hint"
            data-testid="settings-agent-notifications-status"
            data-guidance={props.notificationPermission() === 'unavailable'
              && needsHomeScreenInstallForNotifications() ? 'ios-install' : undefined}
          >
            {notificationEnabled()
              ? 'Enabled for this device'
              : props.notificationPermission() === 'denied'
                ? 'Blocked in browser site settings'
                : props.notificationPermission() === 'unavailable'
                  ? (needsHomeScreenInstallForNotifications()
                    ? 'On iOS, add Codeflare to your Home Screen (Share → Add to Home Screen), then enable notifications here.'
                    : 'Unavailable in this browser')
                  : 'Notify when Pi or Claude is ready for input in terminal tab 1.'}
          </span>
        </div>
      </section>

      {/* R2 Sync */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiCloudSyncOutline} size={16} />
          <h3 class="settings-section-title type-section-header">R2 Sync</h3>
        </div>
        <div class="setting-row setting-row--clickable" onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.toggle')) props.onWorkspaceSyncToggle();
        }}>
          <label class="type-label" for="settings-workspace-sync">Sync Workspace Folder</label>
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
          <span class="settings-hint type-hint" data-testid="settings-workspace-sync-hint">
            Workspace sync increases startup time. Prefer cloning repositories fresh inside each session.
            Restart the session after changing this switch for it to take effect.
          </span>
        </div>
        <div class="settings-admin-actions">
          <AdminActionButton
            tone="--color-action-docs"
            icon={mdiFileDocumentRefreshOutline}
            label={props.recreateDocsLoading() ? 'Recreating...' : 'Recreate Docs & Examples'}
            disabled={props.recreateDocsLoading()}
            onClick={props.onRecreateDocs}
            testId="settings-recreate-docs-label"
          />
          <Show when={props.recreateDocsMessage()}>
            {(message) => (
              <span class="settings-hint type-hint" data-testid="settings-recreate-docs-success">{message()}</span>
            )}
          </Show>
          <Show when={props.recreateDocsError()}>
            {(error) => (
              <span class="settings-error" data-testid="settings-recreate-docs-error">{error()}</span>
            )}
          </Show>
          <AdminActionButton
            tone="--color-action-agents"
            icon={mdiRobotOutline}
            label={props.recreateAgentLoading() ? 'Recreating...' : 'Recreate Agent Skills & Rules'}
            disabled={props.recreateAgentLoading()}
            onClick={props.onRecreateAgentConfigs}
            testId="settings-recreate-agent-label"
          />
          <Show when={props.recreateAgentMessage()}>
            {(message) => (
              <span class="settings-hint type-hint" data-testid="settings-recreate-agent-success">{message()}</span>
            )}
          </Show>
          <Show when={props.recreateAgentError()}>
            {(error) => (
              <span class="settings-error" data-testid="settings-recreate-agent-error">{error()}</span>
            )}
          </Show>
        </div>
      </section>

      {/* Auto-sleep */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiTimerSandComplete} size={16} />
          <h3 class="settings-section-title type-section-header">Auto-sleep</h3>
        </div>
        <div class="setting-row">
          <label class="type-label" for="settings-sleep-after">Sleep after inactivity</label>
          <select
            id="settings-sleep-after"
            class="settings-select"
            value={props.sleepAfter()}
            disabled={!props.canChangeSleepAfter()}
            onChange={(e) => props.onSleepAfterChange(e.currentTarget.value)}
            data-testid="settings-sleep-after-select"
          >
            <option value="15m">15 minutes</option>
            <option value="30m">30 minutes</option>
            <option value="1h">1 hour</option>
            <option value="2h">2 hours</option>
            <option value="4h">4 hours</option>
          </select>
        </div>
        <div class="setting-row setting-row--column-gap">
          <span class="settings-hint type-hint" data-testid="settings-sleep-after-hint">
            {props.canChangeSleepAfter()
              ? 'Container stops after this idle duration. Takes effect for new sessions, started several minutes after changing the duration.'
              : props.isFreeUser()
                ? 'Fixed at 15 minutes on the Free plan. Upgrade for longer idle timeouts.'
                : 'Auto-sleep is managed by your administrator.'}
          </span>
        </div>
      </section>

      {/* Clipboard -- desktop only */}
      <Show when={!isTouchDevice()}>
        <section class="settings-section">
          <div class="settings-section-header">
            <Icon path={mdiContentPaste} size={16} />
            <h3 class="settings-section-title type-section-header">Clipboard</h3>
          </div>
          <div class="setting-row setting-row--clickable" onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.toggle')) props.updateSetting('clipboardAccess', !props.clipboardAccess());
          }}>
            <label class="type-label" for="settings-clipboard-access">Allow paste from clipboard</label>
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
            <span class="settings-hint type-hint">
              Allow right-click paste from clipboard. Works best in Chrome; unreliable in other browsers. When enabled, your browser may prompt for clipboard permission.
            </span>
          </div>
        </section>
      </Show>
    </>
  );
};

export default SessionSection;
