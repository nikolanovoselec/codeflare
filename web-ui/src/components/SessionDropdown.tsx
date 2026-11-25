import { Component, Show, For, createSignal, createMemo, createEffect } from 'solid-js';
import { mdiPlus } from '@mdi/js';
import Icon from './Icon';
import SelectableSessionCard from './SelectableSessionCard';
import MultiViewActionRow from './MultiViewActionRow';
import SessionContextMenu from './SessionContextMenu';
import CreateSessionDialog from './CreateSessionDialog';
import type { MultiViewWorkspace, SessionWithStatus, SessionStatus, AgentType, TabConfig } from '../types';
import { sessionStore } from '../stores/session';
import { isSessionCardVisible, isShutdownInProgress, sessionCardStatus } from '../lib/session-presentation';
import { generateSessionName } from '../lib/session-utils';
import '../styles/session-dropdown.css';

const canSelectForMultiView = (session: SessionWithStatus) => !isShutdownInProgress(session.shutdownPhase)
  && ['running', 'initializing'].includes(sessionCardStatus(session));

const STATUS_ORDER: Record<SessionStatus, number> = {
  running: 0,
  unreachable: 1,
  starting: 2,
  initializing: 2,
  stopping: 3,
  stopped: 4,
  error: 5,
};

interface SessionDropdownProps {
  isOpen: boolean;
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => void;
  onClose: () => void;
  isMobileView: boolean;
  multiView?: {
    capacity: number;
    existing: MultiViewWorkspace | null;
    onLaunch: (sessionIds: string[]) => void;
    onOpen: () => void;
    onClose: () => void;
  };
}

const SessionDropdown: Component<SessionDropdownProps> = (props) => {
  const [menuState, setMenuState] = createSignal<{ isOpen: boolean; position: { x: number; y: number }; session: SessionWithStatus | null }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    session: null,
  });
  const visibleSessions = createMemo(() => props.sessions.filter(isSessionCardVisible));
  const menuSession = createMemo(() => visibleSessions().find((session) => session.id === menuState().session?.id));
  const menuStatus = () => { const session = menuSession(); return session && sessionCardStatus(session); };
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [createBtnRef, setCreateBtnRef] = createSignal<HTMLButtonElement>();
  const [selectingMultiView, setSelectingMultiView] = createSignal(false);
  const [selectedMultiViewIds, setSelectedMultiViewIds] = createSignal<string[]>([]);
  const [limitHit, setLimitHit] = createSignal(false);

  const sortedSessions = createMemo(() =>
    [...visibleSessions()].sort((a, b) => STATUS_ORDER[sessionCardStatus(a)] - STATUS_ORDER[sessionCardStatus(b)])
  );

  const liveSessions = createMemo(() =>
    visibleSessions().filter(canSelectForMultiView)
  );

  const multiViewDisabled = createMemo(() => !props.multiView || props.multiView.capacity < 2);
  const showMultiViewRow = createMemo(() => !multiViewDisabled() && (selectingMultiView() || liveSessions().length >= 2));
  const liveSelection = createMemo(() => selectedMultiViewIds().filter(id => liveSessions().some(s => s.id === id)));
  const canLaunchMultiView = createMemo(() => !multiViewDisabled() && liveSelection().length >= 2);
  createEffect(() => {
    if (multiViewDisabled() && selectingMultiView()) {
      setSelectingMultiView(false);
      setSelectedMultiViewIds([]);
      setLimitHit(false);
      return;
    }
    const selection = liveSelection();
    if (selection.length < selectedMultiViewIds().length) {
      setSelectedMultiViewIds(selection);
      setLimitHit(false);
    }
  });

  const beginMultiViewSelection = () => {
    const activeLive = props.activeSessionId && liveSessions().some((session) => session.id === props.activeSessionId)
      ? [props.activeSessionId]
      : [];
    setLimitHit(false);
    setSelectedMultiViewIds(activeLive);
    setSelectingMultiView(true);
  };

  const handleMultiViewAction = () => {
    const config = props.multiView;
    if (selectingMultiView()) {
      if (config && canLaunchMultiView()) {
        config.onLaunch(liveSelection());
        setSelectingMultiView(false);
        setSelectedMultiViewIds([]);
        props.onClose();
      } else {
        setSelectingMultiView(false);
        setSelectedMultiViewIds([]);
        setLimitHit(false);
      }
      return;
    }

    if (!config || multiViewDisabled()) return;
    if (config.existing) {
      config.onOpen();
      props.onClose();
      return;
    }

    beginMultiViewSelection();
  };

  const toggleMultiViewSession = (session: SessionWithStatus) => {
    if (!canSelectForMultiView(session)) return;
    const current = liveSelection();
    if (current.includes(session.id)) {
      setSelectedMultiViewIds(current.filter((id) => id !== session.id));
      setLimitHit(false);
      return;
    }
    const capacity = props.multiView?.capacity ?? 0;
    if (current.length >= capacity) {
      setLimitHit(true);
      return;
    }
    setSelectedMultiViewIds([...current, session.id]);
    setLimitHit(false);
  };

  const handleCardSelect = (session: SessionWithStatus) => {
    if (isShutdownInProgress(session.shutdownPhase)) return;
    if (selectingMultiView()) {
      toggleMultiViewSession(session);
      return;
    }
    props.onSelectSession(session.id);
    props.onClose();
  };

  const handleMenuClick = (e: MouseEvent, session: SessionWithStatus) => {
    setMenuState({
      isOpen: true,
      position: { x: e.clientX, y: e.clientY },
      session,
    });
  };

  const handleMenuClose = () => {
    setMenuState({ isOpen: false, position: { x: 0, y: 0 }, session: null });
  };

  createEffect(() => {
    if (menuState().isOpen && !menuSession()) handleMenuClose();
  });

  const handleAgentSelect = (agentType: AgentType, tabConfig?: TabConfig[]) => {
    setShowCreateDialog(false);
    const name = generateSessionName(agentType, props.sessions);
    props.onCreateSession(name, agentType, tabConfig);
    props.onClose();
  };

  return (
    <Show when={props.isOpen}>
      <div class="session-dropdown__backdrop" onClick={props.onClose} />
      <div
        class={`session-dropdown ${props.isMobileView ? 'session-dropdown--bottom-sheet' : 'session-dropdown--popover'}`}
        data-testid="session-dropdown"
      >
        <button
          type="button"
          ref={setCreateBtnRef}
          class="session-dropdown__new-session"
          data-testid="session-dropdown-new"
          disabled={sessionStore.preseedUpgrading || sessionStore.preseedUpgradeFailed || sessionStore.managedReleaseStatus === 'upgrading' || sessionStore.managedReleaseStatus === 'update_pending'}
          aria-label={sessionStore.managedReleaseStatus === 'update_pending' ? 'Session environment update pending until session stops' : sessionStore.preseedUpgrading || sessionStore.managedReleaseStatus === 'upgrading' ? 'Updating session environment' : 'New Session'}
          onClick={() => setShowCreateDialog(!showCreateDialog())}
        >
          <Icon path={mdiPlus} size={16} />
          <span>{sessionStore.managedReleaseStatus === 'update_pending' ? 'Update pending' : sessionStore.preseedUpgrading || sessionStore.managedReleaseStatus === 'upgrading' ? 'Updating' : 'New Session'}</span>
        </button>

        <Show when={showMultiViewRow()}>
          <MultiViewActionRow
            mode={selectingMultiView() ? 'selecting' : props.multiView?.existing ? 'open' : 'start'}
            canLaunch={canLaunchMultiView()}
            disabled={!selectingMultiView() && multiViewDisabled()}
            onClick={handleMultiViewAction}
            onClose={() => {
              props.multiView?.onClose();
              setSelectingMultiView(false);
              setSelectedMultiViewIds([]);
              props.onClose();
            }}
          />
          <div
            data-testid="session-dropdown-multiview-limit"
            data-visible={limitHit() ? 'true' : 'false'}
            class="session-dropdown__multiview-limit"
          >
            MultiView selection limit reached.
          </div>
        </Show>

        <div class="session-dropdown__list">
          <For each={sortedSessions()}>
            {(session) => {
              const selected = createMemo(() => liveSelection().includes(session.id));
              const disabled = createMemo(() =>
                selectingMultiView() && !canSelectForMultiView(session)
              );
              return (
                <SelectableSessionCard
                  session={session}
                  isActive={session.id === props.activeSessionId}
                  selected={selected()}
                  selecting={selectingMultiView()}
                  disabled={disabled()}
                  onSelect={() => handleCardSelect(session)}
                  onStop={() => props.onStopSession(session.id)}
                  onDelete={() => props.onDeleteSession(session.id)}
                  onMenuClick={handleMenuClick}
                />
              );
            }}
          </For>
        </div>
      </div>

      <CreateSessionDialog
        isOpen={showCreateDialog()}
        onClose={() => setShowCreateDialog(false)}
        onSelect={handleAgentSelect}
        anchorRef={createBtnRef()}
      />

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
            onKill={() => { const session = menuSession(); if (session) void sessionStore.killSession(session.id); }}
            stopLabel={menuStatus() === 'stopping' ? 'Retry Stop' : 'Stop'}
            sessionName={menuState().session?.name || ''}
            onStop={() => { if (menuState().session) props.onStopSession(menuState().session!.id); }}
            canDelete={menuSession()?.shutdownPhase !== 'memory-not-merged'}
            onDelete={() => { if (menuSession()?.id === id) props.onDeleteSession(id); }}
            onRename={(name) => { if (menuState().session) void sessionStore.renameSession(menuState().session!.id, name); }}
            onClose={handleMenuClose}
          />
        )}
      </Show>
    </Show>
  );
};

export default SessionDropdown;
