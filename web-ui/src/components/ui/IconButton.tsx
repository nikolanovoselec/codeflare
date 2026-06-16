import { Component } from 'solid-js';
import Icon from '../Icon';
import '../../styles/icon-button.css';

interface IconButtonProps {
  /** MDI path string for the icon. */
  icon: string;
  /** Accessible label (aria-label + title) — required since there is no visible text. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Visually marks the button as the active/selected face (e.g. a toggle). */
  active?: boolean;
  /** Spins the icon (e.g. while a refresh is in flight). */
  spinning?: boolean;
  size?: number;
  /** Extra classes appended to the base `icon-button` class. */
  class?: string;
  testId?: string;
}

/**
 * A square icon-only button shared across the GitHub panel controls (refresh,
 * disconnect, mobile panel-flip). Mirrors the storage panel's `.storage-icon-btn`
 * look via the `icon-button` class so the two panels feel identical.
 */
const IconButton: Component<IconButtonProps> = (props) => (
  <button
    type="button"
    class={`icon-button${props.class ? ` ${props.class}` : ''}`}
    classList={{ 'icon-button--active': props.active }}
    aria-label={props.label}
    title={props.label}
    aria-pressed={props.active}
    data-testid={props.testId}
    disabled={props.disabled}
    onClick={() => props.onClick()}
  >
    <Icon path={props.icon} size={props.size ?? 16} class={props.spinning ? 'icon-button-spin' : undefined} />
  </button>
);

export default IconButton;
