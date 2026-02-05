import { Component, Show, createSignal, createMemo } from 'solid-js';
import { mdiChevronDown, mdiLayersTripleOutline } from '@mdi/js';
import Icon from './Icon';
import SessionDropdown from './SessionDropdown';
import type { SessionWithStatus, SessionStatus, AgentType, TabConfig } from '../types';
import { isMobile } from '../lib/mobile';
import '../styles/session-switcher.css';

const statusDotVariant: Record<SessionStatus, 'success' | 'warning' | 'error' | 'default'> = {
  running: 'success',
  stopped: 'default',
  initializing: 'warning',
  stopping: 'warning',
  error: 'error',
};

interface SessionSwitcherProps {
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => void;
}

const SessionSwitcher: Component<SessionSwitcherProps> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);

  const activeSession = createMemo(() =>
    props.sessions.find(s => s.id === props.activeSessionId)
  );

  const dotVariant = createMemo(() => {
    const session = activeSession();
    return session ? statusDotVariant[session.status] : 'default';
  });

  const handleToggle = () => setIsOpen(!isOpen());
  const handleClose = () => setIsOpen(false);

  return (
    <div class="session-switcher-wrapper">
      <div
        class={`session-switcher ${isMobile() ? 'session-switcher--mobile' : ''}`}
        data-testid="session-switcher"
        onClick={handleToggle}
        role="button"
      >
        <Show when={isMobile()}>
          <span data-testid="session-switcher-mobile-icon">
            <Icon path={mdiLayersTripleOutline} size={22} />
          </span>
        </Show>
        <Show when={!isMobile()}>
          <span class={`session-switcher__dot session-switcher__dot--${dotVariant()}`} />
          <span class="session-switcher__name" data-testid="session-switcher-name">
            {activeSession()?.name || 'No session'}
          </span>
          <span class={`session-switcher__chevron ${isOpen() ? 'session-switcher__chevron--open' : ''}`}>
            <Icon path={mdiChevronDown} size={18} />
          </span>
        </Show>
      </div>

      <SessionDropdown
        isOpen={isOpen()}
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        onSelectSession={props.onSelectSession}
        onStopSession={props.onStopSession}
        onDeleteSession={props.onDeleteSession}
        onCreateSession={props.onCreateSession}
        onClose={handleClose}
        isMobileView={isMobile()}
      />
    </div>
  );
};

export default SessionSwitcher;
