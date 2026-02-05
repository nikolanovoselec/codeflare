import { Component, Show } from 'solid-js';
import Icon from '../Icon';
import '../../styles/input.css';

interface InputProps {
  type?: 'text' | 'password' | 'search';
  value?: string;
  onInput?: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  icon?: string;
  placeholder?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
}

const Input: Component<InputProps> = (props) => {
  const type = () => props.type || 'text';
  const hasIcon = () => !!props.icon;
  const hasError = () => !!props.error;

  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLInputElement;
    props.onInput?.(target.value);
  };

  return (
    <div class="input-container">
      <div
        data-testid="input-wrapper"
        data-has-icon={hasIcon().toString()}
        data-error={hasError().toString()}
        class="input-wrapper"
      >
        <Show when={props.icon}>{(icon) =>
          <span class="input-icon">
            <Icon path={icon()} size={18} />
          </span>
        }</Show>
        <input
          data-testid="input"
          type={type()}
          value={props.value || ''}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onInput={handleInput}
          onKeyDown={props.onKeyDown}
          class="input"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
        />
      </div>

      <Show when={props.error}>
        <span data-testid="input-error" class="input-error">
          {props.error}
        </span>
      </Show>

      <Show when={props.hint && !props.error}>
        <span data-testid="input-hint" class="input-hint">
          {props.hint}
        </span>
      </Show>

    </div>
  );
};

export default Input;
