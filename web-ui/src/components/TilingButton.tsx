import { Component, Show } from 'solid-js';
import { mdiViewGridOutline } from '@mdi/js';
import Icon from './Icon';
import '../styles/tiling-button.css';

interface TilingButtonProps {
  sessionId: string;
  tabCount: number;
  isActive: boolean;
  onClick: () => void;
}

const TilingButton: Component<TilingButtonProps> = (props) => {
  const isVisible = () => props.tabCount >= 2;

  return (
    <Show when={isVisible()}>
      <button
        type="button"
        data-testid="tiling-button"
        data-active={props.isActive}
        class="tiling-button"
        aria-label="Toggle terminal tiling layout"
        title="Toggle terminal tiling layout"
        onClick={props.onClick}
      >
        <Icon path={mdiViewGridOutline} size={16} />

      </button>
    </Show>
  );
};

export default TilingButton;
