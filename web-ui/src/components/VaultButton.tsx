import { Component, createMemo } from 'solid-js';
import { mdiChartGantt } from '@mdi/js';
import Icon from './Icon';
import type { VaultPrewarmStatus } from '../lib/vault-prewarm';

interface VaultButtonProps {
  status: VaultPrewarmStatus;
  onOpen: () => void;
}

const VAULT_BUTTON_META: Record<VaultPrewarmStatus, { title: string; enabled: boolean }> = {
  idle: { title: 'Vault preparing…', enabled: false },
  prewarming: { title: 'Vault preparing…', enabled: false },
  ready: { title: 'Open vault', enabled: true },
  timeout: { title: 'Vault preparation timed out — retrying', enabled: false },
  error: { title: 'Vault preparation failed — retrying', enabled: false },
};

const VaultButton: Component<VaultButtonProps> = (props) => {
  const meta = createMemo(() => VAULT_BUTTON_META[props.status]);

  return (
    <button
      class={`header-vault-button header-vault-button--${props.status}`}
      data-testid="header-vault-button"
      data-vault-status={props.status}
      title={meta().title}
      aria-label={meta().title}
      type="button"
      disabled={!meta().enabled}
      onClick={() => {
        if (meta().enabled) props.onOpen();
      }}
    >
      <Icon path={mdiChartGantt} size={20} />
    </button>
  );
};

export default VaultButton;
