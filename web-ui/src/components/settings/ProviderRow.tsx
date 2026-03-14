import { Component, Show, JSX } from 'solid-js';

interface ProviderRowProps {
  icon: Component<{ size?: number; class?: string; style?: JSX.CSSProperties }>;
  name: string;
  brandColor?: string;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  disconnecting?: boolean;
  testId?: string;
}

const ProviderRow: Component<ProviderRowProps> = (props) => {
  const ProviderIcon = props.icon;

  return (
    <div class="provider-row" data-testid={props.testId}>
      <Show when={props.connected}>
        <div class="provider-row-connected">
          <span class="provider-row-icon">
            <ProviderIcon size={28} />
          </span>
          <span class="provider-row-name">{props.name}</span>
          <span class="provider-row-badge" data-testid={props.testId ? `${props.testId}-badge` : undefined}>
            Connected
          </span>
          <button
            type="button"
            class="provider-row-disconnect"
            onClick={() => props.onDisconnect()}
            disabled={props.disconnecting}
          >
            {props.disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
      </Show>
      <Show when={!props.connected}>
        <button
          type="button"
          class="provider-row-connect-btn"
          style={{ background: props.brandColor || 'var(--color-bg-tertiary)' }}
          onClick={() => props.onConnect()}
        >
          <ProviderIcon size={24} />
          <span>Connect to {props.name}</span>
        </button>
      </Show>
    </div>
  );
};

export default ProviderRow;
