import { Component, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { mdiChartGantt } from '@mdi/js';
import Icon from './Icon';
import type { VaultPrewarmStatus } from '../lib/vault-prewarm';

interface VaultButtonProps {
  status: VaultPrewarmStatus;
  onOpen: () => void;
}

const VAULT_BUTTON_META: Record<VaultPrewarmStatus, { title: string; message: string; enabled: boolean }> = {
  idle: {
    title: 'Vault waiting for this session',
    message: 'Vault is waiting for the session to be ready.',
    enabled: false,
  },
  prewarming: {
    title: 'Vault preparing on this device',
    message: 'Preparing Vault on this device. First use in a browser can take a few minutes.',
    enabled: false,
  },
  ready: {
    title: 'Open vault',
    message: 'Open vault',
    enabled: true,
  },
  timeout: {
    title: 'Vault preparation is still running',
    message: 'Vault preparation is still running on this device. Retrying…',
    enabled: false,
  },
  error: {
    title: 'Vault preparation failed',
    message: 'Vault preparation failed on this device. Retrying…',
    enabled: false,
  },
};

const VaultButton: Component<VaultButtonProps> = (props) => {
  const meta = createMemo(() => VAULT_BUTTON_META[props.status]);
  const [showMessage, setShowMessage] = createSignal(false);
  const messageId = 'header-vault-button-status';
  let wrapRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!showMessage() || typeof document === 'undefined') return;
    const dismissOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapRef?.contains(target)) return;
      setShowMessage(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowMessage(false);
    };
    document.addEventListener('click', dismissOnOutsideClick);
    document.addEventListener('keydown', dismissOnEscape);
    onCleanup(() => {
      document.removeEventListener('click', dismissOnOutsideClick);
      document.removeEventListener('keydown', dismissOnEscape);
    });
  });

  return (
    <div class="header-vault-button-wrap" ref={(el) => { wrapRef = el; }}>
      <button
        class={`header-vault-button header-vault-button--${props.status}`}
        data-testid="header-vault-button"
        data-vault-status={props.status}
        title={meta().title}
        aria-label={meta().title}
        aria-disabled={meta().enabled ? 'false' : 'true'}
        aria-describedby={!meta().enabled && showMessage() ? messageId : undefined}
        data-disabled={meta().enabled ? 'false' : 'true'}
        type="button"
        onClick={(event) => {
          if (!meta().enabled) {
            event.preventDefault();
            setShowMessage(true);
            return;
          }
          setShowMessage(false);
          props.onOpen();
        }}
      >
        <Icon path={mdiChartGantt} size={20} />
      </button>
      <Show when={!meta().enabled && showMessage()}>
        <span id={messageId} class="header-vault-status" role="status" data-testid="header-vault-status">
          {meta().message}
        </span>
      </Show>
    </div>
  );
};

export default VaultButton;
