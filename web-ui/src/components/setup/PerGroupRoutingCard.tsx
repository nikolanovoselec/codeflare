import { Component, Show } from 'solid-js';
import Button from '../ui/Button';
import PillToggle from '../ui/PillToggle';
import Select from '../ui/Select';
import type { ReasoningLevel } from '../../stores/setup';

interface PerGroupRoutingCardProps {
  groupName: string;
  /** The global dynamic-route catalog the pills draw from. */
  availableRoutes: string[];
  /** This group's active routes (subset of availableRoutes). */
  selectedRoutes: string[];
  defaultRoute: string;
  reasoning: ReasoningLevel;
  onToggleRoute: (route: string) => void;
  onDefaultChange: (route: string) => void;
  onReasoningChange: (level: ReasoningLevel) => void;
  onApplyToAll: () => void;
  /** Show the "Apply to all groups" shortcut (only when >1 group exists). */
  showApplyToAll?: boolean;
}

const REASONING_OPTIONS = [
  { value: 'off', label: 'reasoning: off' },
  { value: 'low', label: 'reasoning: low' },
  { value: 'medium', label: 'reasoning: medium' },
  { value: 'high', label: 'reasoning: high' },
];

/**
 * REQ-ENTERPRISE-013: per-group routing editor. Toggleable route pills (green =
 * active, gray = off), the group's default route (constrained to its active
 * routes) + reasoning level, and an "Apply to all groups" shortcut shown only
 * when more than one group exists. Pure props/callbacks — state lives in the store.
 */
const PerGroupRoutingCard: Component<PerGroupRoutingCardProps> = (props) => (
  <div class="group-routing-card">
    <div class="group-routing-card-header">
      <span class="group-routing-card-title">{props.groupName}</span>
      <Show when={props.showApplyToAll}>
        <Button onClick={() => props.onApplyToAll()} variant="ghost" size="sm">Apply to all groups</Button>
      </Show>
    </div>
    <PillToggle
      items={props.availableRoutes}
      selected={props.selectedRoutes}
      onToggle={(route) => props.onToggleRoute(route)}
    />
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
