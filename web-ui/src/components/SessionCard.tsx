import { Component, Show, Accessor, createMemo, createSignal } from 'solid-js';
import {
  mdiStop,
  mdiTrashCanOutline,
  mdiPencilOutline,
  mdiConsole,
  mdiChip,
  mdiMemory,
  mdiHarddisk,
  mdiCloudOutline,
  mdiClockOutline,
} from '@mdi/js';
import Icon from './Icon';
import type { SessionWithStatus, SessionStatus, TerminalConnectionState } from '../types';
import { sessionStore } from '../stores/session';
import { sendInputToTerminal } from '../stores/terminal';
import '../styles/stat-cards.css';
import '../styles/session-card.css';

const statusLabel: Record<SessionStatus, string> = {
  running: 'Live',
  initializing: 'Starting',
  stopping: 'Syncing',
  stopped: 'Stopped',
  error: 'Stopped',
};
import { terminalStore } from '../stores/terminal';
import { formatUptime, formatRelativeTime } from '../lib/format';
import { CONTEXT_EXPIRY_MS } from '../lib/constants';
import { AGENT_ICON_MAP } from '../lib/terminal-config';

interface SessionCardProps {
  session: SessionWithStatus;
  index: Accessor<number>;
  isActive: boolean;
  onSelect: () => void;
  onStop: () => void;
  onDelete: () => void;
  onReconnect?: () => void;
}

// WebSocket connection status config
const wsStatusConfig: Record<TerminalConnectionState, { color: string; title: string }> = {
  connected: { color: 'var(--color-success)', title: 'WebSocket connected' },
  disconnected: { color: 'var(--color-error)', title: 'WebSocket disconnected - click to reconnect' },
  connecting: { color: 'var(--color-warning)', title: 'WebSocket connecting... - click to force reconnect' },
  error: { color: 'var(--color-error)', title: 'WebSocket error - click to reconnect' },
};

// Which statuses show a spinning indicator
const statusSpinning: Record<SessionStatus, boolean> = {
  running: false,
  stopped: false,
  initializing: true,
  stopping: true,
  error: false,
};

// Status dot variant mapping
const statusDotVariant: Record<SessionStatus, 'success' | 'warning' | 'error' | 'default'> = {
  running: 'success',
  stopped: 'default',
  initializing: 'warning',
  stopping: 'warning',
  error: 'error',
};

const SessionCard: Component<SessionCardProps> = (props) => {
  const [isEditing, setIsEditing] = createSignal(false);
  const [editName, setEditName] = createSignal('');
  const [isDragOver, setIsDragOver] = createSignal(false);

  const isSpinning = () => statusSpinning[props.session.status];
  const canStop = () => props.session.status === 'running' || props.session.status === 'initializing';
  const canDelete = () => true;

  // Determine if a stopped session has recent context (< 24h)
  const stoppedWithContext = () => {
    if (props.session.status !== 'stopped') return false;
    return sessionStore.hasRecentContext(props.session);
  };

  // Resolved status label: override "Stopped" with relative time when context may still exist
  const resolvedStatusLabel = () => {
    if (props.session.status === 'stopped' && stoppedWithContext()) {
      return formatRelativeTime(new Date(props.session.lastActiveAt!));
    }
    return statusLabel[props.session.status];
  };
  const wsState = () => terminalStore.getConnectionState(props.session.id, '1');
  const wsConfig = () => wsStatusConfig[wsState()];
  const metrics = createMemo(() => sessionStore.getMetricsForSession(props.session.id));

  const startEditing = (e: MouseEvent) => {
    e.stopPropagation();
    setEditName(props.session.name);
    setIsEditing(true);
  };

  const saveRename = () => {
    const trimmed = editName().trim();
    if (trimmed && trimmed !== props.session.name) {
      sessionStore.renameSession(props.session.id, trimmed);
    }
    setIsEditing(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  };

  const handleDragOver = (e: DragEvent) => {
    if (props.session.status !== 'running') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (props.session.status !== 'running') return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        sendInputToTerminal(props.session.id, '1', files[i].name);
      }
    }
  };

  // Allow reconnect for any non-connected state (including stuck 'connecting')
  const canReconnect = () => wsState() !== 'connected';

  // Merged status: use WebSocket state when running, otherwise session status
  const mergedTitle = () => {
    if (props.session.status === 'running') {
      return wsConfig().title;
    }
    return `Session ${props.session.status}`;
  };

  const isPulsing = () => {
    return isSpinning() || (props.session.status === 'running' && wsState() === 'connecting');
  };

  const statusVariant = () => {
    if (props.session.status === 'running' && wsState() !== 'connected') {
      return wsState() === 'connecting' ? 'warning' : 'error';
    }
    if (stoppedWithContext()) return 'warning';
    return statusDotVariant[props.session.status];
  };

  // Get init progress for a session
  const getProgress = (): number => {
    const progress = sessionStore.getInitProgressForSession(props.session.id);
    return progress?.progress || 0;
  };

  return (
    <div
      class="session-card-wrapper stagger-item"
      style={{ '--stagger-index': props.index() }}
      data-testid={`session-card-${props.session.id}`}
    >
      <div
        class={`session-card session-card-gradient ${props.isActive ? 'session-card--active' : ''} ${props.isActive && props.session.status === 'running' ? 'session-card-glow' : ''} ${isDragOver() ? 'session-card--drop-target' : ''}`}
        data-status={props.session.status}
        onClick={() => {
          if (isEditing()) return;
          if (canReconnect() && props.onReconnect) {
            props.onReconnect();
          }
          props.onSelect();
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title={mergedTitle()}
      >
        <div class="session-card-content">
          <div class="session-card-header">
            <span class="session-header-agent-icon">
              <Icon path={AGENT_ICON_MAP[props.session.agentType || ''] || mdiConsole} size={14} />
            </span>
            <Show when={isEditing()} fallback={
              <span class="session-name">{props.session.name}</span>
            }>
              <input
                class="session-rename-input"
                type="text"
                value={editName()}
                onInput={(e) => setEditName(e.currentTarget.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={saveRename}
                onClick={(e) => e.stopPropagation()}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
                autofocus
              />
            </Show>
            <Show when={!isEditing()}>
              <button type="button" class="session-rename-btn" title="Rename session" onClick={startEditing}>
                <Icon path={mdiPencilOutline} size={12} />
              </button>
            </Show>
            <span
              class={`session-status-badge ${isPulsing() ? 'animate-pulse' : ''} ${props.session.status === 'running' ? 'session-badge-shimmer' : ''}`}
              data-testid="session-status-badge"
              data-status={statusVariant()}
            >
              <Show when={props.session.status === 'running' || stoppedWithContext()}>
                <span class="session-status-dot" />
              </Show>
              {resolvedStatusLabel()}
            </span>
          </div>

          <Show when={props.session.status === 'running'}>
            <div class="stat-card__metrics" data-testid="session-metrics">
              <div class="stat-card__metric session-card-metric" data-testid={`session-card-${props.session.id}-metric-bucket`}>
                <span class="stat-card__metric-label">
                  <Icon path={mdiCloudOutline} size={12} />
                  Bucket
                </span>
                <span class="stat-card__metric-value">{metrics()?.bucketName || '...'}</span>
              </div>
              <div class="stat-card__metric session-card-metric" data-testid={`session-card-${props.session.id}-metric-cpu`}>
                <span class="stat-card__metric-label">
                  <Icon path={mdiChip} size={12} />
                  CPU
                </span>
                <span class="stat-card__metric-value">{metrics()?.cpu || '...'}</span>
              </div>
              <div class="stat-card__metric session-card-metric" data-testid={`session-card-${props.session.id}-metric-mem`}>
                <span class="stat-card__metric-label">
                  <Icon path={mdiMemory} size={12} />
                  MEM
                </span>
                <span class="stat-card__metric-value">{metrics()?.mem || '...'}</span>
              </div>
              <div class="stat-card__metric session-card-metric" data-testid={`session-card-${props.session.id}-metric-hdd`}>
                <span class="stat-card__metric-label">
                  <Icon path={mdiHarddisk} size={12} />
                  HDD
                </span>
                <span class="stat-card__metric-value">{metrics()?.hdd || '...'}</span>
              </div>
              <div class="stat-card__metric session-card-metric" data-testid={`session-card-${props.session.id}-metric-uptime`}>
                <span class="stat-card__metric-label">
                  <Icon path={mdiClockOutline} size={12} />
                  Uptime
                </span>
                <span class="stat-card__metric-value">{formatUptime(props.session.createdAt)}</span>
              </div>
            </div>
          </Show>

          <Show when={props.session.status === 'initializing'}>
            <div class="progress-bar progress-bar-thin progress-bar-animated session-init-progress">
              <div
                class="progress-bar-fill"
                style={{ width: `${getProgress()}%` }}
                data-testid={`session-card-${props.session.id}-progress`}
              />
            </div>
          </Show>

          <div class="session-card-info" data-testid="session-card-info">
            <span class="session-card-info-icon">
              <Icon path={AGENT_ICON_MAP[props.session.agentType || ''] || mdiConsole} size={11} />
            </span>
            <span>Created {formatRelativeTime(new Date(props.session.createdAt))}</span>
            <span class="session-card-info-separator">|</span>
            <span>Active {formatRelativeTime(new Date(props.session.lastAccessedAt))}</span>
          </div>
        </div>

      </div>
      <div class="session-card-actions-overlay" data-testid="session-actions-overlay">
        <Show when={canStop()}>
          <button
            type="button"
            class="session-action-btn session-action-btn--stop"
            title="Stop session"
            onClick={(e) => {
              e.stopPropagation();
              props.onStop();
            }}
          >
            <Icon path={mdiStop} size={16} />
          </button>
        </Show>
        <Show when={canDelete()}>
          <button
            type="button"
            class="session-action-btn session-action-btn--delete"
            title="Delete session"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete session "${props.session.name}"?`)) {
                props.onDelete();
              }
            }}
          >
            <Icon path={mdiTrashCanOutline} size={16} />
          </button>
        </Show>
      </div>
    </div>
  );
};

export default SessionCard;
