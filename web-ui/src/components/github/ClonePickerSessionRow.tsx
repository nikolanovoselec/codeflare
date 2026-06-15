import { Component } from 'solid-js';
import { mdiConsole } from '@mdi/js';
import Icon from '../Icon';
import type { SessionWithStatus } from '../../types';

interface ClonePickerSessionRowProps {
  session: SessionWithStatus;
  disabled: boolean;
  onSelect: (sessionId: string) => void;
}

// One running-session row in the ClonePicker. Selecting it clones the target
// repo into that live container. Presentational — the parent owns the action.
const ClonePickerSessionRow: Component<ClonePickerSessionRowProps> = (props) => {
  return (
    <button
      type="button"
      class="clone-picker-session-btn"
      data-testid="clone-picker-session-row"
      data-session-id={props.session.id}
      disabled={props.disabled}
      onClick={() => props.onSelect(props.session.id)}
    >
      <Icon path={mdiConsole} size={16} class="clone-picker-session-icon" />
      <span class="clone-picker-session-name">{props.session.name}</span>
    </button>
  );
};

export default ClonePickerSessionRow;
