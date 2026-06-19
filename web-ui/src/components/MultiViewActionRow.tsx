import { Component } from 'solid-js';
import { mdiClose } from '@mdi/js';
import Icon from './Icon';
import { MULTIVIEW_ICON } from '../lib/terminal-config';
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
    if (props.mode === 'selecting') return props.canLaunch ? 'Launch MultiView' : 'Cancel MultiView';
    return 'Launch MultiView';
  };

  return (
    <div class="session-dropdown__multiview-row">
      <button
        type="button"
        class={`session-dropdown__multiview ${props.disabled ? 'session-dropdown__multiview--disabled' : ''}`}
        data-testid="session-dropdown-multiview-action"
        data-mode={props.mode === 'selecting' ? 'selecting' : 'idle'}
        aria-disabled={props.disabled ? 'true' : 'false'}
        disabled={props.disabled}
        onClick={() => { if (!props.disabled) props.onClick(); }}
      >
        <Icon path={MULTIVIEW_ICON} size={16} />
        <span>{label()}</span>
      </button>
      {props.mode === 'open' && props.onClose && (
        <button
          type="button"
          class="session-dropdown__multiview-close"
          data-testid="session-dropdown-multiview-close"
          onClick={props.onClose}
          aria-label="Close MultiView"
        >
          <Icon path={mdiClose} size={14} />
        </button>
      )}
    </div>
  );
};

export default MultiViewActionRow;
