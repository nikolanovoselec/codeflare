import { For, Show, createSignal, createUniqueId, type Component } from 'solid-js';
import '../styles/operator-run-settings.css';

const units = { seconds: 1, minutes: 60, hours: 3600 } as const;
type Unit = keyof typeof units;
export const validRunSeconds = (seconds: number) => Number.isSafeInteger(seconds) && seconds > 0
  && Number.isFinite(new Date(Date.now() + seconds * 1000).getTime());

/** Keep exact seconds on the wire, including values not divisible by a larger unit. */
export function createRunInterval(seconds = 3600) {
  const [quantity, setQuantity] = createSignal(1);
  const [unit, setUnit] = createSignal<Unit>('hours');
  const setSeconds = (value: number) => {
    const next: Unit = value % 3600 === 0 ? 'hours' : value % 60 === 0 ? 'minutes' : 'seconds';
    setUnit(next); setQuantity(value / units[next]);
  };
  setSeconds(seconds);
  const value = () => quantity() * units[unit()];
  return { quantity, setQuantity, unit, setUnit, seconds: value, setSeconds,
    valid: () => Number.isSafeInteger(quantity()) && quantity() > 0 && validRunSeconds(value()) };
}
export const runSettingsSaved = 'Run settings saved. Installation is disabled; Enable installation when ready. Start automatic runs is separate.';
export const runSettingsHelp = 'Saving run settings disables this installation. It does not start a run. Enable installation and Start automatic runs are separate actions.';

export const AutomaticRunsField: Component<{ checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }> = props =>
  <label class="operator-automatic-field"><input type="checkbox" checked={props.checked} disabled={props.disabled}
    onChange={event => props.onChange(event.currentTarget.checked)} /> Automatic runs</label>;

export const RunIntervalField: Component<{ interval: ReturnType<typeof createRunInterval>; disabled?: boolean }> = props => {
  const id = createUniqueId();
  return <div class="operator-run-interval">
    <div class="operator-interval">
      <label class="admin-form-field">Repeat interval<input type="number" min="1" step="1" required
        value={Number.isFinite(props.interval.quantity()) ? props.interval.quantity() : ''}
        aria-invalid={!props.interval.valid()} aria-describedby={`${id}-help${!props.interval.valid() ? ` ${id}-error` : ''}`}
        disabled={props.disabled} onInput={event => props.interval.setQuantity(event.currentTarget.valueAsNumber)} /></label>
      <label class="admin-form-field">Interval unit<select value={props.interval.unit()} disabled={props.disabled}
        onChange={event => props.interval.setUnit(event.currentTarget.value as Unit)}>
        <For each={Object.keys(units) as Unit[]}>{unit => <option value={unit}>{unit}</option>}</For>
      </select></label>
    </div>
    <button type="button" class="admin-secondary-button" disabled={props.disabled}
      aria-label="Reset Repeat interval to default" onClick={() => props.interval.setSeconds(3600)}>Reset interval</button>
    <small id={`${id}-help`}>Default: 1 hour. Turning automatic runs off retains the interval and leaves manual runs available.</small>
    <Show when={!props.interval.valid()}><p id={`${id}-error`} role="alert">Enter a valid interval: positive whole seconds within the supported range.</p></Show>
  </div>;
};
