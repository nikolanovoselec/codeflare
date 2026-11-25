import { Show } from 'solid-js';
import { mdiLoading } from '@mdi/js';
import Icon from './Icon';
import type { PiWebStatus } from '../api/pi-web';
import '../styles/pi-web-chat.css';

interface PiWebSwitchControlsProps {
  phase?: PiWebStatus['phase'];
  target?: PiWebStatus['target'];
  switching?: boolean;
  progressInMenu?: boolean;
  problem?: string;
  canCancel?: boolean;
  onCancel: () => void;
  onRetry?: () => void;
}

export default function PiWebSwitchControls(props: PiWebSwitchControlsProps) {
  const entering = () => {
    if (props.progressInMenu) return undefined;
    if (!props.switching && !['waiting', 'stopping', 'releasing', 'opening'].includes(props.phase ?? '')) return;
    return props.target === 'chat' ? 'Entering Vibe mode...' : props.target === 'terminal' ? 'Entering Code mode...' : undefined;
  };
  const message = () => {
    if (entering()) return entering();
    switch (props.phase) {
      case 'failed': return 'Could not switch Pi surfaces.';
      case 'uncertain': return 'The Pi surface could not be confirmed.';
      default: return undefined;
    }
  };
  return (
    <Show when={message() || props.problem || props.onRetry}>
      <div class="pi-web-controls">
        <Show when={entering()}><Icon path={mdiLoading} size={16} class="animate-spin" aria-hidden="true" /></Show>
        <span role="status" aria-live="polite">{message()}</span>
        <Show when={props.problem}><span role="status">{props.problem}</span></Show>
        <Show when={!props.progressInMenu && props.phase === 'waiting' && props.canCancel !== false}>
          <button type="button" class="pi-web-action" onClick={() => props.onCancel()}>Cancel switch</button>
        </Show>
        <Show when={props.onRetry}>
          <button type="button" class="pi-web-action" onClick={() => props.onRetry?.()}>Retry switch</button>
        </Show>
      </div>
    </Show>
  );
}
