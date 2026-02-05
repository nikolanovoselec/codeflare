import { Component, Show } from 'solid-js';
import { mdiKeyboard } from '@mdi/js';
import Icon from './Icon';
import { Button } from './ui';
import '../styles/empty-state.css';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: string;
  };
  hint?: string;
  testId?: string;
}

/**
 * EmptyState Component
 *
 * Displays a beautiful empty state with:
 * - Large animated icon
 * - Title and description
 * - Optional action button
 * - Optional keyboard shortcut hint
 *
 * Layout:
 * +--------------------------------------------------+
 * |                                                  |
 * |           [Large Icon - animated float]          |
 * |                                                  |
 * |              Title Text Here                     |
 * |                                                  |
 * |    A longer description explaining what to do    |
 * |    and why this state exists.                    |
 * |                                                  |
 * |              [+ Action Button]                   |
 * |                                                  |
 * |        [Keyboard] Cmd+N to create                |
 * |                                                  |
 * +--------------------------------------------------+
 */
const EmptyState: Component<EmptyStateProps> = (props) => {
  return (
    <div
      class="empty-state animate-fadeIn"
      data-testid={props.testId || 'empty-state'}
    >
      <Show when={props.icon}>{(icon) =>
        <div class="empty-state-icon animate-float" data-testid="empty-state-icon">
          <Icon path={icon()} size={48} />
        </div>
      }</Show>

      <h2 class="empty-state-title" data-testid="empty-state-title">
        {props.title}
      </h2>

      <p class="empty-state-description" data-testid="empty-state-description">
        {props.description}
      </p>

      <Show when={props.action}>{(action) =>
        <div class="empty-state-action" data-testid="empty-state-action">
          <Button
            icon={action().icon}
            onClick={action().onClick}
          >
            {action().label}
          </Button>
        </div>
      }</Show>

      <Show when={props.hint}>
        <div class="empty-state-hint" data-testid="empty-state-hint">
          <Icon path={mdiKeyboard} size={14} />
          <span>{props.hint}</span>
        </div>
      </Show>

    </div>
  );
};

export default EmptyState;
