import { Component, Show } from 'solid-js';
import Icon from '../Icon';

interface ClonePickerOptionRowProps {
  icon: string;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
  /** Present on running-session rows so the parent can key the clone target. */
  sessionId?: string;
}

/**
 * Shared clone-picker row: icon + label (+ optional badge) + optional description.
 * One layout, two data sources — the "running session" rows and the "new session"
 * agent rows both render through this so they share alignment and styling.
 */
const ClonePickerOptionRow: Component<ClonePickerOptionRowProps> = (props) => (
  <button
    type="button"
    class="clone-picker-option-btn"
    data-testid={props.testId}
    data-session-id={props.sessionId}
    disabled={props.disabled}
    onClick={() => props.onClick()}
  >
    <Icon path={props.icon} size={18} class="clone-picker-option-icon" />
    <div class="clone-picker-option-info">
      <span class="clone-picker-option-label">
        {props.label}
        <Show when={props.badge}>
          <span class="clone-picker-option-badge">{props.badge}</span>
        </Show>
      </span>
      <Show when={props.description}>
        <span class="clone-picker-option-desc">{props.description}</span>
      </Show>
    </div>
  </button>
);

export default ClonePickerOptionRow;
