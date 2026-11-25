import { Component, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { mdiConsole, mdiChip, mdiMemory, mdiHarddisk, mdiDotsVertical, mdiClockTimeEightOutline } from '@mdi/js';
import Icon from './Icon';
import Button from './ui/Button';
import { resolveTerminalMode, type SessionWithStatus, type SessionStatus, type ShutdownPhase } from '../types';
import { sessionStore } from '../stores/session';
import { terminalStore } from '../stores/terminal';
import { AGENT_ICON_MAP } from '../lib/terminal-config';
import { getSleepTimerInfo } from '../lib/sleep-timer';
import { isShutdownInProgress, terminalPresentation, vscodePresentation, type BackendLifecycle } from '../lib/session-presentation';
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

// The runtime normally samples once per minute. Allow one card clock tick for delivery.
const METRICS_FRESHNESS_MS = 75_000;

const shutdownLabels: Record<ShutdownPhase, string> = {
  queued: 'Memory consolidation pending...',
  saving: 'Shutting down. Saving session files',
  consolidating: 'Consolidating memory...',
  finishing: 'Shutting down. Finishing',
  'memory-not-merged': 'Stopped · memory not merged',
};

interface SessionStatCardProps {
  session: SessionWithStatus;
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
  const memoryNotMerged = () => phase() === 'memory-not-merged';
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
    const lifecycle = (props.session.status === 'initializing' || props.session.status === 'error'
      ? 'running'
      : props.session.status) as BackendLifecycle;
    return props.session.workspace === 'vscode'
      ? vscodePresentation({ lifecycle, editorReady: props.session.editorReady }, { transportReachable: true })
      : terminalPresentation({ lifecycle, editorReady: props.session.editorReady }, { terminalConnected: wsState() === 'connected' });
  });
  const lifecycleLabel = () => {
    const presentation = lifecyclePresentation();
    return 'label' in presentation ? presentation.label : `Session ${props.session.status}`;
  };
  const dotVariant = () => {
    if (shutdownInProgress()) return 'warning';
    if (memoryNotMerged()) return 'error';
    if (props.session.workspace === 'vscode') {
      if (props.session.status === 'error' || props.session.editorReadyError === true) return 'error';
      if (props.session.status === 'running' || props.session.status === 'unreachable') return props.session.editorReady === true ? 'success' : 'default';
      return statusDotVariant[props.session.status];
    }
    if (props.session.status === 'running' && wsState() !== 'connected') {
      return 'idle'; // Blue IDLE is local to this device's terminal socket.
    }
    return statusDotVariant[props.session.status];
  };
  const isPulsing = () => !phase()
    && !(props.session.workspace === 'vscode' && dotVariant() === 'error')
    && statusPulses[props.session.status];
  const isActionable = () => props.session.workspace !== 'vscode'
    || props.session.status === 'stopped'
    || props.session.status === 'error'
    || props.session.editorReadyError === true
    || ((props.session.status === 'running' || props.session.status === 'unreachable') && props.session.editorReady === true);
  const managedSeedUpdateActive = () => sessionStore.preseedUpgrading
    || sessionStore.managedReleaseStatus === 'update_pending'
    || sessionStore.managedReleaseStatus === 'upgrading';
  const isStoppedForManagedSeedUpdate = () => managedSeedUpdateActive()
    && props.session.status === 'stopped';
  const isSelectionEnabled = () => isActionable() && !phase() && !isStoppedForManagedSeedUpdate();
  const canRecoverMemory = () => memoryNotMerged() && props.session.status === 'stopped'
    && !sessionStore.isMemoryRetryPending(props.session.id) && !isStoppedForManagedSeedUpdate();
  const select = () => {
    if (!isSelectionEnabled()) return;
    props.onSelect();
  };

  // Tick signal forces timer recomputation every 15s (Date.now() isn't reactive)
  const [timerTick, setTimerTick] = createSignal(0);
  const timerInterval = setInterval(() => setTimerTick(t => t + 1), 15_000);
  onCleanup(() => clearInterval(timerInterval));

  const metricsNotice = () => {
    timerTick();
    const readings = metrics();
    if (![readings?.cpu, readings?.mem, readings?.hdd].some(value => value && value !== '...')) return 'Metrics unavailable';
    const lifecycle = props.session.lifecycle ?? props.session.status;
    const age = Date.now() - Date.parse(readings?.updatedAt ?? '');
    const confirmed = readings?.statusReadVersion !== undefined
      && readings.statusReadVersion === sessionStore.completedStatusReadVersion;
    return confirmed && lifecycle === 'running' && age >= 0 && age <= METRICS_FRESHNESS_MS
      ? undefined : 'Last known metrics';
  };

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
      class={`stat-card session-stat-card ${props.isActive ? 'session-stat-card--active' : ''} ${isSelectionEnabled() ? '' : 'session-stat-card--selection-disabled'} ${shutdownInProgress() ? 'session-stat-card--shutting-down' : ''}`}
      data-testid={`session-stat-card-${props.session.id}`}
      data-status={props.session.status}
      style={isStoppedForManagedSeedUpdate() && !shutdownInProgress() ? { opacity: 0.6, 'pointer-events': 'none' } : {}}
    >
      <Show when={isSelectionEnabled()}>
        <button
          type="button"
          class="session-stat-card__selector"
          data-testid={`session-stat-card-${props.session.id}-select`}
          aria-label={`Activate session ${props.session.name}`}
          onClick={select}
        />
      </Show>
      <div class="stat-card__header">
        <span class="stat-card__icon">
          <Icon path={AGENT_ICON_MAP[props.session.agentType || ''] || mdiConsole} size={14} />
        </span>
        <span class="stat-card__title type-section-header session-stat-card__name">{props.session.name}</span>
        <span
          class={`session-stat-card__dot session-stat-card__dot--${dotVariant()} ${isPulsing() ? 'session-stat-card__dot--pulse' : ''}`}
          role={phase() ? undefined : 'status'}
          aria-label={phase() ? undefined : props.session.workspace === 'vscode'
            ? `Session ${props.session.status}`
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

      <div class="session-stat-card__body">
        <Show when={!memoryNotMerged()} fallback={
          <div class="session-stat-card__shutdown">
            <div role="status">
              <div class="session-stat-card__phase">{shutdownLabel()}</div>
              <div>{props.session.snapshotUnavailable
                ? (props.session.pendingDelete ? 'Saved memory unavailable. Not deleted.' : 'Saved memory unavailable.')
                : (props.session.pendingDelete ? 'Files saved. Not deleted.' : 'Session files were saved.')}</div>
            </div>
            <div class="session-stat-card__actions">
              <Button size="sm" disabled={!canRecoverMemory() || props.session.snapshotUnavailable}
                onClick={() => void sessionStore.retryMemoryConsolidation(props.session.id)}>
                Retry memory consolidation
              </Button>
              <Button size="sm" variant="secondary" disabled={!canRecoverMemory() || props.resumeDisabled}
                onClick={() => { if (canRecoverMemory() && !props.resumeDisabled) props.onSelect(); }}>
                Resume session
              </Button>
            </div>
          </div>
        }>
          <Show when={shutdownInProgress() || props.session.status === 'running' || metrics()}>
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
        </Show>
        <Show when={shutdownInProgress()}>
          <div class="session-stat-card__shutdown-notice" role="status">
            <span class="session-stat-card__phase">
              {shutdownLabel()}
              <Show when={metricsNotice()}>{notice => <small class="session-stat-card__metrics-note">{notice()}</small>}</Show>
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SessionStatCard;
