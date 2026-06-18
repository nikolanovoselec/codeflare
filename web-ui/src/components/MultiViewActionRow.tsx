import { Component } from 'solid-js';
import { mdiClose, mdiMonitorMultiple } from '@mdi/js';
import Icon from './Icon';
import '../styles/session-dropdown.css';

interface MultiViewActionRowProps {
  mode: 'open' | 'start' | 'selecting';
  canLaunch: boolean;
  disabled: boolean;
  onClick: () => void;
  onClose?: () => void;
}

const MultiViewActionRow: Component<MultiViewActionRowProps> = (props) => {
  const label = () => {
    if (props.mode === 'open') return 'MultiView #1';
    if (props.mode === 'selecting') return props.canLaunch ? 'Launch MultiView' : 'Cancel MultiView';
    return 'MultiView';
  };

  return (
    <div
      role="button"
      tabIndex={props.disabled ? -1 : 0}
      class={`session-dropdown__multiview ${props.disabled ? 'session-dropdown__multiview--disabled' : ''}`}
      data-testid="session-dropdown-multiview-action"
      data-mode={props.mode === 'selecting' ? 'selecting' : 'idle'}
      aria-disabled={props.disabled ? 'true' : 'false'}
      onClick={() => { if (!props.disabled) props.onClick(); }}
      onKeyDown={(event) => {
        if (!props.disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          props.onClick();
        }
      }}
    >
      <Icon path={mdiMonitorMultiple} size={16} />
      <span>{label()}</span>
      {props.mode === 'open' && props.onClose && (
        <span
          role="button"
          tabIndex={0}
          class="session-dropdown__multiview-close"
          data-testid="session-dropdown-multiview-close"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              props.onClose?.();
            }
          }}
        >
          <Icon path={mdiClose} size={14} />
        </span>
      )}
    </div>
  );
};

export default MultiViewActionRow;
