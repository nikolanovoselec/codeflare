import { Component, For, Show, createMemo } from 'solid-js';
import {
  mdiCheck,
  mdiLoading,
  mdiCircleOutline,
  mdiOpenInNew,
  mdiAlertCircle,
  mdiRocketLaunchOutline,
  mdiCloudSyncOutline,
  mdiCheckCircle,
  mdiPackageVariant,
  mdiHarddisk,
  mdiShieldCheckOutline,
} from '@mdi/js';
import Icon from './Icon';
import { useStageTimings } from '../hooks/useStageTimings';
import { stageOrder } from '../lib/stages';
import type { InitProgress, InitStage } from '../types';
import '../styles/init-progress.css';

interface InitProgressProps {
  sessionName: string;
  sessionId?: string;
  progress: InitProgress | null;
  onOpen?: () => void;
}

// Define the 6 initialization stages with their labels
const stages: { key: InitStage; label: string }[] = [
  { key: 'creating', label: 'Creating session' },
  { key: 'starting', label: 'Starting container' },
  { key: 'syncing', label: 'Syncing workspace' },
  { key: 'verifying', label: 'Verifying workspace' },
  { key: 'mounting', label: 'Preparing terminal' },
  { key: 'ready', label: 'Ready' },
];

// Stage-to-icon mapping (used for both hero icon and step icons)
const stageIcons: Record<string, string> = {
  creating: mdiPackageVariant,
  starting: mdiRocketLaunchOutline,
  syncing: mdiCloudSyncOutline,
  mounting: mdiHarddisk,
  verifying: mdiShieldCheckOutline,
  ready: mdiCheckCircle,
  error: mdiAlertCircle,
};

const InitProgressComponent: Component<InitProgressProps> = (props) => {
  const { getElapsedTime, formatTotalTime } = useStageTimings(
    () => props.progress?.stage as InitStage | undefined,
    () => props.progress,
  );

  const currentStageIndex = () => {
    if (!props.progress) return -1;
    return stageOrder[props.progress.stage] ?? -1;
  };

  const getStageStatus = (stageKey: InitStage): 'completed' | 'active' | 'pending' | 'error' => {
    if (!props.progress) return 'pending';
    if (props.progress.stage === 'error') return 'error';

    const idx = currentStageIndex();
    const stageIdx = stageOrder[stageKey];

    if (idx > stageIdx) return 'completed';
    if (idx === stageIdx) return 'active';
    return 'pending';
  };

  // Get details for the current stage, enriched with session info
  const stageDetails = () => {
    const baseDetails = props.progress?.details || [];
    const enrichedDetails = [...baseDetails];

    // Add session ID if available
    if (props.sessionId) {
      enrichedDetails.unshift({
        key: 'Session ID',
        value: props.sessionId.slice(0, 8) + '...',
      });
    }

    return enrichedDetails;
  };

  const isComplete = () => props.progress?.stage === 'ready';
  const isError = () => props.progress?.stage === 'error';
  const progressPercent = () => props.progress?.progress ?? 0;
  const statusMessage = () => props.progress?.message ?? 'Initializing...';

  // Hero icon based on current stage
  const heroIcon = () => {
    const stage = props.progress?.stage;
    if (!stage || stage === 'stopped') return mdiLoading;
    return stageIcons[stage] || mdiLoading;
  };

  // Hero icon animation class
  const heroIconClass = () => {
    if (isComplete()) return 'init-progress-hero-icon animate-bounce animate-scaleIn';
    if (isError()) return 'init-progress-hero-icon';
    return 'init-progress-hero-icon animate-float';
  };

  // Modal class for error shake
  const modalClass = () => {
    if (isError()) return 'init-progress animate-shake';
    return 'init-progress';
  };

  // Progress bar color changes to green when complete, red on error
  const progressBarClass = createMemo(() => {
    if (isError()) return 'init-progress-bar-fill init-progress-bar-fill--error';
    if (isComplete()) return 'init-progress-bar-fill init-progress-bar-fill--complete';
    return 'init-progress-bar-fill';
  });

  return (
    <div class={modalClass()} data-testid="init-progress">
      {/* Hero Icon */}
      <div class="init-progress-hero">
        <div class={heroIconClass()} data-testid="init-progress-hero-icon">
          <Icon
            path={heroIcon()}
            size={48}
            class={isComplete() ? '' : isError() ? '' : 'animate-pulse'}
          />
        </div>
      </div>

      <div class="init-progress-header">
        <h2>Starting "{props.sessionName}"</h2>
        <p class="init-progress-subtitle">{statusMessage()}</p>
      </div>

      <div
        class={`init-progress-bar ${isComplete() ? 'init-progress-bar--complete' : ''} ${isError() ? 'init-progress-bar--error' : ''}`}
        data-testid="init-progress-bar"
      >
        <div
          class={progressBarClass()}
          style={{ width: `${progressPercent()}%` }}
          data-testid="init-progress-bar-fill"
        />
        <span class="init-progress-bar-text">
          {progressPercent()}%
        </span>
      </div>

      <ul class="init-progress-stages">
        <For each={stages}>
          {(stage, index) => {
            const status = () => getStageStatus(stage.key);
            const elapsedTime = () => getElapsedTime(stage.key, getStageStatus);
            return (
              <li
                class={`init-progress-stage init-progress-stage--${status()}`}
                data-stage={stage.key}
                data-testid={`init-progress-step-${index()}`}
              >
                <div class="init-progress-stage-row">
                  <span class="init-progress-stage-icon">
                    <Show when={status() === 'completed'}>
                      <Icon path={mdiCheck} size={18} />
                    </Show>
                    <Show when={status() === 'active' && stage.key !== 'ready'}>
                      <Icon path={stageIcons[stage.key] || mdiLoading} size={18} class="animate-spin" />
                    </Show>
                    <Show when={status() === 'active' && stage.key === 'ready'}>
                      <Icon path={mdiCheck} size={18} />
                    </Show>
                    <Show when={status() === 'pending'}>
                      <Icon path={mdiCircleOutline} size={18} />
                    </Show>
                    <Show when={status() === 'error'}>
                      <Icon path={mdiAlertCircle} size={18} />
                    </Show>
                  </span>
                  <span class="init-progress-stage-label">{stage.label}</span>
                  <span
                    class="init-progress-stage-time"
                    data-testid={`init-progress-step-${index()}-time`}
                  >
                    {elapsedTime() || (status() === 'active' ? '...' : '')}
                  </span>
                </div>
              </li>
            );
          }}
        </For>
      </ul>

      {/* Details section - always visible */}
      <div class="init-progress-details-section">
        <div class="init-progress-details-title">Details</div>
        <div class="init-progress-details-grid">
          <For each={stageDetails()}>
            {(detail) => (
              <div class="init-progress-detail">
                <span class="init-progress-detail-key">{detail.key}</span>
                <span class="init-progress-detail-value">
                  {detail.value}
                </span>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Open button and total time - shown when complete */}
      <Show when={isComplete()}>
        <div class="init-progress-actions">
          <button type="button" class="init-progress-open-btn" onClick={props.onOpen}>
            <Icon path={mdiOpenInNew} size={18} />
            <span>Open</span>
          </button>
          <Show when={formatTotalTime()}>
            <div class="init-progress-total-time">
              Started in {formatTotalTime()}s
            </div>
          </Show>
        </div>
      </Show>

      {/* Error state */}
      <Show when={isError()}>
        <div class="init-progress-error-msg">
          {props.progress?.message || 'An error occurred during startup'}
        </div>
      </Show>
    </div>
  );
};

export default InitProgressComponent;
