import { Component, Show, For, onMount, onCleanup, createSignal, createMemo, createEffect } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiXml, mdiCogOutline, mdiShieldAccount, mdiAccountOutline, mdiRocketLaunchOutline, mdiChartBar, mdiLogout, mdiFlipVertical } from '@mdi/js';
import Icon from './Icon';
import IconButton from './ui/IconButton';
import type { SessionWithStatus, AgentType, TabConfig } from '../types';
import { storageStore } from '../stores/storage';
import { getDownloadUrl } from '../api/storage';
import { getGravatarUrl, gravatarExists } from '../lib/gravatar';
import SessionStatCard from './SessionStatCard';
import SessionContextMenu from './SessionContextMenu';
import StatCards from './StatCards';
import StorageBrowser from './StorageBrowser';
import GitHubPanel from './github/GitHubPanel';
import FilePreview from './FilePreview';
import CreateSessionDialog from './CreateSessionDialog';
import SessionLimitPopup from './SessionLimitPopup';
import ScrambleText from './ScrambleText';
import KittScanner from './KittScanner';
import DashboardCard from './TipsRotator';
import { sessionStore, isAtUsageQuota } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { createTerminalViewportClass } from '../lib/mobile';
import { decidePanelLayoutMode } from '../lib/panel-allocation';
import { githubStore } from '../stores/github';
import { getBrowserTimezone, syncBrowserTimezone } from '../lib/timezone-sync';
import { MULTIVIEW_ICON } from '../lib/terminal-config';
import UsageInlineBadge from './UsageInlineBadge';
import '../styles/dashboard.css';

interface DashboardProps {
  sessions: SessionWithStatus[];
  onCreateSession: (agentType?: AgentType, tabConfig?: TabConfig[]) => void;
  onStartSession: (id: string) => void;
  onOpenSessionById: (id: string) => void;
  onOpenMultiView?: () => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  viewState: 'dashboard' | 'expanding' | 'collapsing';
  userName?: string;
  onSettingsClick?: () => void;
  enterpriseMode?: boolean;
}

const Dashboard: Component<DashboardProps> = (props) => {
  const [collapseReady, setCollapseReady] = createSignal(false);
  const viewport = createTerminalViewportClass();
  const multiViewWorkspace = createMemo(() => terminalWorkspaceStore.reconcileMultiView(props.sessions, viewport()));
  // Mobile-only: which single right-column face is visible (GitHub vs R2 storage).
  // GitHub leads — whenever it is enabled it is the DEFAULT face (the Connect card
  // until connected, the repo browser once connected), with a flip control to reach
  // the storage browser; only when GitHub is disabled is storage the sole face. Keyed
  // off `githubStore.enabled` alone — there is no session-tier gate. On tablet/desktop
  // both faces stack as a split (more vertical room) and the flip controls are hidden
  // by CSS, so there is nothing to flip. (REQ-GITHUB-007/010)
  const [panelFace, setPanelFace] = createSignal<'github' | 'storage'>('github');
  const effectiveFace = () => (githubStore.enabled ? panelFace() : 'storage');
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [showLimitPopup, setShowLimitPopup] = createSignal(false);
  const [showUserMenu, setShowUserMenu] = createSignal(false);
  const [gravatarOk, setGravatarOk] = createSignal(false);
  // Probe Gravatar existence once via fetch (no <img onError> console noise).
  createEffect(() => {
    const email = props.userName;
    if (!email) { setGravatarOk(false); return; }
    gravatarExists(email, 48).then(setGravatarOk);
  });
  const [userMenuPos, setUserMenuPos] = createSignal<{ top: number; right: number }>({ top: 0, right: 0 });
  let userBtnRef: HTMLButtonElement | undefined;
  const [newSessionBtnRef, setNewSessionBtnRef] = createSignal<HTMLButtonElement>();
  const [menuState, setMenuState] = createSignal<{ isOpen: boolean; position: { x: number; y: number }; session: SessionWithStatus | null }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    session: null,
  });

  // ── Adaptive right-column split (bug #21) ──────────────────────────────
  // GitHub (top) + Storage (bottom) share the column. The flex engine does the
  // pixel allocation: both faces are `flex: 1 1 0` with a measured max-height of
  // their natural content, and `justify-content: space-between` drops any slack in
  // the middle. Here we only choose split-vs-flip and feed the measured heights.
  let rightColRef: HTMLDivElement | undefined;
  let githubFaceRef: HTMLDivElement | undefined;
  let storageFaceRef: HTMLDivElement | undefined;
  const [layoutMode, setLayoutMode] = createSignal<'split' | 'flip' | null>(null);
  const [githubMaxH, setGithubMaxH] = createSignal<number | null>(null);
  const [storageMaxH, setStorageMaxH] = createSignal<number | null>(null);

  // Measure a face's TRUE natural height — what it wants with all its content shown
  // and nothing constraining it — as a fixed point that never depends on the column
  // height, the sibling face, or any max-height we previously wrote (so re-measures
  // are idempotent and the split is loop-free). First neutralize our own sizing: drop
  // max-height AND flex so the face hugs its content. Then:
  //  - WITH an inner scroller (the repo / file list): under `flex: 0 0 auto` the
  //    overflow:auto scroller lays out collapsed (~0px), so its laid-out box is NOT
  //    its content — we must add the list's FULL content via `scrollHeight` (which is
  //    the content height regardless of the scroller's box, hence invariant under our
  //    writes) to the surrounding chrome (header/search = face box minus scroller box).
  //    Measuring only the collapsed box is exactly what made a 20-repo panel report a
  //    ~2-repo height and clip the rest. This relies on the list rows being
  //    intrinsically sized (the fixed-height repo / file rows): a descendant sized as a
  //    vertical percentage / `flex-grow` / `cqh` would collapse with the scroller and
  //    undercount again.
  //  - NO scroller (connect / loading / error / empty face): the content-hugging face
  //    box IS the natural height.
  const measureNatural = (face: HTMLElement | undefined, scrollSel: string): number | null => {
    if (!face) return null;
    const prevMaxH = face.style.maxHeight;
    const prevFlex = face.style.flex;
    face.style.maxHeight = 'none';
    face.style.flex = '0 0 auto';
    const scroller = face.querySelector<HTMLElement>(scrollSel);
    const natural = scroller
      ? Math.max(0, face.getBoundingClientRect().height - scroller.getBoundingClientRect().height) + scroller.scrollHeight
      : face.getBoundingClientRect().height;
    face.style.flex = prevFlex;
    face.style.maxHeight = prevMaxH;
    return Math.ceil(natural);
  };

  const measureLayout = () => {
    const right = rightColRef;
    if (!right) return;
    // width = VIEWPORT (mobile breakpoint, matches the CSS flip); height = the
    // column's own box (too-short check). Never the column's measured WIDTH — the
    // layout caps that small, so it would wrongly flip every tablet/laptop.
    const mode = decidePanelLayoutMode({ width: window.innerWidth, height: right.clientHeight });
    setLayoutMode(mode);
    // Measured caps only make sense for the TWO-panel split. In flip mode, or when
    // GitHub is disabled (Storage is the sole face — the GitHub face is not rendered),
    // there is no second panel to balance — clear the caps so the single face just
    // fills the column instead of capping to its content and leaving empty space.
    if (mode === 'flip' || !githubStore.enabled) {
      setGithubMaxH(null);
      setStorageMaxH(null);
      return;
    }
    const gh = measureNatural(githubFaceRef, '.github-repo-rows');
    const st = measureNatural(storageFaceRef, '.storage-drop-zone');
    // Idempotent write: a redundant trigger that re-measures the same value is a no-op.
    setGithubMaxH((p) => (p === gh ? p : gh));
    setStorageMaxH((p) => (p === st ? p : st));
  };

  onMount(() => {
    const right = rightColRef;
    if (!right) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureLayout); };
    // Re-measure on the two things that change the split. This is loop-free because
    // measureLayout's measurement is a FIXED POINT (measureNatural reads the natural
    // height with our own max-height removed), so a redundant re-measure returns the
    // same value and the idempotent setters make it a no-op. (The #568 flicker came
    // from measuring the face height WHILE our max-height was applied, so each measure
    // perturbed the next — not from which element was observed.) The observers are also
    // chosen so they cannot even see our writes:
    //  - the column BOX resizing (viewport / orientation / header / banner reflow). The
    //    column is `flex: 1; overflow: hidden`, sized by the OUTER layout, so the
    //    max-height we set on its face CHILDREN can never change the column's own box.
    //  - rows ADDED/REMOVED inside either panel (GitHub connect↔list↔load-more state,
    //    storage show-hidden toggle, folder navigation, R2 readiness). childList only:
    //    the max-height we set is a style ATTRIBUTE, which a childList observer ignores.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(right);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    mo?.observe(right, { childList: true, subtree: true });
    schedule(); // initial measure
    onCleanup(() => { ro?.disconnect(); mo?.disconnect(); cancelAnimationFrame(raf); });
  });

  onMount(() => {
    sessionStore.startR2Polling();
    storageStore.fetchStats();

    // Load GitHub status here, OUTSIDE the GitHub panel. The right-column GitHub
    // face only renders when `githubStore.enabled`, and `enabled` is set by
    // loadStatus() — if that call lived only in GitHubPanel.onMount it would never
    // run while the panel is unmounted, so an enabled instance would never reveal
    // its panel (the connect card included). Kicking it off from the always-mounted
    // Dashboard breaks that deadlock. Best-effort; never blocks. (REQ-GITHUB-007)
    void githubStore.loadStatus?.();

    // REQ-MEM-001 AC4: capture the browser's IANA timezone and sync it
    // to the user's preferences so the next session start propagates
    // USER_TIMEZONE into the container env. Best-effort; never blocks.
    if (typeof sessionStore.updatePreferences === 'function') {
      void syncBrowserTimezone({
        currentTimezone: sessionStore.preferences?.userTimezone,
        browserTimezone: getBrowserTimezone(),
        updatePreferences: sessionStore.updatePreferences,
      });
    }

    // User menu close is handled by the Portal overlay onClick — no document
    // mousedown listener needed. Document mousedown fires before click on mobile,
    // racing with button onClick and swallowing navigation events.
  });

  // Double requestAnimationFrame to ensure the browser has painted with --expanded
  // before removing the class, so the CSS transition actually fires.
  createEffect(() => {
    if (props.viewState === 'collapsing') {
      setCollapseReady(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setCollapseReady(true);
        });
      });
    }
  });

  const panelExpanded = createMemo(() => {
    if (props.viewState === 'expanding') return true;
    if (props.viewState === 'collapsing') return !collapseReady();
    return false;
  });

  const handleSessionSelect = (session: SessionWithStatus) => {
    props.onOpenSessionById(session.id);
  };

  const handlePreviewBack = () => {
    storageStore.closePreview();
  };

  const handlePreviewDownload = () => {
    const file = storageStore.previewFile;
    if (file) {
      const url = getDownloadUrl(file.key);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.key.split('/').pop() || 'download';
      a.click();
    }
  };

  const handleMenuClick = (e: MouseEvent, session: SessionWithStatus) => {
    setMenuState({ isOpen: true, position: { x: e.clientX, y: e.clientY }, session });
  };

  const handleMenuClose = () => {
    setMenuState({ isOpen: false, position: { x: 0, y: 0 }, session: null });
  };

  return (
    <div class="dashboard-container" data-testid="dashboard">
      <div class="dashboard-panel-wrapper">
        <div class={`dashboard-panel ${panelExpanded() ? 'dashboard-panel--expanded' : ''}`} data-testid="dashboard-floating-panel">
          <KittScanner />

        {/* Integrated Header */}
        <div class="dashboard-panel-header">
          <div class="header-logo">
            <Icon path={mdiXml} size={22} class="header-logo-icon" />
            <ScrambleText text="Codeflare" class="header-logo-text header-logo-text--scramble" />
          </div>
          <div class="header-spacer" />
          <div class="header-actions">
            {/* The avatar/username stays visible in every mode. In enterprise the
                dropdown has no entries (Subscription/Usage SaaS-only, Guided
                Setup/Logout hidden under SSO), so the avatar's click is inert —
                it opens nothing rather than an empty dropdown. */}
            <div class="header-user-wrapper">
              <button
                type="button"
                ref={userBtnRef}
                class="header-user-menu"
                data-testid="header-user-menu"
                title="User menu"
                onClick={() => {
                  if (sessionStore.enterpriseMode) return;
                  if (!showUserMenu() && userBtnRef) {
                    const rect = userBtnRef.getBoundingClientRect();
                    setUserMenuPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
                  }
                  setShowUserMenu(!showUserMenu());
                }}
              >
                <Show when={props.userName && gravatarOk()} fallback={<Icon path={mdiShieldAccount} size={24} class="header-user-avatar" />}>
                  <img src={getGravatarUrl(props.userName!, 48)} alt="Avatar" class="header-user-avatar-img" width={24} height={24} />
                </Show>
                <Show when={props.userName}>
                  <span class="header-user-name">{props.userName}</span>
                </Show>
              </button>
            </div>
            {/* Portal escapes dashboard-panel's backdrop-filter stacking context.
                Profile and Guided Setup use plain <a> tags — SolidJS Router's
                top-level DOM listener intercepts clicks for client-side navigation.
                No onClick handlers = no touch event race conditions on mobile.
                Logout uses window.location.href since it's a real server redirect. */}
            <Portal>
              <Show when={showUserMenu()}>
                <div class="header-user-dropdown-overlay" data-testid="header-user-dropdown-overlay" onClick={() => setShowUserMenu(false)}>
                  <div
                    class="header-user-dropdown header-user-dropdown--portal"
                    data-testid="header-user-dropdown"
                    onClick={(e) => e.stopPropagation()}
                    style={window.innerWidth > 640 ? { top: `${userMenuPos().top}px`, right: `${userMenuPos().right}px` } : undefined}
                  >
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
                    {/* Usage is SaaS-only — the enterprise usage view is disabled
                        for now (it always reports 0; fix deferred). */}
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
                        inert in enterprise, REQ-ENTERPRISE-008 AC8/AC9), so reaching
                        here implies non-enterprise. */}
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
                </div>
              </Show>
            </Portal>
            <button type="button" class="header-settings-button" data-testid="dashboard-settings-button" title="Settings" onClick={() => props.onSettingsClick?.()}>
              <Icon path={mdiCogOutline} size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div class="dashboard-panel-body">
          {/* Left Column */}
          <div class="dashboard-panel-left" data-testid="dashboard-panel-left">
            <DashboardCard sessions={props.sessions} />

            <div class={`dashboard-new-session-wrapper ${multiViewWorkspace() ? 'dashboard-new-session-wrapper--with-multiview' : ''}`}>
                <Portal>
                  <CreateSessionDialog
                    isOpen={showCreateDialog()}
                    onClose={() => setShowCreateDialog(false)}
                    onSelect={(agentType, tabConfig) => {
                      setShowCreateDialog(false);
                      props.onCreateSession(agentType, tabConfig);
                    }}
                    anchorRef={newSessionBtnRef()}
                  />
                </Portal>
                <Portal>
                  <SessionLimitPopup
                    isOpen={showLimitPopup()}
                    onClose={() => setShowLimitPopup(false)}
                    sessionsRunning={sessionStore.sessions.filter(s => s.status === 'running' || s.status === 'initializing').length}
                    sessionsLimit={sessionStore.maxSessions}
                    anchorRef={newSessionBtnRef()}
                  />
                </Portal>
                <button
                  type="button"
                  ref={setNewSessionBtnRef}
                  class={`dashboard-new-session-btn ${sessionStore.isAtSessionLimit() ? 'dashboard-new-session-btn--limited' : ''}`}
                  data-testid="dashboard-new-session"
                  disabled={!sessionStore.r2Ready || isAtUsageQuota() || sessionStore.preseedUpgrading}
                  aria-label={sessionStore.preseedUpgrading ? 'Upgrading agent skills' : !sessionStore.r2Ready ? 'Waiting for storage setup' : isAtUsageQuota() ? 'Monthly compute quota exceeded' : sessionStore.isAtSessionLimit() ? 'Session limit reached' : 'Create new session'}
                  onClick={() => {
                    if (sessionStore.isAtSessionLimit()) {
                      setShowLimitPopup(!showLimitPopup());
                    } else {
                      setShowCreateDialog(!showCreateDialog());
                    }
                  }}
                >
                  {sessionStore.preseedUpgrading ? 'Upgrading' : '+ New Session'}
                </button>
                <Show when={multiViewWorkspace()}>
                  <button
                    type="button"
                    class="dashboard-multiview-action"
                    data-testid="dashboard-multiview-action"
                    aria-label="Open MultiView"
                    title="Open MultiView"
                    onClick={() => props.onOpenMultiView?.()}
                  >
                    <Icon path={MULTIVIEW_ICON} size={22} />
                  </button>
                </Show>
            </div>

            <Show when={props.sessions.length > 0}>
              <div class="dashboard-sessions-section">
                <div class="dashboard-section-divider"><span>Recent Sessions</span></div>
                <div class="dashboard-session-list">
                  <For each={props.sessions}>
                    {(session) => (
                      <SessionStatCard
                        session={session}
                        isActive={false}
                        onSelect={() => handleSessionSelect(session)}
                        onStop={() => props.onStopSession(session.id)}
                        onDelete={() => props.onDeleteSession(session.id)}
                        onMenuClick={handleMenuClick}
                      />
                    )}
                  </For>
                </div>
                <Portal>
                  <SessionContextMenu
                    isOpen={menuState().isOpen}
                    position={menuState().position}
                    canStop={menuState().session ? (menuState().session!.status === 'running' || menuState().session!.status === 'initializing') : false}
                    sessionName={menuState().session?.name || ''}
                    onStop={() => { if (menuState().session) props.onStopSession(menuState().session!.id); }}
                    onDelete={() => { if (menuState().session) props.onDeleteSession(menuState().session!.id); }}
                    onClose={handleMenuClose}
                  />
                </Portal>
              </div>
            </Show>


            <div class="dashboard-stats-section">
              <div class="dashboard-section-divider"><span>Storage Usage</span></div>
              <StatCards stats={storageStore.stats} />
            </div>
          </div>

          {/* Right Column — on mobile the two panels flip; on desktop they stack. */}
          <div
            class="dashboard-panel-right"
            data-testid="dashboard-panel-right"
            data-face={effectiveFace()}
            data-layout={layoutMode() === 'flip' ? 'flip' : undefined}
            ref={rightColRef}
          >
            <Show when={githubStore.enabled}>
              <div
                class="panel-flip-face panel-flip-face--github"
                data-active={effectiveFace() === 'github'}
                ref={githubFaceRef}
                style={layoutMode() !== 'flip' && githubMaxH() != null ? { 'max-height': `${githubMaxH()}px` } : undefined}
              >
                <GitHubPanel onFlip={() => setPanelFace('storage')} />
              </div>
            </Show>
            <div
              class="panel-flip-face panel-flip-face--storage"
              data-active={effectiveFace() === 'storage'}
              ref={storageFaceRef}
              style={layoutMode() !== 'flip' && githubStore.enabled && storageMaxH() != null ? { 'max-height': `${storageMaxH()}px` } : undefined}
            >
              <Show when={githubStore.enabled}>
                <div class="files-panel-header" data-testid="files-panel-header">
                  <h2 class="files-panel-title" data-testid="files-panel-title">Storage Browser</h2>
                  <IconButton
                    icon={mdiFlipVertical}
                    label="Show GitHub"
                    onClick={() => setPanelFace('github')}
                    class="panel-flip-back-btn"
                    testId="storage-flip-btn"
                  />
                </div>
              </Show>
            <Show when={sessionStore.r2Ready} fallback={
              <div class="storage-skeleton" data-testid="storage-skeleton">
                <div class="storage-skeleton-header">
                  <div class="storage-skeleton-breadcrumb storage-skeleton-bar" />
                  <div class="storage-skeleton-toolbar">
                    <div class="storage-skeleton-btn storage-skeleton-bar" />
                    <div class="storage-skeleton-btn storage-skeleton-bar" />
                    <div class="storage-skeleton-btn storage-skeleton-bar" />
                  </div>
                </div>
                <div class="storage-skeleton-rows">
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" style="width: 55%" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" style="width: 70%" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" style="width: 40%" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" style="width: 60%" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                  <div class="storage-skeleton-row"><div class="storage-skeleton-icon storage-skeleton-bar" /><div class="storage-skeleton-name storage-skeleton-bar" style="width: 48%" /><div class="storage-skeleton-size storage-skeleton-bar" /></div>
                </div>
                <div class="storage-skeleton-message">Setting up your storage...</div>
              </div>
            }>
              <Show when={storageStore.previewFile} fallback={<StorageBrowser />}>
                <FilePreview file={storageStore.previewFile} onBack={handlePreviewBack} onDownload={handlePreviewDownload} />
              </Show>
            </Show>
            </div>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
};

export default Dashboard;
