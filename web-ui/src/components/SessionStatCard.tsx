import { Component, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { mdiConsole, mdiChip, mdiMemory, mdiHarddisk, mdiDotsVertical, mdiClockTimeEightOutline } from '@mdi/js';
import Icon from './Icon';
import type { SessionWithStatus, SessionStatus } from '../types';
import { sessionStore } from '../stores/session';
import { terminalStore } from '../stores/terminal';
import { AGENT_ICON_MAP } from '../lib/terminal-config';
import { getSleepTimerInfo } from '../lib/sleep-timer';
import '../styles/stat-cards.css';
import '../styles/session-stat-card.css';

const statusDotVariant: Record<SessionStatus, 'success' | 'warning' | 'error' | 'default'> = {
  running: 'success',
  stopped: 'default',
  initializing: 'warning',
  stopping: 'warning',
  error: 'error',
};

const statusPulses: Record<SessionStatus, boolean> = {
  running: true,
  stopped: false,
  initializing: true,
  stopping: true,
  error: false,
};

interface SessionStatCardProps {
  session: SessionWithStatus;
  isActive: boolean;
  onSelect: () => void;
  onStop: () => void;
  onDelete: () => void;
  onMenuClick?: (e: MouseEvent, session: SessionWithStatus) => void;
}

const SessionStatCard: Component<SessionStatCardProps> = (props) => {
  const metrics = createMemo(() => sessionStore.getMetricsForSession(props.session.id));
  const wsState = () => terminalStore.getConnectionState(props.session.id, '1');
  const dotVariant = () => {
    if (props.session.status === 'running' && wsState() !== 'connected') {
      return 'warning'; // Yellow — container alive, WS disconnected
    }
    return statusDotVariant[props.session.status];
  };
  const isPulsing = () => statusPulses[props.session.status];

  // Tick signal forces timer recomputation every 15s (Date.now() isn't reactive)
  const [timerTick, setTimerTick] = createSignal(0);
  const timerInterval = setInterval(() => setTimerTick(t => t + 1), 15_000);
  onCleanup(() => clearInterval(timerInterval));

  const timerInfo = createMemo(() => {
    timerTick(); // subscribe to tick
    if (props.session.status !== 'running') return null;
    return getSleepTimerInfo(props.session.lastActiveAt, sessionStore.preferences.sleepAfter);
  });
  const [showTimerTooltip, setShowTimerTooltip] = createSignal(false);

  const getProgress = (): number => {
    const progress = sessionStore.getInitProgressForSession(props.session.id);
    return progress?.progress || 0;
  };

  return (
    <div
      class={`stat-card session-stat-card ${props.isActive ? 'session-stat-card--active' : ''}`}
      data-testid={`session-stat-card-${props.session.id}`}
      data-status={props.session.status}
      style={sessionStore.preseedUpgrading && props.session.status === 'stopped' ? { opacity: 0.6, 'pointer-events': 'none' } : {}}
      onClick={() => { if (sessionStore.preseedUpgrading && props.session.status === 'stopped') return; props.onSelect(); }}
    >
      <div class="stat-card__header">
        <span class="stat-card__icon">
          <Icon path={AGENT_ICON_MAP[props.session.agentType || ''] || mdiConsole} size={14} />
        </span>
        <span class="stat-card__title type-section-header session-stat-card__name">{props.session.name}</span>
        <span
          class={`session-stat-card__dot session-stat-card__dot--${dotVariant()} ${isPulsing() ? 'session-stat-card__dot--pulse' : ''}`}
        />
        <Show when={timerInfo()}>
          {(info) => (
            <>
              <button
                type="button"
                class={`session-stat-card__timer session-stat-card__timer--${info().severity}`}
                data-testid={`session-stat-card-${props.session.id}-timer`}
                title={info().bucket}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTimerTooltip(!showTimerTooltip());
                }}
              >
                <Icon path={mdiClockTimeEightOutline} size={14} />
              </button>
              <Show when={showTimerTooltip()}>
                <span
                  class="session-stat-card__timer-tooltip"
                  onClick={(e) => { e.stopPropagation(); setShowTimerTooltip(false); }}
                >
                  {timerInfo()?.bucket} remaining. Session stops after idle timeout. Tracks time since last terminal input. Configurable in Settings.
                </span>
              </Show>
            </>
          )}
        </Show>
        <button
          type="button"
          class="session-stat-card__menu-trigger"
          data-testid={`session-stat-card-${props.session.id}-menu`}
          title="Session actions"
          onClick={(e) => {
            e.stopPropagation();
            props.onMenuClick?.(e, props.session);
          }}
        >
          <Icon path={mdiDotsVertical} size={16} />
        </button>
      </div>

      <Show when={props.session.status === 'running' || metrics()}>
        <div class="stat-card__metrics">
          <div class="stat-card__metric" data-testid={`session-stat-card-${props.session.id}-metric-cpu`}>
            <span class="stat-card__metric-label">
              <Icon path={mdiChip} size={12} />
              CPU
            </span>
            <span class="stat-card__metric-value">{metrics()?.cpu || '...'}</span>
          </div>
          <div class="stat-card__metric" data-testid={`session-stat-card-${props.session.id}-metric-mem`}>
            <span class="stat-card__metric-label">
              <Icon path={mdiMemory} size={12} />
              MEM
            </span>
            <span class="stat-card__metric-value">{metrics()?.mem || '...'}</span>
          </div>
          <div class="stat-card__metric" data-testid={`session-stat-card-${props.session.id}-metric-hdd`}>
            <span class="stat-card__metric-label">
              <Icon path={mdiHarddisk} size={12} />
              HDD
            </span>
            <span class="stat-card__metric-value">{metrics()?.hdd || '...'}</span>
          </div>
        </div>
      </Show>

      <Show when={props.session.status === 'initializing'}>
        <div class="progress-bar progress-bar-thin progress-bar-animated session-stat-card__progress">
          <div
            class="progress-bar-fill"
            style={{ width: `${getProgress()}%` }}
            data-testid={`session-stat-card-${props.session.id}-progress`}
          />
        </div>
      </Show>
    </div>
  );
};

export default SessionStatCard;
