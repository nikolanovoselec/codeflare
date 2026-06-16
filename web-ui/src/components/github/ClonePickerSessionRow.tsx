import { Component } from 'solid-js';
import { mdiConsole } from '@mdi/js';
import ClonePickerOptionRow from './ClonePickerOptionRow';
import { AGENT_OPTIONS } from '../CreateSessionDialog';
import type { SessionWithStatus } from '../../types';

interface ClonePickerSessionRowProps {
  session: SessionWithStatus;
  disabled: boolean;
  onSelect: (sessionId: string) => void;
}

// One running-session row in the ClonePicker. Selecting it clones the target
// repo into that live container. Renders through the shared ClonePickerOptionRow
// so it aligns with the "new session" agent rows, showing the session's agent
// icon and a "Running in <agent>" subtitle.
const ClonePickerSessionRow: Component<ClonePickerSessionRowProps> = (props) => {
  const agent = () => AGENT_OPTIONS.find((a) => a.type === props.session.agentType);
  return (
    <ClonePickerOptionRow
      icon={agent()?.icon ?? mdiConsole}
      label={props.session.name}
      description={agent() ? `Running in ${agent()!.label}` : 'Running session'}
      disabled={props.disabled}
      onClick={() => props.onSelect(props.session.id)}
      testId="clone-picker-session-row"
      sessionId={props.session.id}
    />
  );
};

export default ClonePickerSessionRow;
