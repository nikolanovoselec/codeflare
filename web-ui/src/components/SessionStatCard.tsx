import { Component, For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { mdiConsole, mdiChip, mdiMemory, mdiHarddisk, mdiDotsVertical, mdiClockTimeEightOutline } from '@mdi/js';
import Icon from './Icon';
import Button from './ui/Button';
import { resolveTerminalMode, type SessionWithStatus, type SessionStatus, type ShutdownPhase } from '../types';
import { sessionStore } from '../stores/session';
import { terminalStore } from '../stores/terminal';
import { AGENT_ICON_MAP } from '../lib/terminal-config';
import { getSleepTimerInfo } from '../lib/sleep-timer';
import { isShutdownInProgress, sessionCardStatus, terminalPresentation, vscodePresentation, type BackendLifecycle } from '../lib/session-presentation';
import '../styles/stat-cards.css';
import '../styles/session-stat-card.css';

const statusDotVariant: Record<SessionStatus, 'success' | 'warning' | 'error' | 'default' | 'idle'> = {
  running: 'success',
  stopped: 'default',
  starting: 'warning',
  unreachable: 'warning',
  initializing: 'warning',
  stopping: 'warning',
  error: 'error',
};

const statusPulses: Record<SessionStatus, boolean> = {
  running: true,
  stopped: false,
  starting: true,
  unreachable: true,
  initializing: true,
  stopping: true,
  error: false,
};

const shutdownLabels: Record<ShutdownPhase, string> = {
  queued: 'Memory consolidation pending',
  saving: 'Memory consolidation pending',
  consolidating: 'Consolidating memory',
  finishing: '',
  'memory-not-merged': 'Memory consolidation failed',
};

interface SessionStatCardProps {
  session: SessionWithStatus;
  vaultAction?: JSX.Element;
  isActive: boolean;
  resumeDisabled?: boolean;
  onSelect: () => void;
  onStop: () => void;
  onDelete: () => void;
  onMenuClick?: (e: MouseEvent, session: SessionWithStatus) => void;
}

const SessionStatCard: Component<SessionStatCardProps> = (props) => {
  const phase = () => props.session.shutdownPhase;
  const shutdownLabel = () => {
    const current = phase();
    return current && shutdownLabels[current];
  };
  const shutdownInProgress = () => isShutdownInProgress(phase());
  const showsShutdownSubtitle = () => !!shutdownLabel();
  const memoryNotMerged = () => phase() === 'memory-not-merged';
  const cardStatus = () => sessionCardStatus(props.session);
  const metrics = createMemo(() => {
    if (phase() === 'queued' && props.session.status === 'stopped') return undefined;
    const sample = sessionStore.getMetricsForSession(props.session.id);
    return sample && sample.generation === props.session.generation ? sample : undefined;
  });
  const wsState = () => {
    const terminalId = resolveTerminalMode(props.session.terminalMode) === 'herdr'
      ? '1'
      : sessionStore.getTerminalsForSession(props.session.id)?.activeTabId || '1';
    return terminalStore.getConnectionState(props.session.id, terminalId);
  };
  const lifecyclePresentation = createMemo(() => {
    const status = cardStatus();
    const lifecycle = (status === 'initializing' || status === 'error' ? 'running' : status) as BackendLifecycle;
    return props.session.workspace === 'vscode'
      ? vscodePresentation({ lifecycle, editorReady: props.session.editorReady }, { transportReachable: true })
      : terminalPresentation({ lifecycle, editorReady: props.session.editorReady }, { terminalConnected: wsState() === 'connected' });
  });
  const lifecycleLabel = () => {
    const presentation = lifecyclePresentation();
    return 'label' in presentation ? presentation.label : `Session ${cardStatus()}`;
  };
  const dotVariant = () => {
    if (shutdownInProgress()) return 'warning';
    if (memoryNotMerged()) return 'error';
    if (props.session.workspace === 'vscode') {
      if (cardStatus() === 'error' || props.session.editorReadyError === true) return 'error';
      if (cardStatus() === 'running' || cardStatus() === 'unreachable') return props.session.editorReady === true ? 'success' : 'default';
      return statusDotVariant[cardStatus()];
    }
    if (cardStatus() === 'running' && wsState() !== 'connected') {
      return 'idle'; // Blue IDLE is local to this device's terminal socket.
    }
    return statusDotVariant[cardStatus()];
  };
  const isPulsing = () => !phase()
    && !(props.session.workspace === 'vscode' && dotVariant() === 'error')
    && statusPulses[cardStatus()];
  const isActionable = () => props.session.workspace !== 'vscode'
    || cardStatus() === 'stopped'
    || cardStatus() === 'error'
    || props.session.editorReadyError === true
    || ((cardStatus() === 'running' || cardStatus() === 'unreachable') && props.session.editorReady === true);
  const managedSeedUpdateActive = () => sessionStore.preseedUpgrading
    || sessionStore.managedReleaseStatus === 'update_pending'
    || sessionStore.managedReleaseStatus === 'upgrading';
  const isStoppedForManagedSeedUpdate = () => managedSeedUpdateActive()
    && cardStatus() === 'stopped';
  const canRecoverMemory = () => memoryNotMerged() && cardStatus() === 'stopped'
    && !sessionStore.isMemoryRetryPending(props.session.id) && !isStoppedForManagedSeedUpdate();
  const isSelectionEnabled = () => memoryNotMerged()
    ? canRecoverMemory() && !props.resumeDisabled
    : isActionable() && !phase() && !isStoppedForManagedSeedUpdate();
  const select = () => {
    if (!isSelectionEnabled()) return;
    props.onSelect();
  };

  // Tick signal forces timer recomputation every 15s (Date.now() isn't reactive)
  const [timerTick, setTimerTick] = createSignal(0);
  const timerInterval = setInterval(() => setTimerTick(t => t + 1), 15_000);
  onCleanup(() => clearInterval(timerInterval));

  const timerInfo = createMemo(() => {
    timerTick(); // subscribe to tick
    if (cardStatus() !== 'running') return null;
    return getSleepTimerInfo(props.session.lastActiveAt, sessionStore.preferences.sleepAfter);
  });
  const [showTimerTooltip, setShowTimerTooltip] = createSignal(false);

  const getProgress = (): number => {
    const progress = sessionStore.getInitProgressForSession(props.session.id);
    return progress?.progress || 0;
  };

  return (
    <div
      class={`stat-card session-stat-card ${props.isActive ? 'session-stat-card--active' : ''} ${isSelectionEnabled() ? '' : 'session-stat-card--selection-disabled'} ${showsShutdownSubtitle() ? 'session-stat-card--shutting-down' : ''} ${memoryNotMerged() ? 'session-stat-card--recovery' : ''}`}
      data-testid={`session-stat-card-${props.session.id}`}
      data-status={cardStatus()}
      style={isStoppedForManagedSeedUpdate() && !shutdownInProgress() ? { opacity: 0.6, 'pointer-events': 'none' } : {}}
    >
      <Show when={isSelectionEnabled()}>
        <button
          type="button"
          class="session-stat-card__selector"
          data-testid={`session-stat-card-${props.session.id}-select`}
          aria-label={`${memoryNotMerged() ? 'Resume' : 'Activate'} session ${props.session.name}`}
          onClick={select}
        />
      </Show>
      <div class="stat-card__header">
        <span class="stat-card__icon">
          <Icon path={AGENT_ICON_MAP[props.session.agentType || ''] || mdiConsole} size={14} />
        </span>
        <span class="stat-card__title type-section-header session-stat-card__name">{props.session.name}</span>
        <Show when={props.vaultAction} keyed>{action => (
          <div class="session-stat-card__vault">{action}</div>
        )}</Show>
        <span
          class={`session-stat-card__dot session-stat-card__dot--${dotVariant()} ${isPulsing() ? 'session-stat-card__dot--pulse' : ''}`}
          role={phase() ? undefined : 'status'}
          aria-label={phase() ? undefined : props.session.workspace === 'vscode'
            ? `Session ${cardStatus()}`
            : lifecycleLabel()}
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
          aria-label="Session actions"
          onClick={(e) => {
            e.stopPropagation();
            props.onMenuClick?.(e, props.session);
          }}
        >
          <Icon path={mdiDotsVertical} size={16} />
        </button>
      </div>

      <Show when={shutdownInProgress() || memoryNotMerged()}>
        <div class="session-stat-card__shutdown-notice" role="status" aria-label={shutdownLabel() || 'Shutting down'}>
          <Show when={shutdownLabel()} fallback={<span class="session-stat-card__announcement">Shutting down</span>}>
            {label => <For each={label().split(' ')}>{word => (
              <span class="session-stat-card__subtitle-word"><span>{word}</span></span>
            )}</For>}
          </Show>
        </div>
      </Show>

      <div class="session-stat-card__body">
        <Show when={shutdownInProgress() || memoryNotMerged() || cardStatus() === 'running' || metrics()}>
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
        <Show when={!shutdownInProgress() && props.session.status === 'initializing'}>
          <div class="progress-bar progress-bar-thin progress-bar-animated session-stat-card__progress">
            <div
              class="progress-bar-fill"
              style={{ width: `${getProgress()}%` }}
              data-testid={`session-stat-card-${props.session.id}-progress`}
            />
          </div>
        </Show>
      </div>
      <Show when={memoryNotMerged()}>
        <div class="session-stat-card__retry">
          <Button size="sm" disabled={!canRecoverMemory() || props.session.snapshotUnavailable}
            onClick={() => void sessionStore.retryMemoryConsolidation(props.session.id)}>
            Retry
          </Button>
        </div>
      </Show>
    </div>
  );
};

export default SessionStatCard;
