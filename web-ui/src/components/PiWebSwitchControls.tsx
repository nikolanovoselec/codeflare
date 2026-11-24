import { Show } from 'solid-js';
import type { PiWebStatus } from '../api/pi-web';
import '../styles/pi-web-chat.css';

interface PiWebSwitchControlsProps {
  phase?: PiWebStatus['phase'];
  problem?: string;
  canCancel?: boolean;
  onCancel: () => void;
  onRetry?: () => void;
}

export default function PiWebSwitchControls(props: PiWebSwitchControlsProps) {
  const message = () => {
    switch (props.phase) {
      case 'waiting':
      case 'stopping': return 'Stopping the current turn…';
      case 'releasing':
      case 'opening': return 'Switching Pi surface…';
      case 'failed': return 'Could not switch Pi surfaces.';
      case 'uncertain': return 'The Pi surface could not be confirmed.';
      default: return undefined;
    }
  };
  return (
    <Show when={message() || props.problem || props.onRetry}>
      <div class="pi-web-controls">
        <span role="status" aria-live="polite">{message()}</span>
        <Show when={props.problem}><span role="status">{props.problem}</span></Show>
        <Show when={props.phase === 'waiting' && props.canCancel !== false}>
          <button type="button" class="pi-web-action" onClick={() => props.onCancel()}>Cancel switch</button>
        </Show>
        <Show when={props.onRetry}>
          <button type="button" class="pi-web-action" onClick={() => props.onRetry?.()}>Retry switch</button>
        </Show>
      </div>
    </Show>
  );
}
