import { Component, JSX, Show } from 'solid-js';
import Icon from '../Icon';
import { mdiChevronRight } from '@mdi/js';

interface AdminActionButtonProps {
  /** Destination actions include a trailing chevron; maintenance actions do not. */
  navigation?: boolean;
  /** MDI path. */
  icon: string;
  label: JSX.Element;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  testId?: string;
}

// Settings-only accent-coloured navigation and maintenance actions.
const AdminActionButton: Component<AdminActionButtonProps> = (props) => (
  <Show
    when={props.href}
    fallback={
      <button
        type="button"
        class="settings-action settings-action--accent settings-admin-action"
        disabled={props.disabled}
        onClick={props.onClick}
        data-testid={props.testId}
      >
        <Icon path={props.icon} size={16} aria-hidden="true" />
        <span>{props.label}</span>
        <Show when={props.href || props.navigation}>
          <Icon path={mdiChevronRight} size={16} class="settings-action-chevron" aria-hidden="true" />
        </Show>
      </button>
    }
  >
    {(href) => (
      <a
        class="settings-action settings-action--accent settings-admin-action"
        href={href()}
        data-testid={props.testId}
      >
        <Icon path={props.icon} size={16} aria-hidden="true" />
        <span>{props.label}</span>
        <Icon path={mdiChevronRight} size={16} class="settings-action-chevron" aria-hidden="true" />
      </a>
    )}
  </Show>
);

export default AdminActionButton;
