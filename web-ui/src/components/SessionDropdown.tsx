import { Component, Show, For, createSignal, createMemo } from 'solid-js';
import { mdiPlus } from '@mdi/js';
import Icon from './Icon';
import SessionStatCard from './SessionStatCard';
import SessionContextMenu from './SessionContextMenu';
import CreateSessionDialog from './CreateSessionDialog';
import type { SessionWithStatus, SessionStatus, AgentType, TabConfig } from '../types';
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
}

const SessionDropdown: Component<SessionDropdownProps> = (props) => {
  const [menuState, setMenuState] = createSignal<{ isOpen: boolean; position: { x: number; y: number }; session: SessionWithStatus | null }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    session: null,
  });
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [createBtnRef, setCreateBtnRef] = createSignal<HTMLButtonElement>();

  const sortedSessions = createMemo(() =>
    [...props.sessions].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  );

  const handleCardSelect = (id: string) => {
    props.onSelectSession(id);
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
          onClick={() => setShowCreateDialog(!showCreateDialog())}
        >
          <Icon path={mdiPlus} size={16} />
          <span>New Session</span>
        </button>

        <div class="session-dropdown__list">
          <For each={sortedSessions()}>
            {(session) => (
              <SessionStatCard
                session={session}
                isActive={session.id === props.activeSessionId}
                onSelect={() => handleCardSelect(session.id)}
                onStop={() => props.onStopSession(session.id)}
                onDelete={() => props.onDeleteSession(session.id)}
                onMenuClick={handleMenuClick}
              />
            )}
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
