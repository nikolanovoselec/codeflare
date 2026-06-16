import { Component, For } from 'solid-js';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  /** Defaults to the wizard's `route-select` class so existing styling is preserved. */
  class?: string;
  onChange: (value: string) => void;
}

/**
 * Thin wrapper over a native `<select>` so dropdowns are composable (default route,
 * reasoning level, per-group default/reasoning, GitHub provider). Keeps the
 * `route-select` class by default so the setup-wizard styling is unchanged.
 */
const Select: Component<SelectProps> = (props) => (
  <select
    class={props.class ?? 'route-select'}
    value={props.value}
    disabled={props.disabled}
    onChange={(e) => props.onChange(e.currentTarget.value)}
  >
    <For each={props.options}>
      {(opt) => <option value={opt.value}>{opt.label}</option>}
    </For>
  </select>
);

export default Select;
