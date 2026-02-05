import { Component, For, createSignal, onCleanup } from 'solid-js';
import {
  mdiPlus,
} from '@mdi/js';
import Icon from './Icon';
import SessionCard from './SessionCard';
import CreateSessionDialog from './CreateSessionDialog';
import TipsRotator from './TipsRotator';
import type { SessionWithStatus, AgentType, TabConfig } from '../types';
import { DURATION_REFRESH_INTERVAL_MS } from '../lib/constants';
import { generateSessionName } from '../lib/session-utils';
import { logger } from '../lib/logger';
import '../styles/session-list.css';

interface SessionListProps {
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStartSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => Promise<void> | void;
  onReconnect?: (id: string) => void;
  onPinSidebar?: (pinned: boolean) => void;
}

const SessionList: Component<SessionListProps> = (props) => {
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [createBtnRef, setCreateBtnRef] = createSignal<HTMLButtonElement>();

  // Update duration displays periodically
  const [, setTick] = createSignal(0);
  const interval = setInterval(() => setTick(t => t + 1), DURATION_REFRESH_INTERVAL_MS);
  onCleanup(() => clearInterval(interval));

  const handleAgentSelect = async (agentType: AgentType, tabConfig?: TabConfig[]) => {
    setShowCreateDialog(false);
    props.onPinSidebar?.(false);
    const name = generateSessionName(agentType, props.sessions);
    try {
      await props.onCreateSession(name, agentType, tabConfig);
    } catch (err) {
      logger.error('Failed to create session', err);
    }
  };

  return (
    <div class="session-list">
      <div class="session-list-header">
        <h3>Sessions</h3>
      </div>

      <TipsRotator />

      <div class="session-list-items">
        <For each={props.sessions}>
          {(session, index) => (
            <SessionCard
              session={session}
              index={index}
              isActive={session.id === props.activeSessionId}
              onSelect={() => props.onSelectSession(session.id)}
              onStop={() => props.onStopSession(session.id)}
              onDelete={() => props.onDeleteSession(session.id)}
              onReconnect={props.onReconnect ? () => props.onReconnect!(session.id) : undefined}
            />
          )}
        </For>
      </div>

      <div class="session-list-footer">
          <CreateSessionDialog
            isOpen={showCreateDialog()}
            onClose={() => {
              setShowCreateDialog(false);
              props.onPinSidebar?.(false);
            }}
            onSelect={handleAgentSelect}
            anchorRef={createBtnRef()}
          />
          <button
            type="button"
            ref={setCreateBtnRef}
            class="session-create-btn"
            onClick={() => {
              const newState = !showCreateDialog();
              setShowCreateDialog(newState);
              props.onPinSidebar?.(newState);
            }}
            data-testid="session-create-btn"
          >
            <Icon path={mdiPlus} size={16} />
            <span>New Session</span>
          </button>
      </div>
    </div>
  );
};

export default SessionList;
