import { Component, Show, For, createSignal, createMemo } from 'solid-js';
import { mdiPlus } from '@mdi/js';
import Icon from './Icon';
import SelectableSessionCard from './SelectableSessionCard';
import MultiViewActionRow from './MultiViewActionRow';
import SessionContextMenu from './SessionContextMenu';
import CreateSessionDialog from './CreateSessionDialog';
import type { MultiViewWorkspace, SessionWithStatus, SessionStatus, AgentType, TabConfig } from '../types';
import { sessionStore } from '../stores/session';
import { generateSessionName } from '../lib/session-utils';
import '../styles/session-dropdown.css';

const STATUS_ORDER: Record<SessionStatus, number> = {
  running: 0,
  initializing: 1,
  stopping: 2,
  stopped: 3,
  error: 4,
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
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [createBtnRef, setCreateBtnRef] = createSignal<HTMLButtonElement>();
  const [selectingMultiView, setSelectingMultiView] = createSignal(false);
  const [selectedMultiViewIds, setSelectedMultiViewIds] = createSignal<string[]>([]);
  const [limitHit, setLimitHit] = createSignal(false);

  const sortedSessions = createMemo(() =>
    [...props.sessions].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  );

  const liveSessions = createMemo(() =>
    props.sessions.filter((session) => session.status === 'running' || session.status === 'initializing')
  );

  const showMultiViewRow = createMemo(() => Boolean(props.multiView) && (props.multiView?.capacity ?? 0) >= 2 && liveSessions().length >= 2);
  const multiViewDisabled = createMemo(() => !props.multiView || props.multiView.capacity < 2);
  const canLaunchMultiView = createMemo(() => selectedMultiViewIds().length >= 2);

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
    if (!config || multiViewDisabled()) return;

    if (selectingMultiView()) {
      if (canLaunchMultiView()) {
        config.onLaunch(selectedMultiViewIds());
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

    if (config.existing) {
      config.onOpen();
      props.onClose();
      return;
    }

    beginMultiViewSelection();
  };

  const toggleMultiViewSession = (session: SessionWithStatus) => {
    if (session.status !== 'running' && session.status !== 'initializing') return;
    const current = selectedMultiViewIds();
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
          disabled={sessionStore.preseedUpgrading}
          onClick={() => setShowCreateDialog(!showCreateDialog())}
        >
          <Icon path={mdiPlus} size={16} />
          <span>{sessionStore.preseedUpgrading ? 'Upgrading' : 'New Session'}</span>
        </button>

        <Show when={showMultiViewRow()}>
          <MultiViewActionRow
            mode={selectingMultiView() ? 'selecting' : props.multiView?.existing ? 'open' : 'start'}
            canLaunch={canLaunchMultiView()}
            disabled={multiViewDisabled()}
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
              const selected = createMemo(() => selectedMultiViewIds().includes(session.id));
              const disabled = createMemo(() =>
                selectingMultiView() && session.status !== 'running' && session.status !== 'initializing'
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

      <SessionContextMenu
        isOpen={menuState().isOpen}
        position={menuState().position}
        canStop={menuState().session ? (menuState().session!.status === 'running' || menuState().session!.status === 'initializing') : false}
        sessionName={menuState().session?.name || ''}
        onStop={() => { if (menuState().session) props.onStopSession(menuState().session!.id); }}
        onDelete={() => { if (menuState().session) props.onDeleteSession(menuState().session!.id); }}
        onClose={handleMenuClose}
      />
    </Show>
  );
};

export default SessionDropdown;
