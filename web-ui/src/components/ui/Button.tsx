import { Component, JSX, Show } from 'solid-js';
import Icon from '../Icon';
import '../../styles/button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: JSX.Element;
}

const Button: Component<ButtonProps> = (props) => {
  const variant = () => props.variant || 'primary';
  const size = () => props.size || 'md';
  const iconPosition = () => props.iconPosition || 'left';
  const isLoading = () => props.loading || false;
  const isDisabled = () => props.disabled || isLoading();

  const iconSize = () => {
    switch (size()) {
      case 'sm':
        return 14;
      case 'lg':
        return 20;
      default:
        return 16;
    }
  };

  return (
    <button
      type="button"
      data-testid="button"
      data-variant={variant()}
      data-size={size()}
      data-loading={isLoading().toString()}
      data-icon-position={props.icon ? iconPosition() : undefined}
      class="button"
      disabled={isDisabled()}
      onClick={props.onClick}
    >
      <Show when={isLoading()}>
        <span class="button-spinner" />
      </Show>
      <Show when={!isLoading() && props.icon && iconPosition() === 'left'}>{(icon) =>
        <Icon path={icon() as string} size={iconSize()} class="button-icon" />
      }</Show>
      <span class="button-content">{props.children}</span>
      <Show when={!isLoading() && props.icon && iconPosition() === 'right'}>{(icon) =>
        <Icon path={icon() as string} size={iconSize()} class="button-icon" />
      }</Show>

    </button>
  );
};

export default Button;
