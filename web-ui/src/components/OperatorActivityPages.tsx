import { Show, type Component } from 'solid-js';

/** Identical five-entry navigation for Runs and Installed; each view retains its own cursor stack. */
const OperatorActivityPages: Component<{ label: string; hasNewer: boolean; hasNext: boolean;
  onNewer: () => void; onNext: () => void }> = props => <nav class="operator-activity-pages" aria-label={props.label}>
  <Show when={props.hasNewer}><button type="button" onClick={props.onNewer}>Newer 5</button></Show>
  <Show when={props.hasNext}><button type="button" onClick={props.onNext}>Load 5 more</button></Show>
</nav>;

export default OperatorActivityPages;
