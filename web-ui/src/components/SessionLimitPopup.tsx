import { Component, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { mdiAlertCircleOutline } from '@mdi/js';
import Icon from './Icon';
import '../styles/session-limit-popup.css';

interface SessionLimitPopupProps {
  isOpen: boolean;
  onClose: () => void;
  sessionsRunning: number;
  sessionsLimit: number;
  anchorRef?: HTMLElement;
}

const SessionLimitPopup: Component<SessionLimitPopupProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 300 });

  const POPUP_ESTIMATED_HEIGHT = 220;
  const GAP = 8;

  const updatePosition = () => {
    if (!props.anchorRef) return;
    const rect = props.anchorRef.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    const spaceBelow = viewportHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;

    let top: number;
    if (spaceBelow >= POPUP_ESTIMATED_HEIGHT) {
      top = rect.bottom + GAP;
    } else if (spaceAbove >= POPUP_ESTIMATED_HEIGHT) {
      top = rect.top - GAP - POPUP_ESTIMATED_HEIGHT;
    } else {
      if (spaceBelow >= spaceAbove) {
        top = rect.bottom + GAP;
      } else {
        top = Math.max(GAP, rect.top - GAP - POPUP_ESTIMATED_HEIGHT);
      }
    }

    setPosition({
      top,
      left: rect.left,
      width: rect.width,
    });
  };

  createEffect(() => {
    if (props.isOpen) updatePosition();
  });

  const handleClickOutside = (e: MouseEvent) => {
    if (!props.isOpen) return;
    if (dialogRef && !dialogRef.contains(e.target as Node)) {
      if (props.anchorRef && props.anchorRef.contains(e.target as Node)) return;
      props.onClose();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.isOpen) {
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  });

  const usagePercent = () => Math.round((props.sessionsRunning / props.sessionsLimit) * 100);

  return (
    <Show when={props.isOpen}>
      <div class="slp-backdrop" onClick={() => props.onClose()} />
      <div
        ref={dialogRef}
        class="session-limit-popup"
        data-testid="session-limit-popup"
        role="dialog"
        aria-label="Session limit reached"
        style={{
          top: `${position().top}px`,
          left: `${position().left}px`,
          width: `${position().width}px`,
        }}
      >
        <div class="slp-header">
          <Icon path={mdiAlertCircleOutline} size={20} class="slp-warning-icon" />
          <span class="slp-title">Session Limit Reached</span>
        </div>

        <p class="slp-body">
          You are running <span class="slp-count">{props.sessionsRunning}</span> of <span class="slp-count">{props.sessionsLimit}</span> allowed sessions. Stop an existing session to start a new one.
        </p>

        <div class="slp-progress-track">
          <div
            class="slp-progress-fill"
            style={{ width: `${usagePercent()}%` }}
          />
        </div>

        <button
          type="button"
          class="slp-dismiss-btn"
          onClick={() => props.onClose()}
        >
          Got it
        </button>
      </div>
    </Show>
  );
};

export default SessionLimitPopup;
