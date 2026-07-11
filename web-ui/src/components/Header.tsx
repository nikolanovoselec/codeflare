import { Component, Show, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import {
  mdiCogOutline,
  mdiShieldAccount,
  mdiAccountOutline,
  mdiRocketLaunchOutline,
  mdiChartBar,
  mdiLogout,
  mdiViewDashboardOutline,
  mdiFileCabinet,
  mdiMicrosoftVisualStudioCode,
  mdiOpenInNew,
  mdiClockTimeEightOutline,
} from '@mdi/js';
import Icon from './Icon';
import SessionSwitcher from './SessionSwitcher';
import VaultButton, { type VaultButtonStatus } from './VaultButton';
import { sessionStore } from '../stores/session';
import { getSleepTimerInfo } from '../lib/sleep-timer';
import UsageInlineBadge from './UsageInlineBadge';

import { terminalStore } from '../stores/terminal';
import { getGravatarUrl, gravatarExists } from '../lib/gravatar';
import { isTouchDevice, getKeyboardHeight } from '../lib/mobile';
import type { SessionWithStatus, AgentType, TabConfig } from '../types';
import '../styles/header.css';

interface HeaderProps {
  userName?: string;
  onSettingsClick?: () => void;
  onStoragePanelToggle?: () => void;
  onVaultOpen?: () => void;
  vaultReady?: boolean;
  vaultStatus?: VaultButtonStatus;
  onVscodeOpen?: () => void;
  onLogoClick?: () => void;
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => void;
  onOpenMultiView?: () => void;
  onCloseMultiView?: () => void;
  // Note: logout goes through /auth/logout which routes to OIDC or CF Access as appropriate
}

/**
 * Header component - top bar with logo, session switcher and user menu
 *
 * Layout:
 * +-----------------------------------------------------------------------------------+
 * | [</>] [Session Switcher]          [Avatar] [Vault] [Storage] [Settings] [Dashboard] |
 * +-----------------------------------------------------------------------------------+
 */
const Header: Component<HeaderProps> = (props) => {
  const [showUserMenu, setShowUserMenu] = createSignal(false);
  const [gravatarOk, setGravatarOk] = createSignal(false);
  // Probe Gravatar existence once via fetch (no <img onError> console noise).
  createEffect(() => {
    const email = props.userName;
    if (!email) { setGravatarOk(false); return; }
    gravatarExists(email, 48).then(setGravatarOk);
  });
  const [showTimerDropdown, setShowTimerDropdown] = createSignal(false);
  let userMenuRef: HTMLDivElement | undefined;
  let timerMenuRef: HTMLDivElement | undefined;

  const activeSession = createMemo(() =>
    props.sessions.find(s => s.id === props.activeSessionId)
  );
  // Tick signal forces timer recomputation every 15s (Date.now() isn't reactive)
  const [timerTick, setTimerTick] = createSignal(0);
  const timerInterval = setInterval(() => setTimerTick(t => t + 1), 15_000);
  onCleanup(() => clearInterval(timerInterval));

  const timerInfo = createMemo(() => {
    timerTick(); // subscribe to tick for periodic recomputation
    const session = activeSession();
    if (!session || session.status !== 'running') return null;
    return getSleepTimerInfo(session.lastActiveAt, sessionStore.preferences.sleepAfter);
  });
  const handleClickOutside = (e: MouseEvent) => {
    if (showUserMenu() && userMenuRef && !userMenuRef.contains(e.target as Node)) {
      setShowUserMenu(false);
    }
    if (showTimerDropdown() && timerMenuRef && !timerMenuRef.contains(e.target as Node)) {
      setShowTimerDropdown(false);
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
  });

  return (
    <header class="header animate-fadeInUp">
      {/* Logo */}
      <div
        class={`header-logo ${props.onLogoClick ? 'header-logo--clickable' : ''}`}
        data-testid="header-logo"
        onClick={() => props.onLogoClick?.()}
        role={props.onLogoClick ? 'button' : undefined}
      >
        <Icon path={mdiViewDashboardOutline} size={22} class="header-logo-icon" />
      </div>

      {/* Session Switcher */}
      <SessionSwitcher
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        onSelectSession={props.onSelectSession}
        onStopSession={props.onStopSession}
        onDeleteSession={props.onDeleteSession}
        onCreateSession={props.onCreateSession}
        onOpenMultiView={props.onOpenMultiView}
        onCloseMultiView={props.onCloseMultiView}
      />

      {/* Spacer for flex layout */}
      <div class="header-spacer" />

      {/* Right side - User menu, settings, and dashboard */}
      <div class="header-actions">
        {/* Auth URL button (shown when auth URL detected in terminal) */}
        <Show when={!isTouchDevice() && terminalStore.authUrl}>
          <button
            type="button"
            class="header-auth-url-btn header-auth-url-bounce-in"
            onClick={() => {
              const url = terminalStore.authUrl;
              if (url) window.open(url, '_blank', 'noopener');
            }}
            title="Open auth URL"
          >
            <Icon path={mdiOpenInNew} size={16} />
            <span>Open URL</span>
          </button>
        </Show>

        {/* The avatar/username stays visible in every mode. In enterprise the
            dropdown has no entries (Subscription/Usage SaaS-only, Guided
            Setup/Logout hidden under SSO), so the avatar's click is inert —
            it opens nothing rather than an empty dropdown. */}
        <div class="header-user-wrapper" ref={userMenuRef}>
          <button
            type="button"
            class="header-user-menu"
            data-testid="header-user-menu"
            title="User menu"
            onClick={() => { if (!sessionStore.enterpriseMode) setShowUserMenu(!showUserMenu()); }}
          >
            <Show when={props.userName && gravatarOk()} fallback={<Icon path={mdiShieldAccount} size={24} class="header-user-avatar" />}>
              <img
                src={getGravatarUrl(props.userName!, 48)}
                alt="Avatar"
                class="header-user-avatar-img"
                width={24} height={24}
              />
            </Show>
            <Show when={props.userName}>
              <span class="header-user-name">{props.userName}</span>
            </Show>
          </button>
          {/* Profile and Guided Setup use plain <a> tags — SolidJS Router's
              top-level DOM listener intercepts clicks for client-side navigation.
              No onClick handlers = no touch event race conditions on mobile. */}
          <Show when={showUserMenu()}>
            <div class="header-user-dropdown" data-testid="header-user-dropdown">
              <Show when={sessionStore.saasMode}>
                <a
                  href="/app/subscribe"
                  class="header-user-dropdown-item"
                  data-testid="header-user-dropdown-profile"
                >
                  <Icon path={mdiAccountOutline} size={16} />
                  <span>Subscription</span>
                </a>
              </Show>
              {/* Usage is SaaS-only — the enterprise usage view is disabled for
                  now (it always reports 0; fix deferred). */}
              <Show when={sessionStore.saasMode}>
                <a
                  href="/app/usage"
                  class="header-user-dropdown-item"
                  data-testid="header-user-dropdown-usage"
                >
                  <Icon path={mdiChartBar} size={16} />
                  <span>Usage</span>
                  <UsageInlineBadge />
                </a>
              </Show>
              {/* Guided Setup + Logout are not per-item enterprise-gated: the
                  dropdown only opens outside enterprise (the avatar's onClick is
                  inert in enterprise, REQ-ENTERPRISE-008 AC8/AC9), so reaching here
                  already implies non-enterprise. */}
              <a
                href="/app/onboarding"
                class="header-user-dropdown-item"
                data-testid="header-user-dropdown-onboarding"
              >
                <Icon path={mdiRocketLaunchOutline} size={16} />
                <span>Guided Setup</span>
              </a>
              <button
                type="button"
                class="header-user-dropdown-item header-user-dropdown-item--danger"
                data-testid="header-user-dropdown-logout"
                onClick={() => { window.location.href = '/auth/logout'; }}
              >
                <Icon path={mdiLogout} size={16} />
                <span>Logout</span>
              </button>
            </div>
          </Show>
        </div>

        {/* Sleep timer dropdown */}
        <Show when={timerInfo()}>
          {(info) => (
            <div class="header-timer-wrapper" ref={timerMenuRef}>
              <button
                type="button"
                class={`header-timer-button header-timer-button--${info().severity}`}
                data-testid="header-timer-button"
                title={info().bucket}
                onClick={() => setShowTimerDropdown(!showTimerDropdown())}
              >
                <Icon path={mdiClockTimeEightOutline} size={20} />
              </button>
              <Show when={showTimerDropdown()}>
                <div class="header-timer-dropdown" data-testid="header-timer-dropdown">
                  <div class="header-timer-bucket">{info().bucket}</div>
                  <p class="header-timer-explanation">
                    When this timer expires, your session will stop. Tracks time since last terminal input and the session idle timeout. Configurable in settings.
                  </p>
                </div>
              </Show>
            </div>
          )}
        </Show>

        {/* Vault button — opens the persistent SilverBullet vault in a new tab.
            Rendered only when the parent passes onVaultOpen (terminal-view +
            active advanced session present). The button remains disabled until
            browser-side prewarm has completed the real SilverBullet boot and
            object-index readiness, not just server reachability. */}
        <Show when={props.onVaultOpen}>
          {(onOpen) => (
            <VaultButton
              status={props.vaultStatus ?? (props.vaultReady ? 'ready' : 'prewarming')}
              onOpen={onOpen()}
            />
          )}
        </Show>

        {/* Browser IDE button — opens the per-session OpenVSCode editor in a new
            tab. Rendered only when the parent passes onVscodeOpen (terminal-view
            + active advanced running session), mirroring the vault gating. Each
            session's editor is isolated (REQ-IDE-001, REQ-IDE-002); no client-side
            readiness gate is needed — the host lazily starts the server and
            returns a warming state until it is up. */}
        <Show when={props.onVscodeOpen}>
          {(onOpen) => (
            <button
              class="header-vscode-button"
              data-testid="header-vscode-button"
              title="Open editor (VS Code)"
              type="button"
              onClick={onOpen()}
            >
              <Icon path={mdiMicrosoftVisualStudioCode} size={20} />
            </button>
          )}
        </Show>

        {/* Storage button */}
        <button
          class="header-storage-button"
          data-testid="header-storage-button"
          title="Storage"
          type="button"
          onClick={() => props.onStoragePanelToggle?.()}
        >
          <Icon path={mdiFileCabinet} size={20} />
        </button>

        {/* Settings button */}
        <button
          class="header-settings-button"
          data-testid="header-settings-button"
          title="Settings"
          type="button"
          onClick={() => props.onSettingsClick?.()}
        >
          <Icon path={mdiCogOutline} size={20} class="settings-rotate" />
        </button>
      </div>
    </header>
  );
};

export default Header;
