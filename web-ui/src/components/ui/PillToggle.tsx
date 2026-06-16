import { Component, For } from 'solid-js';
import '../../styles/pill-toggle.css';

interface PillToggleProps {
  /** All selectable values. */
  items: string[];
  /** Currently-on subset of `items`. */
  selected: string[];
  onToggle: (item: string) => void;
  disabled?: boolean;
}

/**
 * A row of toggleable pills (multi-select). Selected pills are green
 * (`pill--on`), deselected are gray (`pill--off`). Used for per-group route
 * selection in the Setup wizard; reusable anywhere a chip-style multi-select fits.
 */
const PillToggle: Component<PillToggleProps> = (props) => (
  <div class="pill-toggle" role="group">
    <For each={props.items}>
      {(item) => {
        const on = () => props.selected.includes(item);
        return (
          <button
            type="button"
            class="pill"
            classList={{ 'pill--on': on(), 'pill--off': !on() }}
            data-state={on() ? 'on' : 'off'}
            data-value={item}
            aria-pressed={on()}
            disabled={props.disabled}
            onClick={() => props.onToggle(item)}
          >
            {item}
          </button>
        );
      }}
    </For>
  </div>
);

export default PillToggle;
