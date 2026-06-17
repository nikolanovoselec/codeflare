import { Component, For } from 'solid-js';
import { type ScopeTier, type TierConfig } from '../../lib/token-scopes';
import '../../styles/connect.css';

interface ScopeTierPickerProps {
  /** Scopes the data-testids so a page with both providers stays unambiguous. */
  provider: string;
  /** Tier catalog (label + description) — the description is the explanatory subtitle. */
  tiers: Record<ScopeTier, TierConfig>;
  selected: ScopeTier;
  onSelect: (tier: ScopeTier) => void;
}

const TIER_ORDER: ScopeTier[] = ['minimal', 'recommended', 'advanced'];

/**
 * Single-select scope-level picker: all three tiers presented as a segmented
 * control with a subtitle describing the selected one. Shown only in non-enterprise
 * connect surfaces (enterprise GitHub Apps carry fixed permissions and ignore the
 * tier). Reused by the dashboard GitHub panel, Guided Setup, and the Settings
 * accordion so the option set + copy live in one place (token-scopes.ts).
 */
const ScopeTierPicker: Component<ScopeTierPickerProps> = (props) => (
  <div class="scope-tier" data-testid={`${props.provider}-tier-picker`}>
    <div class="scope-tier-options" role="radiogroup">
      <For each={TIER_ORDER}>
        {(tier) => {
          const on = () => props.selected === tier;
          return (
            <button
              type="button"
              class="scope-tier-option"
              classList={{ 'scope-tier-option--on': on() }}
              role="radio"
              aria-checked={on()}
              data-state={on() ? 'on' : 'off'}
              data-value={tier}
              data-testid={`${props.provider}-tier-${tier}`}
              onClick={() => props.onSelect(tier)}
            >
              {props.tiers[tier].label}
            </button>
          );
        }}
      </For>
    </div>
    <span class="scope-tier-desc" data-testid={`${props.provider}-tier-desc`}>
      {props.tiers[props.selected].description}
    </span>
  </div>
);

export default ScopeTierPicker;
