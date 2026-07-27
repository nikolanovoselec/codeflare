import { Component, JSX } from 'solid-js';
import Icon from '../Icon';

// The button's identity colour, as a token name rather than a colour: a literal
// would interpolate to `var(#2563eb)`, which is invalid and paints nothing.
// Keep this union in step with the --color-action-* block in design-tokens.css.
type ActionTone =
  | '--color-action-setup'
  | '--color-action-users'
  | '--color-action-subscriptions'
  | '--color-action-docs'
  | '--color-action-agents';

interface AdminActionButtonProps {
  tone: ActionTone;
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
    {/* The icon fills with currentColor, which the button class already sets. */}
    <Icon path={props.icon} size={24} />
    <span>{props.label}</span>
  </button>
);

export default AdminActionButton;
