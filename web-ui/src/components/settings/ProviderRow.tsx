import { Component, Show, JSX } from 'solid-js';
import Button from '../ui/Button';

interface ProviderRowProps {
  icon: Component<{ size?: number; class?: string; style?: JSX.CSSProperties }>;
  name: string;
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
      <span class="provider-row-icon">
        <ProviderIcon size={20} />
      </span>
      <span class="provider-row-name">{props.name}</span>
      <Show when={props.connected}>
        <span class="provider-row-badge" data-testid={props.testId ? `${props.testId}-badge` : undefined}>
          Connected
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => props.onDisconnect()}
          loading={props.disconnecting}
        >
          Disconnect
        </Button>
      </Show>
      <Show when={!props.connected}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => props.onConnect()}
        >
          Connect
        </Button>
      </Show>
    </div>
  );
};

export default ProviderRow;
