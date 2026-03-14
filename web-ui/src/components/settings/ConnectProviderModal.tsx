import { Component, Show, For, createSignal, createEffect, onCleanup, JSX } from 'solid-js';
import { mdiClose, mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';
import Button from '../ui/Button';
import '../../styles/connect-provider-modal.css';

export interface ProviderConfig {
  id: string;
  name: string;
  icon: Component<{ size?: number; class?: string; style?: JSX.CSSProperties }>;
  brandColor: string;
  externalUrl: string;
  externalLabel: string;
  placeholder: string;
  instructions: readonly [string, string, string];
}

interface ConnectProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (token: string) => void;
  onDisconnect?: () => void;
  onSelectAccount?: (accountId: string) => void;
  provider: ProviderConfig;
  connectedToken?: string;
  accounts?: Array<{ id: string; name: string }>;
  accountId?: string;
  saving: boolean;
  message: string | null;
  error: string | null;
}

const ConnectProviderModal: Component<ConnectProviderModalProps> = (props) => {
  let inputRef: HTMLInputElement | undefined;
  let triggerRef: HTMLElement | undefined;
  const [tokenValue, setTokenValue] = createSignal('');

  const connected = () => !!props.connectedToken;

  // Reset token input when modal opens
  createEffect(() => {
    if (props.isOpen) {
      setTokenValue('');
      // Focus input after mount
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  // Escape key handler
  createEffect(() => {
    if (!props.isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
  });

  const handleSave = () => {
    const token = tokenValue().trim();
    if (!token) return;
    props.onSave(token);
  };

  const handleKeyDownInput = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
  };

  const ProviderIcon = props.provider.icon;

  return (
    <Show when={props.isOpen}>
      <div class="cpm-backdrop" onClick={() => props.onClose()} data-testid="cpm-backdrop" />
      <div
        class="connect-provider-modal"
        role="dialog"
        aria-label={connected() ? props.provider.name : `Connect to ${props.provider.name}`}
        data-testid="connect-provider-modal"
      >
        <button
          type="button"
          class="cpm-close"
          onClick={() => props.onClose()}
          title="Close"
          data-testid="cpm-close"
        >
          <Icon path={mdiClose} size={18} />
        </button>

        <div class="cpm-icon">
          <ProviderIcon size={48} />
        </div>

        <h2 class="cpm-heading">
          {connected() ? props.provider.name : `Connect to ${props.provider.name}`}
        </h2>

        <Show when={!connected()}>
          <ol class="cpm-instructions">
            <For each={[...props.provider.instructions]}>
              {(step) => <li>{step}</li>}
            </For>
          </ol>

          <button
            type="button"
            class="cpm-external-btn"
            style={{ background: props.provider.brandColor }}
            onClick={() => window.open(props.provider.externalUrl, '_blank')}
            data-testid="cpm-external-btn"
          >
            {props.provider.externalLabel}
          </button>

          <input
            ref={inputRef}
            type="password"
            class="cpm-token-input"
            value={tokenValue()}
            placeholder={props.provider.placeholder}
            autocomplete="off"
            onInput={(e) => setTokenValue(e.currentTarget.value)}
            onKeyDown={handleKeyDownInput}
            data-testid="cpm-token-input"
          />

          <button
            type="button"
            class="cpm-save-btn"
            disabled={props.saving || !tokenValue().trim()}
            onClick={handleSave}
            data-testid="cpm-save-btn"
          >
            <Show when={props.saving}>
              <span class="cpm-spinner" />
            </Show>
            Save
          </button>
        </Show>

        <Show when={connected()}>
          <span class="cpm-masked-token" data-testid="cpm-masked-token">
            {props.connectedToken}
          </span>

          <Show when={props.accountId}>
            <span class="cpm-account-id" data-testid="cpm-account-id">
              Account: {props.accountId}
            </span>
          </Show>

          <Show when={props.accounts && props.accounts.length > 1}>
            <div class="cpm-account-select" data-testid="cpm-account-select">
              <label for="cpm-account-dropdown">Select account:</label>
              <select
                id="cpm-account-dropdown"
                class="cpm-account-dropdown"
                value={props.accountId || ''}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  if (val) props.onSelectAccount?.(val);
                }}
                data-testid="cpm-account-dropdown"
              >
                <option value="" disabled>Choose an account...</option>
                <For each={props.accounts}>
                  {(account) => (
                    <option value={account.id}>{account.name}</option>
                  )}
                </For>
              </select>
            </div>
          </Show>

          <Show when={props.onDisconnect}>
            <Button
              variant="danger"
              size="md"
              onClick={() => props.onDisconnect?.()}
              loading={props.saving}
            >
              Disconnect
            </Button>
          </Show>
        </Show>

        <Show when={props.message}>
          {(message) => (
            <span class="cpm-success" data-testid="cpm-success">{message()}</span>
          )}
        </Show>
        <Show when={props.error}>
          {(error) => (
            <span class="cpm-error" data-testid="cpm-error">
              <Icon path={mdiAlertCircleOutline} size={14} /> {error()}
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
};

export default ConnectProviderModal;
