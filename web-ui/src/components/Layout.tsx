import { Component, createSignal, createMemo, createEffect, onMount, onCleanup, Show, untrack } from 'solid-js';
import Header from './Header';
import TerminalArea from './TerminalArea';
import SettingsPanel from './SettingsPanel';
import StoragePanel from './StoragePanel';
import SplashCursor from './SplashCursor';
import '../styles/layout.css';
import { sessionStore, getUsageWarningLevel, getDismissedQuotaLevel, setDismissedQuotaLevel } from '../stores/session';
import { storageStore } from '../stores/storage';
import { terminalStore, reconnectDisconnectedTerminals, reconnectOnVisibilityReturn, scheduleDisconnect, cancelScheduledDisconnect } from '../stores/terminal';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { forceResetKeyboardState, enableVirtualKeyboardOverlay, isSamsungBrowser, cleanupDebugOverlay } from '../lib/mobile';
import { logger } from '../lib/logger';
import { loadSettings, applyAccentColor } from '../lib/settings';
import type { TileLayout, AgentType, TabConfig } from '../types';
import { VIEW_TRANSITION_DURATION_MS, DASHBOARD_WS_DISCONNECT_DELAY_MS } from '../lib/constants';
import { startVaultReadinessProbe, probeVaultReady } from '../lib/vault-readiness';
import { DEFAULT_VAULT_PREWARM_TIMEOUT_MS, startVaultPrewarm, type VaultPrewarmStatus } from '../lib/vault-prewarm';
import { checkVaultLocalReadiness, checkVaultKeyRecoverable, markVaultFullyPrewarmed, hasVaultFullyPrewarmed } from '../lib/vault-local-readiness';
import type { VaultButtonStatus } from './VaultButton';
import { requestBrowserStoragePersistence } from '../lib/browser-storage-persistence';

type ViewState = 'dashboard' | 'expanding' | 'terminal' | 'collapsing';

export function clearPrewarmingVaultStatus(
  statuses: Record<string, VaultPrewarmStatus>,
  sessionId: string,
): Record<string, VaultPrewarmStatus> {
  if (statuses[sessionId] !== 'prewarming') return statuses;
  const next = { ...statuses };
  delete next[sessionId];
  return next;
}

interface LayoutProps {
  userName?: string;
  userRole?: 'admin' | 'user';
  userAccessTier?: import('../types').AccessTier;
  userSubscriptionTier?: import('../types').SubscriptionTier;
  onboardingActive?: boolean;
  enterpriseMode?: boolean;
}

/**
 * Main Layout component
 *
 * Structure:
 * +------------------------------------------------------------------+
 * | HEADER (48px)                                                     |
 * +------------------------------------------------------------------+
 * | MAIN CONTENT                                                      |
 * |                                                                   |
 * +------------------------------------------------------------------+
 */
const Layout: Component<LayoutProps> = (props) => {
  const usageWarning = () => getUsageWarningLevel();
  const [terminalError, setTerminalError] = createSignal<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false);
  const [isStoragePanelOpen, setIsStoragePanelOpen] = createSignal(false);
  const [showTilingOverlay, setShowTilingOverlay] = createSignal(false);
  const [viewState, setViewState] = createSignal<ViewState>('dashboard');
  let viewTransitionTimer: ReturnType<typeof setTimeout> | undefined;

  const clearViewTransitionTimer = () => {
    if (viewTransitionTimer) {
      clearTimeout(viewTransitionTimer);
      viewTransitionTimer = undefined;
    }
  };
  onCleanup(clearViewTransitionTimer);

  // Vault readiness: ground-truth probe via the server. We can't trust
  // session status flags here — the SilverBullet supervisor starts late in
  // entrypoint.sh (well after ptyActive flips), so a session-level "ready"
  // signal would lie. probeVaultReady() polls `GET /api/vault/:sid/status`,
  // which runs the SB-reachability check server-side and returns 200 +
  // { vaultReady }; it reports ready only when SB is actually serving, with
  // none of the 502 / timeout-abort console noise the old HEAD-the-proxy
  // probe produced while SB warmed up. Keyed per session so a switch resets it.
  //
  // Lifecycle: warm-up probes every WARMUP_INTERVAL_MS forever until the
  // first success (REQ-VAULT-012 AC5). After first success we switch to a
  // steady re-probe to catch SB crashing mid-session (container still
  // "running", proxy returns 502); a failed re-probe clears the latch so
  // the button disables itself and the warmup chain restarts.
  const WARMUP_INTERVAL_MS = 5000;
  const STEADY_INTERVAL_MS = 60000; // post-ready slow re-probe cadence
  const VAULT_PREWARM_RETRY_INTERVAL_MS = 10000;
  const VAULT_KEY_POLL_INTERVAL_MS = 2000; // cadence for re-checking key recoverability while preparing
  const VAULT_LOCAL_READINESS_PROBE_TIMEOUT_MS = 2000; // bound the reload skip-eligibility probe before falling back to the iframe
  const [vaultReadyBySession, setVaultReadyBySession] = createSignal<Record<string, boolean>>({});
  const [vaultPrewarmBySession, setVaultPrewarmBySession] = createSignal<Record<string, VaultPrewarmStatus>>({});
  const [vaultPrewarmRetryBySession, setVaultPrewarmRetryBySession] = createSignal<Record<string, number>>({});
  // Click-guard open intent (REQ-VAULT-018 / REQ-VAULT-022): 'preparing' = key not yet
  // recoverable (button breathes accent), 'armed' = key recoverable (button
  // breathes green, next click opens). Absent = no pending open.
  const [vaultOpenIntentBySession, setVaultOpenIntentBySession] = createSignal<Record<string, 'preparing' | 'armed'>>({});
  const [vaultPersistenceRequestedBySession, setVaultPersistenceRequestedBySession] = createSignal<Record<string, boolean>>({});
  // Memoize the running-flag so the effect only re-runs when running-ness
  // actually flips, not on every metrics/ptyActive churn from session
  // polling. Without this the probe chain restarts on every status tick.
  const activeRunningSid = createMemo<string | null>(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return null;
    const s = sessionStore.sessions.find((x) => x.id === sid);
    // Vault only exists in advanced session mode (matches the vault-button gate
    // below). In standard mode SilverBullet does not run, so probing
    // HEAD /api/vault/:sid/ would 502 on a loop - gate the probe on the mode.
    if (sessionStore.preferences.sessionMode !== 'advanced') return null;
    return s && s.status === 'running' ? sid : null;
  });
  // The active-running sid as of the last effect run. When the user leaves to the
  // dashboard, sessionStore.activeSessionId is already null, so we can't read the
  // departed sid from it — remember it here to clean up the departed session's latches.
  let lastVaultSid: string | null = null;
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid) {
      // No active running session: drop any latch for the previously active
      // sid so a restart under the same id re-probes from scratch.
      const prevSid = lastVaultSid;
      if (prevSid && untrack(vaultReadyBySession)[prevSid]) {
        setVaultReadyBySession((prev) => {
          const next = { ...prev };
          delete next[prevSid];
          return next;
        });
      }
      if (prevSid) {
        clearVaultOpenIntent(prevSid);
      }
      return;
    }
    lastVaultSid = sid;

    // `untrack` so the latch reads do not subscribe the effect to its own
    // writes (steady() clears the latch on crash; tracking would spawn a
    // parallel warmup chain via effect re-run).
    const cancel = startVaultReadinessProbe({
      probe: () => probeVaultReady(sid),
      setLatch: () => setVaultReadyBySession((prev) => {
        if (prev[sid] === true) return prev;
        return { ...prev, [sid]: true };
      }),
      clearLatch: () => {
        setVaultReadyBySession((prev) => {
          if (prev[sid] !== true) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        setVaultPrewarmBySession((prev) => {
          if (!prev[sid]) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        setVaultPrewarmRetryBySession((prev) => {
          if (prev[sid] === undefined) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        clearVaultOpenIntent(sid);
      },
      initiallyReady: () => untrack(vaultReadyBySession)[sid] === true,
      warmupIntervalMs: WARMUP_INTERVAL_MS,
      steadyIntervalMs: STEADY_INTERVAL_MS,
    });
    onCleanup(cancel);
  });
  // Race a full local-readiness proof against a short timeout, so a hung local
  // query (e.g. a wedged indexedDB.databases()) falls back to "not ready" instead
  // of stalling the reload-skip decision.
  const eligibleToSkipPrewarm = async (sid: string): Promise<boolean> => {
    if (!hasVaultFullyPrewarmed(sid)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        checkVaultLocalReadiness(sid).then((proof) => proof.ready === true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), VAULT_LOCAL_READINESS_PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Best-effort, once per session: ask the browser to keep the Vault cache from
  // being evicted. Triggered on the first prewarm (click 1), not on idle mount.
  const requestVaultStoragePersistenceOnce = (sid: string) => {
    if (untrack(vaultPersistenceRequestedBySession)[sid] === true) return;
    setVaultPersistenceRequestedBySession((prev) => ({ ...prev, [sid]: true }));
    void requestBrowserStoragePersistence().then((result) => {
      if (result.supported && result.granted === false) {
        logger.warn('browser denied persistent storage for Vault cache', { sid });
      }
    }).catch((err) => logger.warn('browser storage persistence check failed', {
      sid,
      error: err instanceof Error ? err.message : String(err),
    }));
  };

  // Drop the prewarm/retry latches when the active running session goes away so a
  // restart under the same id re-derives from scratch.
  createEffect(() => {
    const sid = activeRunningSid();
    if (sid) return;
    const prevSid = lastVaultSid;
    if (prevSid && untrack(vaultPrewarmBySession)[prevSid]) {
      setVaultPrewarmBySession((prev) => {
        const next = { ...prev };
        delete next[prevSid];
        return next;
      });
      setVaultPrewarmRetryBySession((prev) => {
        if (prev[prevSid] === undefined) return prev;
        const next = { ...prev };
        delete next[prevSid];
        return next;
      });
    }
  });

  // Reload-skip (REQ-VAULT-022 AC2): a browser that already completed the full
  // prewarm proof for this session AND still has live local stores resolves
  // straight to ready — the button shows green WITHOUT a click and WITHOUT
  // remounting the bootstrap iframe (no focus contention with the terminal). A
  // session this browser never prewarmed stays 'available' until the user clicks.
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid || vaultReadyBySession()[sid] !== true) return;
    if (untrack(vaultPrewarmBySession)[sid]) return; // already has a status
    if (!hasVaultFullyPrewarmed(sid)) return;        // never prewarmed here -> needs click 1
    let cancelled = false;
    void eligibleToSkipPrewarm(sid).then((skip) => {
      if (cancelled || untrack(vaultPrewarmBySession)[sid]) return;
      if (skip) setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' }));
    });
    onCleanup(() => { cancelled = true; });
  });

  // On-demand prewarm (REQ-VAULT-018 / REQ-VAULT-020): the bootstrap iframe is
  // mounted ONLY after the user requests the vault (click 1 -> open-intent
  // 'preparing'). We never prewarm automatically — that left the user staring at
  // an empty vault for up to two minutes and forced a manual reload. Re-runs on a
  // retry-nonce bump (timeout/error) and tears the iframe down once the cycle ends.
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid || vaultReadyBySession()[sid] !== true) return;
    if (vaultOpenIntentBySession()[sid] !== 'preparing') return; // wait for click 1
    const retryNonce = vaultPrewarmRetryBySession()[sid] ?? 0;
    void retryNonce;
    const current = untrack(vaultPrewarmBySession)[sid];
    if (current === 'ready' || current === 'prewarming') return;

    setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'prewarming' }));
    requestVaultStoragePersistenceOnce(sid);

    let handle: ReturnType<typeof startVaultPrewarm> = null;
    let cancelled = false;
    const mountPrewarm = () => {
      handle = startVaultPrewarm({
        sessionId: sid,
        timeoutMs: DEFAULT_VAULT_PREWARM_TIMEOUT_MS,
        onReady: (proof) => {
          if (!proof.ready) {
            setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'error' }));
            return;
          }
          // Record that THIS browser completed the full prewarm proof (runtime +
          // space sync + index + file listing), so a later reload skips the iframe.
          markVaultFullyPrewarmed(sid);
          setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' }));
        },
        onError: (status) => setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: status })),
      });
    };
    // Even on an explicit request, skip the iframe if this browser is already fully
    // warm with live stores — opening will be instant and a remount only churns the
    // terminal focus. Otherwise mount it to build the index.
    void eligibleToSkipPrewarm(sid).then((skip) => {
      if (cancelled) return;
      if (skip) {
        setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' }));
        return;
      }
      mountPrewarm();
    });
    onCleanup(() => {
      cancelled = true;
      handle?.cancel();
      setVaultPrewarmBySession((prev) => clearPrewarmingVaultStatus(prev, sid));
    });
  });

  // A prewarm that times out / errors while requested bumps the retry nonce to
  // remount. Gated on the open-intent so a torn-down idle session never retries.
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid || vaultReadyBySession()[sid] !== true) return;
    if (vaultOpenIntentBySession()[sid] !== 'preparing') return;
    const status = vaultPrewarmBySession()[sid];
    if (status !== 'timeout' && status !== 'error') return;

    const retryTimer = setTimeout(() => {
      setVaultPrewarmRetryBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
    }, VAULT_PREWARM_RETRY_INTERVAL_MS);
    onCleanup(() => clearTimeout(retryTimer));
  });

  // Button lifecycle: idle (SB server not ready) -> available (neutral; server
  // ready, click 1 to prepare) -> preparing (accent breathe, indexing on demand)
  // -> armed (GREEN). Once the vault is ready the button is green and STAYS green
  // for the rest of the session; a warm/returning session shows green immediately
  // and opens on a single click. Green is deliberately NOT gated on any open/settle
  // latch: the mobile standalone PWA reloads on return from the vault tab, so any
  // settle-on-return state diverged per-platform and caused the green-forever
  // (mobile) vs never-green (desktop) bugs. "Ready = green, always" has no
  // reload-dependent state, so mobile / tablet / desktop behave identically.
  const vaultButtonStatus = createMemo<VaultButtonStatus>(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultReadyBySession()[sid] !== true) return 'idle';
    const intent = vaultOpenIntentBySession()[sid];
    if (intent === 'armed') return 'armed';
    const pw = vaultPrewarmBySession()[sid];
    if (intent === 'preparing') {
      if (pw === 'error') return 'error';
      if (pw === 'timeout') return 'timeout';
      return 'preparing';
    }
    // No open-intent: green (and openable on a single click) once the vault is
    // ready — warm/reload-skip or returned-from-the-vault-tab — and it stays green.
    if (pw === 'ready') return 'armed';
    return 'available';
  });

  const vaultReady = createMemo(() => vaultButtonStatus() === 'armed');

  const clearVaultOpenIntent = (sid: string) =>
    setVaultOpenIntentBySession((prev) => {
      if (prev[sid] === undefined) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });

  const openVaultTab = (sid: string) => {
    // Clear the open-intent so the button falls back to the steady green "ready"
    // state (pw === 'ready') after opening, rather than any transient armed-intent.
    clearVaultOpenIntent(sid);
    // Open via the bootstrap-hop, NOT the bare shell: the hop posts the AES key to
    // the SW and waits for activation before redirecting to the editor, so the
    // first open never races the SW's single-shot __cfRecover. The bare-shell open
    // carried the bootstrap cookie, skipped the hop, and (when the key had been
    // flushed after prewarm) lost that race -> auth-error -> top-level /.auth 403 (#3).
    window.open(`/api/vault/${sid}/.codeflare-bootstrap`, '_blank', 'noopener');
  };

  // Browser IDE: open the per-session OpenVSCode editor directly. The URL is
  // session-keyed (REQ-IDE-002) and base-path native; the host lazily starts
  // OpenVSCode on this first request and returns a warming state until it is up,
  // so no client-side readiness gate is needed (unlike the vault prewarm).
  const handleVscodeOpen = () => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    window.open(`/api/vscode/${sid}/`, '_blank', 'noopener');
  };

  const handleVaultOpen = () => {
    const sid = sessionStore.activeSessionId;
    if (!sid || untrack(vaultReadyBySession)[sid] !== true) return;
    const intent = untrack(vaultOpenIntentBySession)[sid];
    // Mid-prepare clicks are no-ops while the button breathes accent.
    if (intent === 'preparing') return;
    // Green == ready == open. Both the cold-path armed intent (click 2 after a fresh
    // prewarm) and a steady pw==='ready' (returned-from-the-vault-tab in-session, OR a
    // reload-skip from a prior session) open immediately via the bootstrap-hop. The hop
    // re-posts the AES key to the service worker and waits for activation before
    // redirecting to the editor, and the worker no longer flushes the key mid-transition
    // (REQ-VAULT-024 AC4), so opening directly never races a wiped key into a `.auth`
    // bounce. Opening synchronously inside the click gesture also avoids the pop-up
    // blocker. (Previously the pw==='ready' branch re-verified local readiness + key
    // recoverability and, on a false-negative, dropped into a full ~10s on-demand
    // re-prewarm — making every in-session reopen of the green button "re-index" before
    // opening even though the persisted store was healthy: REQ-VAULT-022 AC1.)
    if (intent === 'armed' || untrack(vaultPrewarmBySession)[sid] === 'ready') {
      openVaultTab(sid);
      return;
    }
    // Click 1 (available): start the on-demand prewarm; the button breathes accent
    // and shows the focus-loss warning until indexing completes.
    setVaultOpenIntentBySession((prev) => ({ ...prev, [sid]: 'preparing' }));
  };

  // While 'preparing', poll until the prewarm proof is ready AND the encryption key
  // is recoverable, then arm (button breathes green, next click opens). The key fetch
  // short-circuits behind the prewarm proof, so once the proof lands re-fetching
  // `/.vault-key` each tick also keeps an idle container warm until the open.
  createEffect(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultOpenIntentBySession()[sid] !== 'preparing') return;
    // Tracked read: re-run (and re-tick immediately) when the prewarm flips to ready,
    // so arming does not wait for the next poll interval.
    const prewarmReady = vaultPrewarmBySession()[sid] === 'ready';
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const ready = prewarmReady && (await checkVaultKeyRecoverable(sid));
      if (cancelled) return;
      if (ready) {
        setVaultOpenIntentBySession((prev) => (prev[sid] === 'preparing' ? { ...prev, [sid]: 'armed' } : prev));
        return;
      }
      timer = setTimeout(() => void tick(), VAULT_KEY_POLL_INTERVAL_MS);
    };
    void tick();
    onCleanup(() => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    });
  });

  // Load sessions and preferences on mount
  onMount(() => {
    sessionStore.loadSessions();
    sessionStore.loadPresets();
    sessionStore.loadPreferences();
    // Apply saved accent color
    const savedSettings = loadSettings();
    applyAccentColor(savedSettings.accentColor);
  });

  // Poll session statuses (metrics, status changes) regardless of view state
  // so dashboard cards always show fresh CPU/mem/HDD when the user returns.
  // refreshSessionStatuses() updates in-place and won't trigger viewState flips.
  onMount(() => {
    sessionStore.startSessionListPolling();
    storageStore.fetchStats();
  });

  const tiledSlotCount = (layout: TileLayout) => {
    if (layout === '4-grid') return 4;
    if (layout === '3-split') return 3;
    return layout === '2-split' ? 2 : 1;
  };

  const visibleTerminalKeys = createMemo(() => {
    const activeWorkspace = terminalWorkspaceStore.getActiveWorkspace();
    const sessionId = activeWorkspace && activeWorkspace.kind === 'session' ? activeWorkspace.sessionId : null;
    const terminals = sessionId ? sessionStore.getTerminalsForSession(sessionId) : null;
    const tiling = sessionId ? sessionStore.getTilingForSession(sessionId) : null;
    if (sessionId && terminals && tiling && tiling.enabled) {
      const activeSessionId = sessionId;
      const layout = tiling.layout;
      const tabOrder = sessionStore.getTabOrder(activeSessionId) ?? [];
      const terminalIds = new Set(terminals.tabs.map((tab) => tab.id));
      return tabOrder
        .filter((tabId) => terminalIds.has(tabId))
        .slice(0, tiledSlotCount(layout))
        .map((tabId) => `${activeSessionId}:${tabId}`);
    }
    return terminalWorkspaceStore.getVisiblePanes().map((pane) => `${pane.sessionId}:${pane.terminalId}`);
  });

  // Auto-refresh sessions + storage when tab returns from background
  const handleVisibilityChange = () => {
    if (!document.hidden) {
      sessionStore.refreshSessionStatuses?.();
      storageStore.refresh?.({ silent: true });
    }
  };
  onMount(() => document.addEventListener('visibilitychange', handleVisibilityChange));

  onCleanup(() => {
    sessionStore.stopSessionListPolling();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupDebugOverlay();
  });

  // On dashboard: schedule a full WebSocket disconnect after a grace period
  // so the Cloudflare Container can go idle.
  // On terminal: cancel scheduled disconnect and reconnect any dropped connections.
  createEffect(() => {
    if (viewState() === 'dashboard') {
      scheduleDisconnect(DASHBOARD_WS_DISCONNECT_DELAY_MS);
    } else {
      cancelScheduledDisconnect();
      reconnectDisconnectedTerminals(undefined, visibleTerminalKeys());
    }
  });

  // Reconnect stale WebSockets when the browser tab regains focus.
  // Without this, returning after ~5 min finds exhausted retry loops and
  // a stuck "Reconnecting..." overlay that only clears on full page refresh.
  {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && viewState() !== 'dashboard') {
        forceResetKeyboardState();

        if (isSamsungBrowser) {
          // Samsung: bounce through dashboard to fully reset keyboard state.
          // Samsung's VirtualKeyboard API returns stale cached values on resume
          // and no combination of signal resets fixes it reliably. The only path
          // that always works is deactivate→reactivate, which triggers the full
          // Terminal keyboard lifecycle cleanup and re-init.
          const sessionId = untrack(() => sessionStore.activeSessionId);
          if (sessionId) {
            sessionStore.setActiveSession(null);
            setViewState('dashboard');
            setTimeout(() => {
              sessionStore.setActiveSession(sessionId);
              setViewState('terminal');
              setTimeout(() => terminalStore.triggerLayoutResize(), 50);
              reconnectOnVisibilityReturn(undefined, visibleTerminalKeys());
            }, 50);
            return;
          }
        }

        setTimeout(() => {
          if (viewState() !== 'dashboard') enableVirtualKeyboardOverlay();
        }, 300);
        reconnectOnVisibilityReturn(undefined, visibleTerminalKeys());
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  }

  // viewState-derived computations
  const showTerminal = createMemo(() => viewState() === 'terminal' || viewState() === 'expanding');
  const showDashboard = createMemo(() => viewState() === 'dashboard' || viewState() === 'collapsing');

  // Sync viewState with session store
  createEffect(() => {
    const session = sessionStore.getActiveSession();
    const hasActiveTerminal = session && (session.status === 'running' || session.status === 'initializing' || sessionStore.isSessionInitializing(session.id));
    const hasActiveMultiView = terminalWorkspaceStore.getActiveWorkspace().kind === 'multiview';

    if ((hasActiveTerminal || hasActiveMultiView) && viewState() === 'dashboard') {
      setViewState('terminal');
      setTimeout(() => terminalStore.triggerLayoutResize(), 50);
    } else if (!hasActiveTerminal && !hasActiveMultiView && viewState() === 'terminal') {
      terminalWorkspaceStore.setDashboardWorkspace();
      setViewState('dashboard');
    }
  });

  // Handlers
  const enterTerminalView = () => {
    clearViewTransitionTimer();
    setViewState('expanding');
    viewTransitionTimer = setTimeout(() => {
      viewTransitionTimer = undefined;
      setViewState('terminal');
      terminalStore.triggerLayoutResize();
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const openSessionWorkspace = (id: string, shouldStart = false) => {
    const terminalId = shouldStart ? '1' : sessionStore.getTerminalsForSession(id)?.activeTabId || '1';
    sessionStore.setActiveSession(id);
    terminalWorkspaceStore.setSingleSessionWorkspace(id, terminalId);
    enterTerminalView();
    if (shouldStart) void sessionStore.startSession(id).catch(() => {});
  };

  const handleSelectSession = (id: string) => {
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (session?.status === 'running' || session?.status === 'initializing') {
      openSessionWorkspace(id);
    } else if (session?.status === 'stopped') {
      openSessionWorkspace(id, true);
    }
  };

  const handleStartSession = async (id: string) => {
    sessionStore.setActiveSession(id);
    terminalWorkspaceStore.setSingleSessionWorkspace(id, sessionStore.getTerminalsForSession(id)?.activeTabId || '1');
    enterTerminalView();
    try {
      await sessionStore.startSession(id);
    } catch (err) {
      logger.error('Failed to start session:', err);
    }
  };

  const handleStopSession = async (id: string) => {
    await sessionStore.stopSession(id);
  };

  const handleDeleteSession = async (id: string) => {
    await sessionStore.deleteSession(id);
  };

  const handleCreateSession = async (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => {
    const session = await sessionStore.createSession(name, agentType, tabConfig);
    if (session) {
      sessionStore.setActiveSession(session.id);
      terminalWorkspaceStore.setSingleSessionWorkspace(session.id, '1');
      enterTerminalView();
      // Update preferences with last-used agent type
      if (agentType) {
        sessionStore.updatePreferences({ lastAgentType: agentType });
      }
      await sessionStore.startSession(session.id);
    }
  };

  const handleOpenMultiView = () => {
    if (!terminalWorkspaceStore.openMultiView()) return;
    setShowTilingOverlay(false);
    sessionStore.setActiveSession(null);
    enterTerminalView();
  };

  const handleCloseMultiView = () => {
    terminalWorkspaceStore.closeMultiView();
    setShowTilingOverlay(false);
    clearViewTransitionTimer();
    sessionStore.setActiveSession(null);
    setViewState('dashboard');
  };

  // Handler for per-session init progress dismiss
  const handleOpenSessionById = (sessionId: string) => {
    sessionStore.dismissInitProgressForSession(sessionId);
  };

  const _handleReconnect = (sessionId: string, terminalId: string = '1') => {
    terminalStore.reconnect(sessionId, terminalId, setTerminalError);
  };

  const handleOpenDashboard = () => {
    // Keyboard cleanup is handled reactively by Terminal.tsx when props.active
    // becomes false (via onCleanup in the keyboard lifecycle effect).
    terminalWorkspaceStore.setDashboardWorkspace();
    setShowTilingOverlay(false);
    clearViewTransitionTimer();
    setViewState('collapsing');
    sessionStore.setActiveSession(null);
    viewTransitionTimer = setTimeout(() => {
      viewTransitionTimer = undefined;
      setViewState('dashboard');
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const handleDashboardSessionSelect = (sessionId: string) => {
    const session = sessionStore.sessions.find(s => s.id === sessionId);
    if (session?.status === 'running' || session?.status === 'initializing') {
      openSessionWorkspace(sessionId);
    } else if (session?.status === 'stopped') {
      // Always do a full start — even if the container could auto-wake via SDK,
      // the filesystem is empty after sleep (no R2 sync). startSession() runs
      // entrypoint.sh which restores files from R2 before starting the terminal.
      openSessionWorkspace(sessionId, true);
    }
  };

  const handleSettingsClick = () => {
    setIsStoragePanelOpen(false);
    setIsSettingsOpen(true);
  };

  const handleSettingsClose = () => {
    setIsSettingsOpen(false);
  };

  const handleStoragePanelToggle = () => {
    setIsSettingsOpen(false);
    setIsStoragePanelOpen(!isStoragePanelOpen());
  };

  const handleStoragePanelClose = () => {
    setIsStoragePanelOpen(false);
  };

  // Tiling handlers
  const handleTilingButtonClick = () => {
    setShowTilingOverlay(!showTilingOverlay());
  };

  const handleSelectTilingLayout = (layout: TileLayout) => {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) {
      sessionStore.setTilingLayout(sessionId, layout);
    }
    setShowTilingOverlay(false);
  };

  const handleCloseTilingOverlay = () => {
    setShowTilingOverlay(false);
  };

  const handleTileClick = (tabId: string) => {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) {
      sessionStore.setActiveTerminalTab(sessionId, tabId);
    }
  };

  const handleDismissError = () => {
    sessionStore.clearError();
    setTerminalError(null);
  };

  return (
    <div class="layout">
      {/* SplashCursor - layout-level so it covers header + content */}
      <SplashCursor />

      {/* Auth expiry banner — shown when background polling detects expired session */}
      <Show when={sessionStore.authExpired}>
        <div class="layout-auth-banner" data-testid="auth-expired-banner">
          <span>Session expired — please re-authenticate to continue.</span>
          <button type="button" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </Show>

      {/* Usage quota banners — dismissal persists per UTC month via localStorage. Implements REQ-SUB-018.
          REQ-ENTERPRISE-008 AC4: monthly compute quotas + the "Upgrade" CTA are a SaaS-billing concept,
          so the banners render only in SaaS mode — hidden in enterprise, onboarding, and default alike. */}
      <Show when={sessionStore.saasMode && usageWarning() === '80' && getDismissedQuotaLevel() == null}>
        <div class="layout-auth-banner layout-usage-warning" data-testid="usage-warning-80">
          <span>You've used 80% of your monthly compute quota. <a href="/app/subscribe">Upgrade plan</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('80')}>&times;</button>
        </div>
      </Show>
      <Show when={sessionStore.saasMode && usageWarning() === '95' && getDismissedQuotaLevel() !== '95'}>
        <div class="layout-auth-banner layout-usage-critical" data-testid="usage-warning-95">
          <span>You've used 95% of your monthly compute quota. <a href="/app/subscribe">Upgrade now</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('95')}>&times;</button>
        </div>
      </Show>
      <Show when={sessionStore.saasMode && usageWarning() === '100'}>
        <div class="layout-auth-banner layout-usage-exceeded" data-testid="usage-warning-100">
          <span>Monthly compute quota exceeded. Sessions cannot start until quota resets. <a href="/app/subscribe">Upgrade plan</a></span>
        </div>
      </Show>

      {/* Header - only shown when not on dashboard */}
      <Show when={!showDashboard()}>
        <Header
          userName={props.userName}
          onSettingsClick={handleSettingsClick}
          onStoragePanelToggle={handleStoragePanelToggle}
          onVaultOpen={sessionStore.activeSessionId && sessionStore.preferences.sessionMode === 'advanced'
            ? handleVaultOpen
            : undefined}
          onVscodeOpen={sessionStore.activeSessionId
            && sessionStore.preferences.sessionMode === 'advanced'
            && sessionStore.getActiveSession()?.status === 'running'
            ? handleVscodeOpen
            : undefined}
          vaultReady={vaultReady()}
          vaultStatus={vaultButtonStatus()}
          onLogoClick={showDashboard() ? undefined : handleOpenDashboard}
          sessions={sessionStore.sessions}
          activeSessionId={sessionStore.activeSessionId}
          onSelectSession={handleSelectSession}
          onStopSession={handleStopSession}
          onDeleteSession={handleDeleteSession}
          onCreateSession={handleCreateSession}
          onOpenMultiView={handleOpenMultiView}
          onCloseMultiView={handleCloseMultiView}
        />
      </Show>

      {/* Middle section - main content */}
      <div class="layout-middle">
        {/* Main content */}
        <TerminalArea
          showTerminal={showTerminal() ?? false}
          showTilingOverlay={showTilingOverlay()}
          onTilingButtonClick={handleTilingButtonClick}
          onSelectTilingLayout={handleSelectTilingLayout}
          onCloseTilingOverlay={handleCloseTilingOverlay}
          onTileClick={handleTileClick}
          onOpenSessionById={handleOpenSessionById}
          onOpenMultiView={handleOpenMultiView}
          onDashboardSessionSelect={handleDashboardSessionSelect}
          onCreateSession={handleCreateSession}
          onStartSession={handleStartSession}
          onStopSession={handleStopSession}
          onDeleteSession={handleDeleteSession}
          onTerminalError={setTerminalError}
          error={sessionStore.error || terminalError()}
          onDismissError={handleDismissError}
          viewState={viewState()}
          userName={props.userName}
          onSettingsClick={handleSettingsClick}
          enterpriseMode={props.enterpriseMode}
        />
      </div>

      {/* Settings Panel - slides in from right */}
      <SettingsPanel isOpen={isSettingsOpen()} onClose={handleSettingsClose} currentUserEmail={props.userName} currentUserRole={props.userRole} currentUserAccessTier={props.userAccessTier} enterpriseMode={props.enterpriseMode} />

      {/* Storage Panel - slides in from right */}
      <StoragePanel isOpen={isStoragePanelOpen()} onClose={handleStoragePanelClose} />

    </div>
  );
};

export default Layout;
