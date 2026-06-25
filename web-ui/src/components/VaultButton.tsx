import { Component, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { mdiChartGantt } from '@mdi/js';
import Icon from './Icon';
import type { VaultPrewarmStatus } from '../lib/vault-prewarm';

// On-demand 2-click model (REQ-VAULT-018): once the SB server is ready the button is
// `available` (clickable, no breathing). The FIRST click starts the prewarm and the
// button breathes in the accent colour (`preparing`, with a focus-loss warning
// tooltip); when indexing completes it breathes green (`armed`, "ready" tooltip) and
// the SECOND click opens the vault instantly. `idle` = SB server not ready yet.
export type VaultButtonStatus = VaultPrewarmStatus | 'preparing' | 'armed' | 'available';

// The 'armed' ("Your Vault is ready") tooltip auto-hides after this long; the green
// breathing stays as the persistent ready signal.
const VAULT_READY_MESSAGE_AUTO_HIDE_MS = 5000;

interface VaultButtonProps {
  status: VaultButtonStatus;
  onOpen: () => void;
}

const VAULT_BUTTON_META: Record<VaultButtonStatus, { title: string; message: string; enabled: boolean }> = {
  idle: {
    title: 'Vault waiting for this session',
    message: 'Vault is waiting for the session to be ready.',
    enabled: false,
  },
  available: {
    title: 'Open your Vault',
    message: 'Open your Vault',
    enabled: true,
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
  preparing: {
    title: 'Preparing your Vault…',
    message: 'Preparing your Vault — the terminal may briefly stop accepting input for a few seconds. It will come right back.',
    enabled: false,
  },
  armed: {
    title: 'Your Vault is ready.',
    message: 'Your Vault is ready.',
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

  // On-demand model: surface the status tooltip automatically. 'preparing' shows the
  // focus-loss warning the moment the button starts breathing; the 'armed' ready
  // confirmation auto-shows ONLY on the genuine preparing -> armed transition (the
  // moment the vault just became ready), then auto-hides after 5s (the green stays as
  // the persistent ready signal). It must NOT re-pop on a fresh mount that is already
  // armed — a warm reload / returning from the vault tab, which on the mobile
  // standalone PWA remounts the component — so we gate it on the previous status.
  let prevStatus: VaultButtonStatus | undefined;
  createEffect(() => {
    const status = props.status;
    const justBecameReady = prevStatus === 'preparing' && status === 'armed';
    prevStatus = status;
    if (status === 'preparing') {
      setShowMessage(true);
      return;
    }
    if (status === 'armed') {
      if (justBecameReady) {
        setShowMessage(true);
        const timer = setTimeout(() => setShowMessage(false), VAULT_READY_MESSAGE_AUTO_HIDE_MS);
        onCleanup(() => clearTimeout(timer));
      }
      return;
    }
    setShowMessage(false);
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
        aria-describedby={showMessage() ? messageId : undefined}
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
      <Show when={showMessage()}>
        <span id={messageId} class="header-vault-status" role="status" data-testid="header-vault-status">
          {meta().message}
        </span>
      </Show>
    </div>
  );
};

export default VaultButton;
