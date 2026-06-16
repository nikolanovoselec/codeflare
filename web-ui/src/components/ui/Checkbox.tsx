import { Component } from 'solid-js';

interface CheckboxProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A labelled checkbox used for multi-select lists (the per-group route checklist).
 * Clicking the label toggles the box (native `<label>` wrapping). Carries the
 * `checkbox-field` class so the setup stylesheet can lay it out.
 */
const Checkbox: Component<CheckboxProps> = (props) => (
  <label class="checkbox-field" classList={{ 'checkbox-field--disabled': props.disabled }}>
    <input
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
    />
    <span>{props.label}</span>
  </label>
);

export default Checkbox;
