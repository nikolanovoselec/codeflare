import { isPiWebSession } from '../lib/pi-web-session';
import { Component, Show, For, onMount, onCleanup, createSignal, createMemo, createEffect, createRenderEffect, createUniqueId, createResource, type JSX } from 'solid-js';
import PiWorkspaceMode, { type PiWorkspaceModeBinding } from './PiWorkspaceMode';
import ConnectCard from './github/ConnectCard';
import ClonePicker from './github/ClonePicker';
import '../styles/github-panel.css';
import { Portal } from 'solid-js/web';
import { mdiXml, mdiCogOutline, mdiShieldAccount, mdiAccountOutline, mdiRocketLaunchOutline, mdiChartBar, mdiLogout, mdiFlipVertical, mdiReflectHorizontal, mdiGithub, mdiSourceRepository, mdiChevronDoubleRight, mdiChevronDoubleLeft, mdiChevronDoubleUp, mdiChevronDoubleDown } from '@mdi/js';
import Icon from './Icon';
import IconButton from './ui/IconButton';
import type { SessionWithStatus, AgentType, TabConfig, PiSurface } from '../types';
import { storageStore } from '../stores/storage';
import { recreateAgentConfigs } from '../api/storage';
import type { MigrationRetry } from './MigrationRetryNotice';
import { downloadFile } from '../lib/download';
import { getGravatarUrl, gravatarExists } from '../lib/gravatar';
import SessionStatCard from './SessionStatCard';
import SessionContextMenu from './SessionContextMenu';
import StatCards from './StatCards';
import { StatCard, StatCardMetric } from './StatCard';
import StorageBrowser from './StorageBrowser';
import GitHubPanel from './github/GitHubPanel';
import FilePreview from './FilePreview';
import DownloadsDisabledPopup from './DownloadsDisabledPopup';
import CreateSessionDialog from './CreateSessionDialog';
import SessionLimitPopup from './SessionLimitPopup';
import ScrambleText from './ScrambleText';
import DashboardCard from './TipsRotator';
import { sessionStore, isAtUsageQuota } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { isSessionCardVisible, isSessionCloneTarget, isShutdownInProgress, sessionCardStatus } from '../lib/session-presentation';
import { createTerminalViewportClass } from '../lib/mobile';
import { measureHeaderActions, measureProfileMenu } from '../lib/header-fit';
import { githubStore } from '../stores/github';
import { getGithubOwnedRepoCounts, type GithubRepo } from '../api/github';
import { formatRepoAge } from '../lib/format';
import { consumeGithubConnectReturn } from '../lib/github-connect-return';
import { getBrowserTimezone, syncBrowserTimezone } from '../lib/timezone-sync';
import { MULTIVIEW_ICON } from '../lib/terminal-config';
import UsageInlineBadge from './UsageInlineBadge';
import OperatorActivityButton from './OperatorActivityButton';
import '../styles/dashboard.css';

interface DashboardProps {
  workspaceMode?: PiWorkspaceModeBinding;
  renderSessionVault?: (session: SessionWithStatus) => JSX.Element;
  launchingVibe?: boolean;
  migrationRetry: MigrationRetry;
  sessions: SessionWithStatus[];
  onCreateSession: (agentType?: AgentType, tabConfig?: TabConfig[], surface?: PiSurface, implicitAgent?: boolean, repo?: string) => void | Promise<void>;
  onStartSession: (id: string, surface?: PiSurface) => void;
  onOpenVscodeSession: (id: string) => void;
  onOpenSessionById: (id: string, surface?: PiSurface) => void;
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
  const vibe = () => props.workspaceMode?.value === 'chat';
  const directPiLaunch = () => vibe() || (sessionStore.preferences.sessionMode === 'advanced'
    && sessionStore.preferences.defaultWorkspace === 'vscode' && sessionStore.allowedAgents?.includes('pi') === true);
  const [githubReturnError, setGithubReturnError] = createSignal<string | null>(null);
  const showGithubDetails = () => vibe() && (githubStore.enabled || !!githubReturnError());
  const sessionCreateDisabled = () => props.launchingVibe || !sessionStore.r2Ready || isAtUsageQuota()
    || sessionStore.preseedUpgrading || (sessionStore.managedReleaseStatus === 'upgrading' && !sessionStore.preseedUpgradeFailed)
    || sessionStore.managedReleaseStatus === 'update_pending' || Boolean(migrationStatus());
  const countAccount = () => vibe() && githubStore.enabled && githubStore.connected
    && (githubStore.source === 'oauth' || githubStore.source === 'app') ? githubStore.login : undefined;
  const [ownedRepoCounts] = createResource(countAccount, async login => {
    try {
      const result = await getGithubOwnedRepoCounts();
      return result.counts && result.login.toLowerCase() === login.toLowerCase() ? { login, counts: result.counts } : undefined;
    } catch { return undefined; }
  });
  const countsForAccount = () => {
    const result = ownedRepoCounts();
    return result && result.login === countAccount() && !ownedRepoCounts.loading ? result.counts : undefined;
  };
  const countsLoading = () => !!countAccount() && ownedRepoCounts.loading;
  const runningCloneTargets = () => sessionStore.sessions.some(session => isSessionCloneTarget(session) && isPiWebSession(session));
  const [repoClonePicker, setRepoClonePicker] = createSignal<{ repo: GithubRepo; anchor: HTMLButtonElement }>();
  const [retryingRepos, setRetryingRepos] = createSignal(false);
  createEffect(() => {
    if (!vibe() || !githubStore.canRetryInitialRepos || retryingRepos()) return;
    const timer = setTimeout(async () => {
      setRetryingRepos(true);
      try { await githubStore.retryInitialRepos(); }
      finally { setRetryingRepos(false); }
    }, 5000);
    onCleanup(() => clearTimeout(timer));
  });
  const knownEmptyRepos = () => githubStore.page > 0 && !githubStore.loading && !githubStore.error
    && !githubStore.hasMore && githubStore.repos.length === 0;
  const visibleRepoCounts = () => {
    const counts = countsForAccount();
    return knownEmptyRepos() && !Object.values(counts ?? {}).some(value => value != null && value > 0) ? undefined : counts;
  };
  const recentRepos = createMemo(() => githubStore.repos
    .map(repo => ({ repo, updated: Date.parse(repo.updated_at) }))
    .filter(item => Number.isFinite(item.updated))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 3).map(({ repo }) => repo));
  createEffect(() => {
    const selected = repoClonePicker();
    if (selected && (!vibe() || !githubStore.connected || visibleRepoCounts() || !recentRepos().includes(selected.repo))) {
      setRepoClonePicker(undefined);
    }
  });
  const [browsersOpen, setBrowsersOpen] = createSignal(false);
  let browserPull: HTMLButtonElement | undefined;
  let dashboard: HTMLDivElement | undefined;
  const browsersClosed = () => vibe() && !browsersOpen();
  const browsersId = createUniqueId();
  const browserLabel = () => githubStore.enabled ? 'GitHub & Storage' : 'Storage';
  const pullIcon = () => viewport() === 'mobile'
    ? browsersOpen() ? mdiChevronDoubleUp : mdiChevronDoubleDown
    : browsersOpen() ? mdiChevronDoubleLeft : mdiChevronDoubleRight;
  createEffect(() => { if (!vibe()) setBrowsersOpen(false); });

  onMount(() => createEffect(() => {
    const page = dashboard;
    if (!page || !vibe() || viewport() !== 'mobile') return;
    let pull: { id: number; x: number; y: number; close: boolean; claimed: boolean } | undefined;
    const reset = () => { pull = undefined; };
    const start = (event: TouchEvent) => {
      reset();
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]')) return;
      const close = browsersOpen();
      const atEdge = (element: Element) => close
        ? element.scrollTop <= 1
        : element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      for (let element: Element | null = target; element; element = element.parentElement) {
        if (/^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY)
          && element.scrollHeight > element.clientHeight && !atEdge(element)) return;
      }
      if (document.scrollingElement && !atEdge(document.scrollingElement)) return;
      const { identifier, clientX, clientY } = event.touches[0];
      pull = { id: identifier, x: clientX, y: clientY, close, claimed: false };
    };
    const move = (event: TouchEvent) => {
      if (!pull) return;
      const point = event.touches[0];
      if (event.touches.length !== 1 || point.identifier !== pull.id || browsersOpen() !== pull.close) return reset();
      if (!pull.claimed) {
        const dx = Math.abs(point.clientX - pull.x);
        const dy = (point.clientY - pull.y) * (pull.close ? 1 : -1);
        if (Math.max(dx, Math.abs(dy)) < 8) return;
        if (dy <= dx || !event.cancelable) return reset();
        pull.claimed = true;
      }
      if (event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const gesture = pull;
      reset();
      if (!gesture?.claimed || browsersOpen() !== gesture.close) return;
      const point = Array.from(event.changedTouches).find(touch => touch.identifier === gesture.id);
      if (!point) return;
      const dy = (point.clientY - gesture.y) * (gesture.close ? 1 : -1);
      if (dy < 48 || dy <= Math.abs(point.clientX - gesture.x)) return;
      if (gesture.close && document.getElementById(browsersId)?.contains(document.activeElement)) browserPull?.focus();
      setBrowsersOpen(!gesture.close);
    };
    page.addEventListener('touchstart', start, { passive: true });
    page.addEventListener('touchmove', move, { passive: false });
    page.addEventListener('touchend', end);
    page.addEventListener('touchcancel', reset);
    onCleanup(() => {
      page.removeEventListener('touchstart', start);
      page.removeEventListener('touchmove', move);
      page.removeEventListener('touchend', end);
      page.removeEventListener('touchcancel', reset);
    });
  }));

  const effectiveFace = () => (githubStore.enabled ? panelFace() : 'storage');
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [showLimitPopup, setShowLimitPopup] = createSignal(false);
  const [recreateLoading, setRecreateLoading] = createSignal(false);
  const [recreateError, setRecreateError] = createSignal<string | null>(null);
  const [recreateMessage, setRecreateMessage] = createSignal<string | null>(null);
  const migrationStatus = () => sessionStore.bucketMigrationHaltedAt ? 'Migration halted'
    : sessionStore.bucketMigrating
      ? (sessionStore.bucketMigrationPercent != null ? `Migrating ${sessionStore.bucketMigrationPercent}%` : 'Migrating')
      : null;
  const showUpgradeRecovery = () => sessionStore.preseedUpgradeFailed
    && !sessionStore.preseedUpgrading
    && !migrationStatus()
    && sessionStore.managedReleaseStatus !== 'update_pending';
  const recoveryAction = () => sessionStore.bucketMigrationHaltedAt ? 'migration' : showUpgradeRecovery() ? 'recreate' : undefined;
  const handleRecreate = async () => {
    if (recreateLoading() || sessionStore.preseedUpgrading || !showUpgradeRecovery()) return;
    setRecreateLoading(true);
    setRecreateError(null);
    setRecreateMessage(null);
    try {
      const result = await sessionStore.runPreseedUpdate(recreateAgentConfigs);
      const parts = [`Recreated ${result.written.length} agent config file(s).`];
      if (result.deleted && result.deleted.length > 0) parts.push(`Removed ${result.deleted.length} file(s) from previous mode.`);
      setRecreateMessage(parts.join(' '));
    } catch (error) {
      setRecreateError(error instanceof Error ? error.message : 'Failed to recreate agent configurations.');
    } finally {
      setRecreateLoading(false);
    }
  };
  const [showUserMenu, setShowUserMenu] = createSignal(false);
  const [gravatarOk, setGravatarOk] = createSignal(false);
  // Probe Gravatar existence once via fetch (no <img onError> console noise).
  createEffect(() => {
    const email = props.userName;
    if (!email) { setGravatarOk(false); return; }
    gravatarExists(email, 48).then(setGravatarOk);
  });
  const [profileEmail, setProfileEmail] = createSignal<HTMLDivElement>();
  const [userMenuPos, setUserMenuPos] = createSignal({ top: 0, right: 0, sheet: false });
  let userBtnRef: HTMLButtonElement | undefined;
  createEffect(() => {
    if (!showUserMenu()) return;
    const email = profileEmail();
    const update = () => {
      const emailHeight = email?.parentElement
        ? email.offsetHeight + (Number.parseFloat(getComputedStyle(email.parentElement).rowGap) || 0) : 0;
      if (userBtnRef) setUserMenuPos(measureProfileMenu(userBtnRef, emailHeight));
    };
    update();
    window.addEventListener('resize', update);
    const observer = email && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    if (email) observer?.observe(email);
    onCleanup(() => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    });
  });
  let dashboardHeader!: HTMLDivElement;
  let headerActions!: HTMLDivElement;
  const [operatorInProfile, setOperatorInProfile] = createSignal(false);
  const [operatorProfileMount, setOperatorProfileMount] = createSignal<HTMLDivElement>();
  createEffect(() => {
    if (!props.workspaceMode || !sessionStore.enterpriseMode || typeof ResizeObserver === 'undefined') {
      setOperatorInProfile(false);
      return;
    }
    const measure = () => {
      if (dashboardHeader.clientWidth > 0) {
        setOperatorInProfile(measureHeaderActions(dashboardHeader, headerActions, ['operators']).overflow.includes('operators'));
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(dashboardHeader);
    observer.observe(headerActions);
    measure();
    onCleanup(() => observer.disconnect());
  });

  const [newSessionBtnRef, setNewSessionBtnRef] = createSignal<HTMLButtonElement>();
  const [newSessionPadding, setNewSessionPadding] = createSignal(0);
  createEffect(() => {
    const button = newSessionBtnRef();
    if (!button) return;
    const measure = () => setNewSessionPadding(button.getBoundingClientRect().height / 2);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(button, { box: 'border-box' });
    onCleanup(() => observer.disconnect());
  });
  const visibleSessions = createMemo(() => props.sessions.filter(isSessionCardVisible));
  const [sessionList, setSessionList] = createSignal<HTMLDivElement>();
  const [sessionListLimit, setSessionListLimit] = createSignal<number>();
  createEffect(() => {
    const list = sessionList();
    const sessions = visibleSessions();
    if (!list || !browsersClosed() || sessions.length < 4) {
      setSessionListLimit(undefined);
      return;
    }
    const measure = () => {
      const first = list.firstElementChild?.getBoundingClientRect();
      const fourth = list.children[3]?.getBoundingClientRect();
      setSessionListLimit(first && fourth?.height ? fourth.top - first.top + fourth.height * 0.3 : undefined);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    for (const card of Array.from(list.children).slice(0, 4)) observer?.observe(card, { box: 'border-box' });
    measure();
    onCleanup(() => observer?.disconnect());
  });
  const managedUpgradePercent = createMemo(() => {
    const progress = sessionStore.managedReleaseProgress;
    if (!progress) return 0;
    if (progress.total === 0) return 0;
    return Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
  });
  const managedUpgradeStyle = createMemo(() => {
    if (sessionStore.managedReleaseStatus !== 'upgrading' || sessionStore.preseedUpgradeFailed) return undefined;
    const percent = managedUpgradePercent();
    return `background: linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${percent}%, color-mix(in srgb, var(--color-accent) 72%, black) ${percent}%, color-mix(in srgb, var(--color-accent) 72%, black) 100%);`;
  });
  const managedUpgradeLabel = createMemo(() => {
    if (sessionStore.managedReleaseStatus !== 'upgrading') return undefined;
    const progress = sessionStore.managedReleaseProgress;
    if (progress?.phase === 'finalizing') return 'Finalizing';
    if (progress?.phase === 'writing') return `Upgrading ${progress.completed} / ${progress.total}`;
    return 'Upgrading';
  });
  const managedUpgradeAriaLabel = createMemo(() => {
    if (sessionStore.managedReleaseStatus !== 'upgrading') return undefined;
    const progress = sessionStore.managedReleaseProgress;
    if (progress?.phase === 'finalizing') return 'Finalizing managed resources';
    if (progress?.phase === 'writing') return `Upgrading managed resources, ${progress.completed} of ${progress.total} complete`;
    return 'Upgrading managed resources';
  });
  const [menuState, setMenuState] = createSignal<{ isOpen: boolean; position: { x: number; y: number }; session: SessionWithStatus | null }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    session: null,
  });
  const menuSession = createMemo(() => visibleSessions().find(session => session.id === menuState().session?.id));
  const menuStatus = () => { const session = menuSession(); return session && sessionCardStatus(session); };

  // ── Adaptive right-column split (bug #21) ──────────────────────────────
  // GitHub (top) + Storage (bottom) share the column. The flex engine does the
  // pixel allocation: both faces are `flex: 1 1 0` with a measured max-height of
  // their natural content, and `justify-content: space-between` drops any slack in
  // the middle. Here we only choose split-vs-flip and feed the measured heights.
  let rightColRef: HTMLDivElement | undefined;
  let githubFaceRef: HTMLDivElement | undefined;
  let storageFaceRef: HTMLDivElement | undefined;
  const [githubMaxH, setGithubMaxH] = createSignal<number | null>(null);
  const [storageMaxH, setStorageMaxH] = createSignal<number | null>(null);
  const flipBrowsers = () => viewport() === 'mobile';
  const flipTo = (face: 'github' | 'storage') => {
    setPanelFace(face);
    if (!flipBrowsers()) return;
    queueMicrotask(() => {
      if (browsersClosed() || !flipBrowsers() || effectiveFace() !== face) return;
      const destination = face === 'github' ? githubFaceRef : storageFaceRef;
      destination?.querySelector<HTMLButtonElement>('.github-flip-btn, .panel-flip-back-btn')?.focus();
    });
  };
  const useMeasuredSplit = () => !flipBrowsers();
  const [flipViewportCap, setFlipViewportCap] = createSignal<number | null>(null);
  const activeFlipHeight = () => {
    const natural = effectiveFace() === 'github' ? githubMaxH() : storageMaxH();
    const cap = flipViewportCap();
    return natural == null || cap == null ? null : Math.min(natural, cap);
  };

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
    const prevDisplay = face.style.display;
    face.style.maxHeight = 'none';
    face.style.flex = '0 0 auto';
    face.style.display = 'flex';
    const scroller = face.querySelector<HTMLElement>(scrollSel);
    const natural = scroller
      ? Math.max(0, face.getBoundingClientRect().height - scroller.getBoundingClientRect().height) + scroller.scrollHeight
      : face.getBoundingClientRect().height;
    face.style.display = prevDisplay;
    face.style.flex = prevFlex;
    face.style.maxHeight = prevMaxH;
    return Math.ceil(natural);
  };

  const measureLayout = () => {
    const right = rightColRef;
    if (!right || browsersClosed()) return;
    const viewportCap = Math.floor(window.innerHeight * 0.75);
    setFlipViewportCap((previous) => (previous === viewportCap ? previous : viewportCap));
    // A sole Storage face needs no shared geometry. In flip mode, measure both
    // faces (including the hidden one); the active face gets its own natural,
    // viewport-capped height so flipping never retains its sibling's geometry.
    if (!githubStore.enabled) {
      setGithubMaxH(null);
      setStorageMaxH(null);
      return;
    }
    const gh = measureNatural(githubFaceRef, '.github-repo-rows');
    const st = measureNatural(storageFaceRef, '.storage-drop-zone');
    // Idempotent writes: redundant observer callbacks stay no-ops. Flip mode
    // consumes the active value as height; split mode consumes both as max-height.
    setGithubMaxH((p) => (p === gh ? p : gh));
    setStorageMaxH((p) => (p === st ? p : st));
  };

  onMount(() => {
    const right = rightColRef;
    if (!right) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureLayout); };
    // Re-measure when the viewport, column box, or panel content changes. This is
    // loop-free because measureNatural reads the natural height with our own max-height
    // removed, so redundant measurements are idempotent. The #568 flicker came from
    // measuring while our max-height was applied, not from which element was observed.
    // Listen to viewport resize directly because a capped flip column can retain its old
    // box size when the viewport grows, leaving ResizeObserver with nothing to report.
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(right);
    // Observe rows added or removed inside either panel. childList ignores the
    // max-height style attributes written by measureLayout.
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    mo?.observe(right, { childList: true, subtree: true });
    schedule(); // initial measure
    onCleanup(() => {
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(raf);
    });
  });

  onMount(() => {
    setGithubReturnError(consumeGithubConnectReturn());
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
    if (isShutdownInProgress(session.shutdownPhase) || (session.shutdownPhase && sessionStore.isMemoryRetryPending(session.id))) return;
    if (session.workspace !== 'vscode') {
      props.onOpenSessionById(session.id);
      return;
    }
    const status = sessionCardStatus(session);
    if (status === 'stopped' || status === 'error' || session.editorReadyError === true) {
      props.onStartSession(session.id);
    } else if ((status === 'running' || status === 'unreachable') && session.editorReady === true) {
      props.onOpenVscodeSession(session.id);
    }
  };

  const handlePreviewBack = () => {
    storageStore.closePreview();
  };

  const handlePreviewDownload = async () => {
    // View-only storage: surface the friendly notice instead of a raw failure.
    if (storageStore.downloadsDisabled) {
      storageStore.showDownloadsNotice();
      return;
    }
    const file = storageStore.previewFile;
    if (!file) return;
    // Fetch-based (via the shared helper) so a stale flag + a server 403 still shows
    // the notice rather than a broken-looking download.
    if ((await downloadFile(file.key)) === 'blocked') storageStore.showDownloadsNotice();
  };

  const handleMenuClick = (e: MouseEvent, session: SessionWithStatus) => {
    setMenuState({ isOpen: true, position: { x: e.clientX, y: e.clientY }, session });
  };

  const handleMenuClose = () => {
    setMenuState({ isOpen: false, position: { x: 0, y: 0 }, session: null });
  };

  createEffect(() => {
    if (menuState().isOpen && !menuSession()) handleMenuClose();
  });

  return (
    <div ref={dashboard} class="dashboard-container" data-testid="dashboard">
      <div class="dashboard-panel-wrapper" classList={{
        'dashboard-panel-wrapper--disclosure': vibe() && !panelExpanded(),
        'dashboard-panel-wrapper--summary': browsersClosed() && !panelExpanded(),
      }}>
        <div class={`dashboard-panel ${panelExpanded() ? 'dashboard-panel--expanded' : ''}`} data-testid="dashboard-floating-panel">
        {/* Integrated Header */}
        <div class="dashboard-panel-header" classList={{ 'header-with-workspace-mode': !!props.workspaceMode }} ref={dashboardHeader}>
          <div class="header-logo" classList={{ 'header-navigation': !!props.workspaceMode }}>
            <Icon path={mdiXml} size={22} class="header-logo-icon" />
            <ScrambleText text="Codeflare" class="header-logo-text header-logo-text--scramble" />
          </div>
          <div class="header-spacer" />
          <div class="header-actions" ref={headerActions}>
            <Show when={props.workspaceMode}>{mode => <PiWorkspaceMode {...mode()} fitContainer />}</Show>
            {/* The account menu is available in every mode. Enterprise keeps the
                read-only Usage action while self-service billing, onboarding, and
                logout remain suppressed. */}
            <div class="header-user-wrapper">
              <button
                type="button"
                ref={userBtnRef}
                class="header-user-menu"
                data-testid="header-user-menu"
                aria-label="User menu"
                title="User menu"
                onClick={() => setShowUserMenu(!showUserMenu())}
              >
                <Show when={props.userName && gravatarOk()} fallback={<Icon path={mdiShieldAccount} size={24} class="header-user-avatar" />}>
                  <img src={getGravatarUrl(props.userName!, 48)} alt="Avatar" class="header-user-avatar-img" width={24} height={24} />
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
                    class="header-user-dropdown header-user-dropdown--portal header-user-dropdown--profile"
                    data-testid="header-user-dropdown"
                    onClick={(e) => e.stopPropagation()}
                    classList={{ 'header-user-dropdown--sheet': userMenuPos().sheet }}
                    style={!userMenuPos().sheet ? {
                      top: `${userMenuPos().top}px`, right: `${userMenuPos().right}px`,
                      '--profile-menu-top': `${userMenuPos().top}px`, '--profile-menu-right': `${userMenuPos().right}px`,
                    } : undefined}
                  >
                    <Show when={props.userName}>{email => (
                      <div class="header-user-email" ref={element => {
                        setProfileEmail(element);
                        onCleanup(() => setProfileEmail(current => current === element ? undefined : current));
                      }}><span title={email()}>{email()}</span></div>
                    )}</Show>
                    <div class="header-user-profile-actions" role="group" aria-label="Account actions">
                      <Show when={operatorInProfile()}><div ref={setOperatorProfileMount} /></Show>
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
                      <a
                        href="/app/usage"
                        class="header-user-dropdown-item"
                        data-testid="header-user-dropdown-usage"
                        onClick={() => setShowUserMenu(false)}
                      >
                        <Icon path={mdiChartBar} size={16} />
                        <span>Usage</span>
                        <UsageInlineBadge />
                      </a>
                      <Show when={!sessionStore.enterpriseMode}>
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
                      </Show>
                    </div>
                  </div>
                </div>
              </Show>
            </Portal>
            {/* Dashboard: enterprise operator activity stays adjacent to account identity,
                before Settings (REQ-OPERATOR-040 AC1). The dashboard draws its own header,
                so Header.tsx's dashboard branch never renders here. */}
            <Show when={sessionStore.enterpriseMode}>
              <div data-overflow-action="operators" hidden={operatorInProfile()}>
                <OperatorActivityButton enabled compact={viewport() === 'mobile'} inProfile={operatorInProfile()}
                  profileMount={() => showUserMenu() ? operatorProfileMount() : undefined}
                  onOpenFromProfile={() => setShowUserMenu(false)} returnFocus={() => userBtnRef?.focus()} />
              </div>
            </Show>
            <button type="button" class="header-settings-button" data-testid="dashboard-settings-button" title="Settings" onClick={() => props.onSettingsClick?.()}>
              <Icon path={mdiCogOutline} size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div class="dashboard-panel-body" classList={{ 'dashboard-panel-body--disclosure': vibe() }}>
          {/* Left Column */}
          <div class="dashboard-panel-left" data-testid="dashboard-panel-left">
            <DashboardCard sessions={props.sessions} />

            <div class={`dashboard-new-session-wrapper ${multiViewWorkspace() ? 'dashboard-new-session-wrapper--with-multiview' : ''}`}
              style={{ 'padding-block-end': `${newSessionPadding()}px` }}>
                <Portal>
                  <CreateSessionDialog
                    isOpen={showCreateDialog() && !directPiLaunch()}
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
                  style={managedUpgradeStyle()}
                  disabled={sessionCreateDisabled()}
                  aria-label={migrationStatus() ?? (sessionStore.managedReleaseStatus === 'update_pending' ? 'Session environment update pending until session stops' : sessionStore.preseedUpgradeFailed && !sessionStore.preseedUpgrading ? 'Retry upgrade' : managedUpgradeAriaLabel() ?? (sessionStore.preseedUpgrading ? 'Updating session environment' : !sessionStore.r2Ready ? 'Waiting for storage setup' : isAtUsageQuota() ? 'Monthly compute quota exceeded' : sessionStore.isAtSessionLimit() ? 'Session limit reached' : 'Create new session'))}
                  onClick={async () => {
                    if (props.launchingVibe) return;
                    if (sessionStore.preseedUpgradeFailed) {
                      void sessionStore.retryPreseedUpgrade();
                      return;
                    }
                    if (sessionStore.isAtSessionLimit()) {
                      setShowLimitPopup(!showLimitPopup());
                    } else if (directPiLaunch()) {
                      setShowCreateDialog(false);
                      try { await props.onCreateSession('pi', undefined, vibe() ? 'chat' : undefined, true); }
                      catch { /* The session store already reports launch errors. */ }
                    } else {
                      setShowCreateDialog(!showCreateDialog());
                    }
                  }}
                >
                  {migrationStatus() ?? (sessionStore.managedReleaseStatus === 'update_pending'
                      ? 'Update pending'
                      : sessionStore.preseedUpgradeFailed && !sessionStore.preseedUpgrading
                        ? 'Retry upgrade'
                        : managedUpgradeLabel() ?? (sessionStore.preseedUpgrading ? 'Updating' : '+ New Session'))}
                </button>
                <Show when={recoveryAction()} keyed>
                  {(action) => {
                    const migration = action === 'migration';
                    const label = migration ? 'Retry migration' : 'Recreate Agent Skills & Rules';
                    return (
                      <button
                        type="button"
                        class="dashboard-new-session-btn dashboard-recovery-btn"
                        aria-label={label}
                        title={label}
                        disabled={migration ? props.migrationRetry.disabled() : recreateLoading() || sessionStore.preseedUpgrading}
                        aria-busy={migration ? props.migrationRetry.pending() : undefined}
                        onClick={() => void (migration ? props.migrationRetry.submit() : handleRecreate())}
                      >
                        <Icon path={mdiReflectHorizontal} size={22} />
                      </button>
                    );
                  }}
                </Show>
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

            <Show when={recreateError()}>
              <p class="dashboard-recovery-message" role="alert">{recreateError()}</p>
            </Show>
            <Show when={recreateMessage()}>
              <p class="dashboard-recovery-message" role="status">{recreateMessage()}</p>
            </Show>

            <Show when={sessionStore.statusUnavailable}>
              <p class="dashboard-recovery-message dashboard-status-unavailable" role="status">
                Session status unavailable. Displayed state may be outdated.
              </p>
            </Show>

            <Show when={sessionStore.bucketMigrationPending}>
              <div class="dashboard-migration-notice" role="status" data-testid="dashboard-migration-pending">
                Storage update pending. Close your running sessions to apply it.
              </div>
            </Show>

            <Show when={visibleSessions().length > 0}>
              <div class="dashboard-sessions-section">
                <div class="dashboard-section-divider"><span>Recent Sessions</span></div>
                <div ref={setSessionList} class="dashboard-session-list"
                  style={{ '--dashboard-session-limit': sessionListLimit() === undefined ? undefined : `${sessionListLimit()}px` }}>
                  <For each={visibleSessions()}>
                    {(session) => (
                      <SessionStatCard
                        session={session}
                        vaultAction={props.renderSessionVault?.(session)}
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
                  <Show when={menuState().isOpen && menuSession()?.id} keyed>
                    {id => (
                      <SessionContextMenu
                        isOpen
                        position={menuState().position}
                        canStop={!isShutdownInProgress(menuSession()?.shutdownPhase)
                          && (['running', 'initializing', 'starting', 'unreachable', 'stopping'].includes(menuStatus() ?? '')
                            || (menuSession()?.workspace === 'vscode' && menuStatus() === 'error'))}
                        canKill={isShutdownInProgress(menuSession()?.shutdownPhase)
                          || ['starting', 'running', 'unreachable', 'stopping'].includes(menuStatus() ?? '')}
                        onKill={() => { if (menuSession()?.id === id) void sessionStore.killSession(id); }}
                        stopLabel={menuStatus() === 'stopping' ? 'Retry Stop' : 'Stop'}
                        sessionName={menuSession()?.name ?? ''}
                        onStop={() => { if (menuSession()?.id === id) props.onStopSession(id); }}
                        canDelete={menuSession()?.shutdownPhase !== 'memory-not-merged'}
                        onDelete={() => { if (menuSession()?.id === id) props.onDeleteSession(id); }}
                        onRename={name => { if (menuSession()?.id === id) void sessionStore.renameSession(id, name); }}
                        onClose={handleMenuClose}
                      />
                    )}
                  </Show>
                </Portal>
              </div>
            </Show>


            <Show when={showGithubDetails()}>
              <section class="dashboard-stats-section" aria-label="GitHub Details">
                <div class="dashboard-section-divider"><span>GitHub Details</span></div>
                <Show when={githubReturnError()}>{message => (
                  <div class="github-return-error" role="status">{message()}</div>
                )}</Show>
                <Show when={githubStore.enabled}>
                  <Show when={githubStore.connected && githubStore.repoErrorCode !== 'NOT_CONNECTED'} fallback={<div class="stat-card"><ConnectCard compact /></div>}>
                    <StatCard icon={mdiGithub} title={
                      <Show when={githubStore.login} fallback={<span class="stat-card__title type-section-header">GitHub</span>}>
                        {login => (
                          <a class="stat-card__title type-section-header dashboard-github-card__link"
                            href={`https://github.com/${encodeURIComponent(login())}`} target="_blank" rel="noopener noreferrer">@{login()}</a>
                        )}
                      </Show>
                    }>
                      <Show when={visibleRepoCounts()} fallback={
                        <Show when={!countsLoading() || knownEmptyRepos() || githubStore.error || retryingRepos()} fallback={<span class="type-hint" role="status">Loading owned repository counts…</span>}>
                          <Show when={recentRepos().length > 0} fallback={
                            <Show when={knownEmptyRepos()} fallback={
                              <Show when={githubStore.canRetryInitialRepos || retryingRepos()} fallback={
                                <span class="type-hint" role="status">{githubStore.loading || (githubStore.page === 0 && !githubStore.error) ? 'Loading repositories…' : 'Repository shortcuts unavailable.'}</span>
                              }>
                                <div class="dashboard-github-card__empty" role="status">
                                  <span>CONNECTION TO GITHUB</span>
                                  <span>FAILED. RETRYING.</span>
                                </div>
                              </Show>
                            }>
                              <div class="dashboard-github-card__empty">
                                <span>NOTHING TO SHOW.</span>
                                <span>GO BUILD SOMETHING.</span>
                              </div>
                            </Show>
                          }>
                            <div class="stat-card__metrics">
                              <For each={recentRepos()}>{repo => (
                                <StatCardMetric label={
                                  <a class="stat-card__metric-label dashboard-github-card__repo" href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
                                    target="_blank" rel="noopener noreferrer" aria-label={repo.full_name} title={repo.full_name}>
                                    <Icon path={mdiSourceRepository} size={12} aria-hidden="true" />
                                    <span>{repo.name}</span>
                                  </a>
                                } value={
                                  <button type="button" class="stat-card__metric-value dashboard-github-card__age"
                                    title="Clone into a session" aria-label={`Clone into a session: ${repo.full_name}`}
                                    aria-haspopup={runningCloneTargets() ? 'dialog' : undefined}
                                    aria-expanded={runningCloneTargets() ? repoClonePicker()?.repo.full_name === repo.full_name : undefined}
                                    disabled={!runningCloneTargets() && (sessionCreateDisabled() || sessionStore.preseedUpgradeFailed || sessionStore.isAtSessionLimit())}
                                    onClick={async event => {
                                      if (runningCloneTargets()) {
                                        setRepoClonePicker({ repo, anchor: event.currentTarget });
                                        return;
                                      }
                                      try { await props.onCreateSession('pi', undefined, 'chat', true, repo.full_name); }
                                      catch { /* The session store reports launch errors. */ }
                                    }}>{formatRepoAge(repo.updated_at, 'compact')}</button>
                                } />
                              )}</For>
                            </div>
                          </Show>
                        </Show>
                      }>{counts => (
                        <div class="stat-card__metrics">
                          <For each={[
                            { label: 'Private repos', value: counts().private },
                            { label: 'Public repos', value: counts().public },
                            { label: 'Repos', value: counts().total },
                          ]}>{row => (
                            <Show when={row.value != null}>
                              <StatCardMetric label={<span class="stat-card__metric-label">{row.label}</span>}
                                value={<span class="stat-card__metric-value">{row.value}</span>} />
                            </Show>
                          )}</For>
                        </div>
                      )}</Show>
                      <Show when={repoClonePicker()} keyed>{({ repo, anchor }) => (
                        <Portal>
                          <ClonePicker repo={repo} anchorRef={anchor} vibeOnly onClose={() => setRepoClonePicker(undefined)} />
                        </Portal>
                      )}</Show>
                    </StatCard>
                  </Show>
                </Show>
              </section>
            </Show>
            <div class="dashboard-stats-section">
              <div class="dashboard-section-divider"><span>Storage Usage</span></div>
              <StatCards stats={storageStore.stats} />
            </div>
          </div>

          <Show when={vibe()}>
            <button ref={browserPull} type="button" class="icon-button dashboard-panel-pull" aria-expanded={browsersOpen()} aria-controls={browsersId}
              aria-label={`${browsersOpen() ? 'Hide' : 'Show'} ${browserLabel()}`}
              onClick={() => setBrowsersOpen(value => !value)}>
              <Icon path={pullIcon()} size={24} aria-hidden="true" />
            </button>
          </Show>

          {/* Keep the same browser subtree in both layouts, even when the Vibe drawer is closed. */}
          <div
            id={browsersId}
            class="dashboard-panel-right"
            hidden={browsersClosed()}
            data-testid="dashboard-panel-right"
            data-face={effectiveFace()}
            data-layout={flipBrowsers() ? 'flip' : undefined}
            onKeyDown={event => {
              if (event.key !== 'Escape' || event.defaultPrevented || !vibe() || !browsersOpen()
                || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
              event.preventDefault();
              browserPull?.focus();
              setBrowsersOpen(false);
            }}
            ref={el => {
              rightColRef = el;
              createRenderEffect(() => el.toggleAttribute('inert', browsersClosed()));
            }}
            style={flipBrowsers() && activeFlipHeight() != null ? { height: `${activeFlipHeight()}px` } : undefined}
          >
            <Show when={githubStore.enabled}>
              <div
                class="panel-flip-face panel-flip-face--github"
                data-active={effectiveFace() === 'github'}
                aria-hidden={vibe() && flipBrowsers() && effectiveFace() !== 'github' ? true : undefined}
                ref={githubFaceRef}
                style={useMeasuredSplit() && githubMaxH() != null ? { 'max-height': `${githubMaxH()}px` } : undefined}
              >
                <GitHubPanel vibeOnly={vibe()} connectReturnError={vibe() ? null : githubReturnError()}
                  onFlip={flipBrowsers() ? () => flipTo('storage') : undefined} />
              </div>
            </Show>
            <div
              class="panel-flip-face panel-flip-face--storage"
              data-active={effectiveFace() === 'storage'}
              aria-hidden={vibe() && flipBrowsers() && effectiveFace() !== 'storage' ? true : undefined}
              ref={storageFaceRef}
              style={useMeasuredSplit() && githubStore.enabled && storageMaxH() != null ? { 'max-height': `${storageMaxH()}px` } : undefined}
            >
              <Show when={githubStore.enabled}>
                <div class="files-panel-header" data-testid="files-panel-header">
                  <h2 class="files-panel-title" data-testid="files-panel-title">Storage Browser</h2>
                  <Show when={flipBrowsers()}>
                    <IconButton
                      icon={mdiFlipVertical}
                      label="Show GitHub"
                      onClick={() => flipTo('github')}
                      class="panel-flip-back-btn"
                      testId="storage-flip-btn"
                    />
                  </Show>
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
                <FilePreview file={storageStore.previewFile} onBack={handlePreviewBack} onDownload={handlePreviewDownload} downloadsDisabled={storageStore.downloadsDisabled} />
              </Show>
            </Show>
            <DownloadsDisabledPopup />
            </div>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
};

export default Dashboard;
