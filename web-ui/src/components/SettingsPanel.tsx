import { Component, createSignal, createEffect, on, Show, onMount, JSX } from 'solid-js';
import {
  mdiClose,
  mdiCogOutline,
  mdiChevronDown,
  mdiWrenchOutline,
  mdiAccountGroupOutline,
} from '@mdi/js';
import Icon from './Icon';
import { loadSettings, saveSettings, defaultSettings } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { sessionStore } from '../stores/session';
import { recreateGettingStartedDocs, recreateAgentConfigs } from '../api/storage';
import { getUser } from '../api/client';
import type { AccessTier, SubscriptionTier } from '../types';
import AppearanceSection from './settings/AppearanceSection';
import SessionSection from './settings/SessionSection';
import DeployKeysSection from './settings/DeployKeysSection';
import LlmKeysSection from './settings/LlmKeysSection';
// SubscriptionManagement moved to standalone admin page at /admin/subscriptions
import '../styles/settings-panel.css';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserEmail?: string;
  currentUserRole?: 'admin' | 'user';
  currentUserAccessTier?: import('../types').AccessTier;
}

type AccordionGroup = 'appearance' | 'session' | 'deploy' | 'llm' | 'admin';

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

const ACCORDION_SUBTITLES: Record<AccordionGroup, string> = {
  appearance: 'Colors, tips & display preferences',
  session: 'Startup behavior & workspace sync',
  deploy: 'Connect GitHub & Cloudflare for one-click deploy',
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
  const [openGroup, setOpenGroup] = createSignal<AccordionGroup>('appearance');

  // Live tier — refreshed from API each time panel opens so tier
  // upgrades take effect without a full page reload.
  const [liveAccessTier, setLiveAccessTier] = createSignal<AccessTier | SubscriptionTier | undefined>(props.currentUserAccessTier);

  // Reset accordion to Appearance when panel is closed then reopened (false → true)
  createEffect(on(
    () => props.isOpen,
    (isOpen, prevIsOpen) => {
      if (isOpen && !prevIsOpen) {
        setOpenGroup('appearance');
        // Re-fetch tier on panel open
        getUser().then((user) => {
          const tier = user.subscriptionTier ?? user.accessTier;
          if (tier) setLiveAccessTier(tier);
          setUserHasSubscribed(user.hasSubscribed === true);
          setLiveSubscribedMode(user.subscribedMode ?? 'default');
        }).catch(() => {});
      }
    }
  ));

  const handleAccordionClick = (group: AccordionGroup) => {
    if (openGroup() !== group) setOpenGroup(group);
  };

  const isAdmin = () => props.currentUserRole === 'admin';
  // Initialize from local preference until async getUser() returns the server-side subscribedMode
  const [liveSubscribedMode, setLiveSubscribedMode] = createSignal<'default' | 'advanced'>(
    (sessionStore.preferences.sessionMode as 'default' | 'advanced') ?? 'default'
  );
  const canUseAdvanced = () => {
    // Admin always has access
    if (isAdmin()) return true;
    // User must have subscribed to Pro via subscribe page (stored in user record).
    // subscribedMode is the source of truth from Stripe — if they paid for Pro,
    // they can use it regardless of which tier (standard, advanced, max, unlimited).
    return liveSubscribedMode() === 'advanced';
  };
  const workspaceSyncEnabled = () => sessionStore.preferences.workspaceSyncEnabled === true;
  const fastStartEnabled = () => sessionStore.preferences.fastStartEnabled !== false;
  const currentSessionMode = () => sessionStore.preferences.sessionMode ?? 'default';
  const isFreeUser = () => {
    const tier = liveAccessTier();
    return tier === 'free';
  };
  const sleepAfter = () => isFreeUser() ? '5m' : (sessionStore.preferences.sleepAfter ?? '30m');
  const [userHasSubscribed, setUserHasSubscribed] = createSignal(false);
  const canChangeSleepAfter = () => (isAdmin() || userHasSubscribed()) && !isFreeUser();

  const showButtonLabels = () => settings().showButtonLabels !== false;
  const showTips = () => settings().showTips !== false;
  const samsungAddressBarTop = () => settings().samsungAddressBarTop !== false;
  const clipboardAccess = () => settings().clipboardAccess === true;

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

  const handleFastStartToggle = () => {
    void sessionStore.updatePreferences({ fastStartEnabled: !fastStartEnabled() });
  };

  // Implements REQ-AGENT-005
  const handleSessionModeChange = async (mode: 'default' | 'advanced') => {
    if (mode === currentSessionMode()) return;
    try {
      await sessionStore.updatePreferences({ sessionMode: mode });
      // Show feedback — auto-reconcile runs server-side as part of the PATCH
      if (currentSessionMode() === mode) {
        setRecreateAgentMessage(`Agent skills updated for ${mode === 'advanced' ? 'Pro' : 'Standard'} mode. Takes effect in new sessions.`);
      }
    } catch {
      // updatePreferences handles its own errors
    }
  };

  const handleSleepAfterChange = (value: string) => {
    if (value === sleepAfter()) return;
    void sessionStore.updatePreferences({ sleepAfter: value as import('../types').SleepAfterOption });
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
            <AppearanceSection
              accentHexInput={accentHexInput}
              setAccentHexInput={setAccentHexInput}
              showTips={showTips}
              showButtonLabels={showButtonLabels}
              samsungAddressBarTop={samsungAddressBarTop}
              updateSetting={updateSetting}
            />
          </AccordionSection>

          {/* ── Session Defaults ── */}
          <AccordionSection
            group="session"
            title="Session Defaults"
            subtitle={ACCORDION_SUBTITLES.session}
            isOpen={openGroup() === 'session'}
            onToggle={() => handleAccordionClick('session')}
          >
            <SessionSection
              currentSessionMode={currentSessionMode}
              canUseAdvanced={canUseAdvanced}
              fastStartEnabled={fastStartEnabled}
              workspaceSyncEnabled={workspaceSyncEnabled}
              clipboardAccess={clipboardAccess}
              sleepAfter={sleepAfter}
              canChangeSleepAfter={canChangeSleepAfter}
              isFreeUser={isFreeUser}
              recreateDocsLoading={recreateDocsLoading}
              recreateDocsMessage={recreateDocsMessage}
              recreateDocsError={recreateDocsError}
              recreateAgentLoading={recreateAgentLoading}
              recreateAgentMessage={recreateAgentMessage}
              recreateAgentError={recreateAgentError}
              onSessionModeChange={handleSessionModeChange}
              onFastStartToggle={handleFastStartToggle}
              onWorkspaceSyncToggle={handleWorkspaceSyncToggle}
              onSleepAfterChange={handleSleepAfterChange}
              onRecreateDocs={() => { void handleRecreateDocs(); }}
              onRecreateAgentConfigs={() => { void handleRecreateAgentConfigs(); }}
              updateSetting={updateSetting}
            />
          </AccordionSection>

          {/* ── Push & Deploy ── */}
          <AccordionSection
            group="deploy"
            title="Push & Deploy"
            subtitle={ACCORDION_SUBTITLES.deploy}
            isOpen={openGroup() === 'deploy'}
            onToggle={() => handleAccordionClick('deploy')}
          >
            <DeployKeysSection />
          </AccordionSection>

          {/* ── LLM API Keys (advanced session mode only) ── */}
          <Show when={canUseAdvanced() && currentSessionMode() === 'advanced'}>
            <AccordionSection
              group="llm"
              title="LLM API Keys"
              subtitle={ACCORDION_SUBTITLES.llm}
              isOpen={openGroup() === 'llm'}
              onToggle={() => handleAccordionClick('llm')}
            >
              <LlmKeysSection />
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
                  <h3 class="settings-section-title">Setup & Users</h3>
                </div>
                <p class="settings-hint" style={{ "margin-bottom": "var(--space-2)" }}>
                  Configure custom domain and admin users in the Setup Wizard.
                  Manage user roles and access tiers in User Management.
                </p>
                <div class="settings-admin-actions">
                  <button
                    type="button"
                    class="provider-row-connect-btn"
                    style={{ background: '#2563eb' }}
                    onClick={() => { window.location.href = '/setup'; }}
                  >
                    <Icon path={mdiWrenchOutline} size={24} style={{ color: 'white' }} />
                    <span>Setup Wizard</span>
                  </button>
                  <button
                    type="button"
                    class="provider-row-connect-btn"
                    style={{ background: '#7c3aed' }}
                    onClick={() => { window.location.href = '/admin/users'; }}
                  >
                    <Icon path={mdiAccountGroupOutline} size={24} style={{ color: 'white' }} />
                    <span>Manage Users</span>
                  </button>
                </div>
                <span class="settings-hint" data-testid="settings-r2-warning">
                  If you rotate your Cloudflare API token, redeploy with the new token and re-run the Setup Wizard.
                </span>
              </section>
              <section class="settings-section">
                <div class="settings-section-header">
                  <Icon path={mdiCogOutline} size={16} />
                  <h3 class="settings-section-title">Subscription Tiers</h3>
                </div>
                <p class="settings-hint" style={{ "margin-bottom": "var(--space-2)" }}>
                  Configure monthly hours, pricing, trial periods, and session modes for each tier.
                </p>
                <div class="settings-admin-actions">
                  <button
                    type="button"
                    class="provider-row-connect-btn"
                    style={{ background: '#059669' }}
                    onClick={() => { window.location.href = '/admin/subscriptions'; }}
                  >
                    <Icon path={mdiCogOutline} size={24} style={{ color: 'white' }} />
                    <span>Manage Subscriptions</span>
                  </button>
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
