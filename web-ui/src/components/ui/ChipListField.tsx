import { Component, For, Show, createSignal, type JSX } from 'solid-js';
import Button from './Button';
import Input from './Input';

interface ChipListFieldProps {
  label: string;
  description?: JSX.Element;
  items: string[];
  placeholder?: string;
  /** Accent styling for the chips (enterprise/admin lists use it; regular users don't). */
  accent?: boolean;
  inputType?: 'text' | 'password' | 'search';
  /** Add the trimmed input value. Return true if accepted (clears the input), false to keep it. */
  onAdd: (value: string) => boolean;
  onRemove: (value: string) => void;
}

/**
 * A labelled "type a value, press Enter/Add, see it as a removable chip" field — the
 * pattern the setup wizard repeats for admin users, regular users, Access groups, and
 * dynamic routes. Emits the same DOM/classes the four ad-hoc copies did
 * (`.email-input-row` / `.email-tags` / `.email-tag[--accent]` / `.email-tag-remove`)
 * so the migration is behavior-preserving. Validation/dedup live in `onAdd`.
 */
const ChipListField: Component<ChipListFieldProps> = (props) => {
  const [value, setValue] = createSignal('');
  const submit = () => {
    if (props.onAdd(value())) setValue('');
  };

  return (
    <div class="setup-field">
      <label class="setup-field-label">{props.label}</label>
      <Show when={props.description}>
        <p class="setup-field-description">{props.description}</p>
      </Show>
      <div class="email-input-row">
        <Input
          type={props.inputType}
          value={value()}
          onInput={(v) => setValue(v)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder={props.placeholder}
        />
        <Button onClick={submit} variant="secondary" size="sm">Add</Button>
      </div>
      <div class="email-tags">
        <For each={props.items}>
          {(item) => (
            <span class={props.accent ? 'email-tag email-tag--accent' : 'email-tag'}>
              {item}
              <button
                type="button"
                class="email-tag-remove"
                onClick={() => props.onRemove(item)}
              >
                x
              </button>
            </span>
          )}
        </For>
      </div>
    </div>
  );
};

export default ChipListField;
