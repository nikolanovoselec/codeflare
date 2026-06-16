import { Component, For } from 'solid-js';
import ClonePickerOptionRow from './ClonePickerOptionRow';
import type { AgentType } from '../../types';
import { sessionStore } from '../../stores/session';
import { AGENT_OPTIONS, ENTERPRISE_AGENT_TYPES } from '../CreateSessionDialog';

interface ClonePickerNewSessionProps {
  disabled: boolean;
  onSelect: (agentType: AgentType) => void;
}

// "Clone into a new session" group: reuses the canonical AGENT_OPTIONS catalog
// (the same agent-type chooser the dashboard New Session dialog renders).
// Selecting an agent creates a new session that clones the target repo at start.
const ClonePickerNewSession: Component<ClonePickerNewSessionProps> = (props) => {
  const agentOptions = () =>
    sessionStore.enterpriseMode
      ? AGENT_OPTIONS.filter((a) => ENTERPRISE_AGENT_TYPES.includes(a.type))
      : AGENT_OPTIONS;

  return (
    <div class="clone-picker-new-group" data-testid="clone-picker-new-group">
      <div class="clone-picker-group-header">
        <span>Clone into a new session</span>
      </div>
      <div class="clone-picker-agents">
        <For each={agentOptions()}>
          {(agent) => (
            <ClonePickerOptionRow
              icon={agent.icon}
              label={agent.label}
              description={agent.description}
              badge={agent.badge}
              disabled={props.disabled}
              onClick={() => props.onSelect(agent.type)}
              testId={`clone-picker-agent-${agent.type}`}
            />
          )}
        </For>
      </div>
    </div>
  );
};

export default ClonePickerNewSession;
