import { Component, JSX } from 'solid-js';
import Icon from '../Icon';

interface AdminActionButtonProps {
  /** A `--color-action-*` token name; the button's identity colour. */
  tone: string;
  /** MDI path. */
  icon: string;
  label: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}

// The full-width coloured action buttons in the Settings admin sections. Five
// copies of this markup existed across SettingsPanel and SessionSection, each
// with its own inline hex, so retuning one meant finding all of them.
const AdminActionButton: Component<AdminActionButtonProps> = (props) => (
  <button
    type="button"
    class="provider-row-connect-btn"
    style={{ background: `var(${props.tone})` }}
    disabled={props.disabled}
    onClick={props.onClick}
    data-testid={props.testId}
  >
    <Icon path={props.icon} size={24} style={{ color: 'white' }} />
    <span>{props.label}</span>
  </button>
);

export default AdminActionButton;
