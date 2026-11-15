import { For, Show, createEffect, createUniqueId, untrack, type Component } from 'solid-js';
import { createRunInterval, RunIntervalField, validRunSeconds } from './OperatorRunSettings';
import { applicationSetting } from '../../../src/operators/application-configuration';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = (key: string) => !['__proto__', 'constructor', 'prototype'].includes(key);

const DurationField: Component<{ value: unknown; schema: Record<string, unknown>; disabled?: boolean;
  onChange: (seconds: number) => void }> = props => {
  const interval = createRunInterval(typeof props.value === 'number' ? props.value : Number.NaN);
  let emitted: number | undefined;
  createEffect(() => {
    const value = props.value;
    if (!Object.is(value, emitted)) untrack(() => interval.setSeconds(typeof value === 'number' ? value : Number.NaN));
  });
  return <RunIntervalField interval={interval} disabled={props.disabled}
    onChange={value => { emitted = value; props.onChange(value); }}
    label={typeof props.schema.title === 'string' ? props.schema.title : undefined}
    defaultSeconds={typeof props.schema.default === 'number' ? props.schema.default : undefined}
    description={typeof props.schema.description === 'string' ? props.schema.description : undefined} />;
};

/** A small scalar/object view of package-owned configuration; unknown saved fields survive edits. */
export const OperatorApplicationFields: Component<{
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  schedule?: { enabledPath: string; intervalSecondsPath: string };
}> = props => {
  const definition = () => ({ controlVersion: 1 as const, configurationSchema: props.schema, schedule: props.schedule });
  const pointer = (path: string[]) => '/' + path.map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  let retainedInterval: number | undefined;
  createEffect(() => {
    const path = props.schedule?.intervalSecondsPath;
    const value = path && applicationSetting(definition(), props.value, path);
    if (typeof value === 'number' && validRunSeconds(value)) retainedInterval = value;
  });
  const change = (path: string[], value: unknown) => {
    const update = (current: unknown, offset: number): Record<string, unknown> => {
      const next = object(current) ? { ...current } : {};
      const key = path[offset];
      if (!safeKey(key)) return next;
      next[key] = offset === path.length - 1 ? value : update(next[key], offset + 1);
      return next;
    };
    let next = update(props.value, 0);
    if (props.schedule && pointer(path) === props.schedule.enabledPath && value === false && retainedInterval !== undefined) {
      const intervalPath = props.schedule.intervalSecondsPath.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
      const restore = (current: unknown, offset: number): Record<string, unknown> => {
        const copy = object(current) ? { ...current } : {};
        const key = intervalPath[offset];
        if (!key || !safeKey(key)) return copy;
        copy[key] = offset === intervalPath.length - 1 ? retainedInterval : restore(copy[key], offset + 1);
        return copy;
      };
      next = restore(next, 0);
    }
    props.onChange(next);
  };
  const Fields: Component<{ schema: Record<string, unknown>; value: unknown; path: string[] }> = fields => {
    const entries = () => object(fields.schema.properties)
      ? Object.entries(fields.schema.properties).filter(([key, value]) => safeKey(key) && object(value)
        && (pointer([...fields.path, key]) !== props.schedule?.intervalSecondsPath
          || applicationSetting(definition(), props.value, props.schedule!.enabledPath) === true)) : [];
    return <For each={entries()}>{([key, raw]) => {
      const schema = raw as Record<string, unknown>;
      const path = [...fields.path, key];
      const id = createUniqueId();
      const title = () => typeof schema.title === 'string' ? schema.title : key;
      const value = () => object(fields.value) && Object.hasOwn(fields.value, key) ? fields.value[key] : schema.default;
      const required = () => Array.isArray(fields.schema.required) && fields.schema.required.includes(key);
      const options = () => Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : [];
      const numeric = () => schema.type === 'number' || schema.type === 'integer';
      let input: HTMLInputElement | undefined;
      const validationMessage = (value: unknown) => {
        if (numeric() || typeof value !== 'string' || !value) return '';
        if (typeof schema.maxLength === 'number' && Array.from(value).length > schema.maxLength)
          return `Enter no more than ${schema.maxLength} characters.`;
        if (typeof schema.pattern === 'string') {
          // Package patterns use ECMAScript syntax, not HTML pattern's Unicode-set syntax.
          try {
            if (!new RegExp(schema.pattern, 'u').test(value)) return 'Enter a value matching the required pattern.';
          } catch { return 'This field has an invalid validation pattern.'; }
        }
        return '';
      };
      createEffect(() => {
        const message = validationMessage(value());
        input?.setCustomValidity(message);
      });
      return <Show when={schema.type !== 'object'} fallback={<fieldset class="admin-form-grid">
        <legend>{title()}</legend><Fields schema={schema} value={value()} path={path} />
      </fieldset>}>
        <Show when={numeric() && schema.format === 'duration-seconds'} fallback={<Show when={schema.type === 'boolean'} fallback={<label class="admin-form-field" for={id}>
          <span>{title()}</span>
          <Show when={options().length > 0} fallback={<input ref={input} id={id} aria-label={title()}
            type={numeric() ? 'number' : 'text'} required={required()} disabled={props.disabled}
            step={schema.type === 'integer' ? 1 : 'any'}
            min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
            max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
            value={typeof value() === 'string' || typeof value() === 'number' ? String(value()) : ''}
            onInput={event => {
              const input = event.currentTarget;
              input.setCustomValidity(validationMessage(input.value));
              change(path, numeric() ? input.valueAsNumber : input.value);
            }} />}>
            <select id={id} aria-label={title()} value={typeof value() === 'string' ? String(value()) : ''}
              required={required()} disabled={props.disabled} onChange={event => change(path, event.currentTarget.value)}>
              <option value="">Choose</option><For each={options()}>{option => <option value={option}>{option}</option>}</For>
            </select>
          </Show>
          <Show when={typeof schema.description === 'string'}><small class="admin-help-text">{String(schema.description)}</small></Show>
        </label>}>
          <label class="operator-automatic-field"><input id={id} type="checkbox" checked={value() === true}
            disabled={props.disabled} onChange={event => change(path, event.currentTarget.checked)} />{title()}</label>
        </Show>}>
          <DurationField value={value()} schema={schema} disabled={props.disabled} onChange={value => change(path, value)} />
        </Show>
      </Show>;
    }}</For>;
  };
  return <Fields schema={props.schema} value={props.value} path={[]} />;
};

export default OperatorApplicationFields;
