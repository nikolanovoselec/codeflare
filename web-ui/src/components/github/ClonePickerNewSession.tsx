import { Component, For, Show } from 'solid-js';
import Icon from '../Icon';
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
            <button
              type="button"
              class="clone-picker-agent-btn"
              data-testid={`clone-picker-agent-${agent.type}`}
              disabled={props.disabled}
              onClick={() => props.onSelect(agent.type)}
            >
              <Icon path={agent.icon} size={18} class="clone-picker-agent-icon" />
              <div class="clone-picker-agent-info">
                <span class="clone-picker-agent-label">
                  {agent.label}
                  <Show when={agent.badge}>
                    <span class="clone-picker-agent-badge">{agent.badge}</span>
                  </Show>
                </span>
                <span class="clone-picker-agent-desc">{agent.description}</span>
              </div>
            </button>
          )}
        </For>
      </div>
    </div>
  );
};

export default ClonePickerNewSession;
