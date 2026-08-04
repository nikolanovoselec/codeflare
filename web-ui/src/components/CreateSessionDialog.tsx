import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import Icon from './Icon';
import type { AgentType, TabConfig } from '../types';
import { sessionStore } from '../stores/session';
import { AGENT_OPTIONS } from '../lib/agent-catalog';
import '../styles/create-session-dialog.css';

interface CreateSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (agentType: AgentType, tabConfig?: TabConfig[]) => void;
  anchorRef?: HTMLElement;
}

const CreateSessionDialog: Component<CreateSessionDialogProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 300 });

  const lastAgentType = () => sessionStore.preferences.lastAgentType;

  // Withhold choices until GET /api/user supplies the deployment allowlist;
  // showing the full catalog during hydration could expose an omitted CLI.
  const agentOptions = () => {
    const allowed = sessionStore.allowedAgents;
    return allowed ? AGENT_OPTIONS.filter((agent) => allowed.includes(agent.type)) : [];
  };

  // Compute fixed position from anchor button rect — dialog opens BELOW the button.
  // If there isn't enough room below, flip it above the button instead.
  const DIALOG_ESTIMATED_HEIGHT = 380; // Approximate height of 6 agent options + header
  const GAP = 8;

  const updatePosition = () => {
    if (!props.anchorRef) return;
    const rect = props.anchorRef.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    const spaceBelow = viewportHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;

    let top: number;
    if (spaceBelow >= DIALOG_ESTIMATED_HEIGHT) {
      // Enough room below — open downward
      top = rect.bottom + GAP;
    } else if (spaceAbove >= DIALOG_ESTIMATED_HEIGHT) {
      // Not enough room below but enough above — open upward
      top = rect.top - GAP - DIALOG_ESTIMATED_HEIGHT;
    } else {
      // Neither direction has full room — pick the side with more space
      // and clamp so the dialog stays within viewport
      if (spaceBelow >= spaceAbove) {
        top = rect.bottom + GAP;
      } else {
        top = Math.max(GAP, rect.top - GAP - DIALOG_ESTIMATED_HEIGHT);
      }
    }

    setPosition({
      top,
      left: rect.left,
      width: rect.width,
    });
  };

  // Recompute position when dialog opens
  createEffect(() => {
    if (props.isOpen) updatePosition();
  });

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (!props.isOpen) return;
    if (dialogRef && !dialogRef.contains(e.target as Node)) {
      if (props.anchorRef && props.anchorRef.contains(e.target as Node)) return;
      props.onClose();
    }
  };

  // Close on Escape
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.isOpen) {
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  });

  const handleAgentSelect = (agentType: AgentType) => {
    props.onSelect(agentType);
  };

  return (
    <Show when={props.isOpen}>
      <div class="csd-backdrop" onClick={() => props.onClose()} />
      <div
        ref={dialogRef}
        class="create-session-dialog"
        data-testid="create-session-dialog"
        role="dialog"
        aria-label="Create new session"
        style={{
          top: `${position().top}px`,
          left: `${position().left}px`,
          width: `${position().width}px`,
        }}
      >
        {/* Agent selection */}
        <div class="csd-section">
          <div class="csd-section-header">
            <span>Agent Type</span>
          </div>
          <div class="csd-agents">
            <For each={agentOptions()}>
              {(agent) => (
                <button
                  type="button"
                  class={`csd-agent-btn ${lastAgentType() === agent.type ? 'csd-agent-btn--last-used' : ''}`}
                  data-testid={`csd-agent-${agent.type}`}
                  onClick={() => handleAgentSelect(agent.type)}
                >
                  <Icon path={agent.icon} size={18} class="csd-agent-icon" />
                  <div class="csd-agent-info">
                    <span class="csd-agent-label">
                      {agent.label}
                      <Show when={agent.badge}>
                        <span class="csd-agent-badge">{agent.badge}</span>
                      </Show>
                    </span>
                    <span class="csd-agent-desc">{agent.description}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CreateSessionDialog;
