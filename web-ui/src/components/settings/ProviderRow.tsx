import { Component, Show, createSignal, JSX } from 'solid-js';
import { mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';

interface ProviderRowProps {
  icon: Component<{ size?: number; class?: string; style?: JSX.CSSProperties; fill?: string }>;
  name: string;
  brandColor?: string;
  externalUrl?: string;
  externalLabel?: string;
  placeholder?: string;
  connected: boolean;
  onSave: (token: string) => void;
  onDisconnect: () => void;
  saving?: boolean;
  disconnecting?: boolean;
  message?: string | null;
  error?: string | null;
  testId?: string;
}

const ProviderRow: Component<ProviderRowProps> = (props) => {
  const ProviderIcon = props.icon;
  const [expanded, setExpanded] = createSignal(false);
  const [tokenValue, setTokenValue] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const handleConnect = () => {
    // Open provider page AND expand input in one click
    if (props.externalUrl) {
      window.open(props.externalUrl, '_blank');
    }
    setExpanded(true);
    setTokenValue('');
    requestAnimationFrame(() => inputRef?.focus());
  };

  const handleSave = () => {
    const token = tokenValue().trim();
    if (!token) return;
    props.onSave(token);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setExpanded(false);
  };

  return (
    <div class="provider-row" data-testid={props.testId}>
      {/* Connected state */}
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
        <Show when={props.message}>
          <span class="provider-row-message">{props.message}</span>
        </Show>
      </Show>

      {/* Disconnected — collapsed: branded Connect button */}
      <Show when={!props.connected && !expanded()}>
        <button
          type="button"
          class="provider-row-connect-btn"
          style={{ background: props.brandColor || 'var(--color-bg-tertiary)' }}
          onClick={handleConnect}
        >
          <ProviderIcon size={24} fill="white" />
          <span>Connect to {props.name}</span>
        </button>
      </Show>

      {/* Disconnected — expanded: inline connect flow */}
      <Show when={!props.connected && expanded()}>
        <div class="provider-row-expand">
          <Show when={props.externalUrl}>
            <a
              class="provider-row-reopen-link"
              href={props.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={props.testId ? `${props.testId}-external` : undefined}
            >
              Didn't open? Click here to open {props.name}.
            </a>
          </Show>

          <div class="provider-row-input-group">
            <input
              ref={inputRef}
              type="password"
              class="provider-row-token-input"
              value={tokenValue()}
              placeholder={props.placeholder || 'Paste token...'}
              autocomplete="off"
              onInput={(e) => setTokenValue(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              data-testid={props.testId ? `${props.testId}-input` : undefined}
            />
            <button
              type="button"
              class="provider-row-save-btn"
              disabled={props.saving || !tokenValue().trim()}
              onClick={handleSave}
              data-testid={props.testId ? `${props.testId}-save` : undefined}
            >
              {props.saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          <div class="provider-row-expand-footer">
            <Show when={props.error}>
              <span class="provider-row-error">
                <Icon path={mdiAlertCircleOutline} size={14} /> {props.error}
              </span>
            </Show>
            <Show when={props.message}>
              <span class="provider-row-message">{props.message}</span>
            </Show>
            <button
              type="button"
              class="provider-row-cancel"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ProviderRow;
