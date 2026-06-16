import { Component, For, Show } from 'solid-js';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Select from '../ui/Select';
import type { ReasoningLevel } from '../../stores/setup';

interface PerGroupRoutingCardProps {
  groupName: string;
  /** The global dynamic-route catalog the checklist draws from. */
  availableRoutes: string[];
  /** This group's active routes (subset of availableRoutes). */
  selectedRoutes: string[];
  defaultRoute: string;
  reasoning: ReasoningLevel;
  onToggleRoute: (route: string) => void;
  onDefaultChange: (route: string) => void;
  onReasoningChange: (level: ReasoningLevel) => void;
  onApplyToAll: () => void;
}

const REASONING_OPTIONS = [
  { value: 'off', label: 'reasoning: off' },
  { value: 'low', label: 'reasoning: low' },
  { value: 'medium', label: 'reasoning: medium' },
  { value: 'high', label: 'reasoning: high' },
];

/**
 * REQ-ENTERPRISE-013: per-group routing editor. A checklist of the catalog routes
 * (which are active for this group), the group's default route (constrained to its
 * active routes) + reasoning level, and an "Apply to all groups" shortcut. Pure
 * props/callbacks — all state lives in the setup store.
 */
const PerGroupRoutingCard: Component<PerGroupRoutingCardProps> = (props) => (
  <div class="group-routing-card">
    <div class="group-routing-card-header">
      <span class="group-routing-card-title">{props.groupName}</span>
      <Button onClick={() => props.onApplyToAll()} variant="ghost" size="sm">Apply to all groups</Button>
    </div>
    <div class="group-routing-routes">
      <For each={props.availableRoutes}>
        {(route) => (
          <Checkbox
            checked={props.selectedRoutes.includes(route)}
            label={route}
            onChange={() => props.onToggleRoute(route)}
          />
        )}
      </For>
    </div>
    <Show when={props.selectedRoutes.length > 0}>
      <div class="route-default-row">
        <Select
          value={props.defaultRoute}
          options={props.selectedRoutes.map((r) => ({ value: r, label: r }))}
          onChange={(v) => props.onDefaultChange(v)}
        />
        <Select
          value={props.reasoning}
          options={REASONING_OPTIONS}
          disabled={!props.defaultRoute}
          onChange={(v) => props.onReasoningChange(v as ReasoningLevel)}
        />
      </div>
    </Show>
  </div>
);

export default PerGroupRoutingCard;
