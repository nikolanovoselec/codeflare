import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import OperatorApplicationFields from '../../components/OperatorApplicationFields';

afterEach(cleanup);
const schema = { type: 'object', required: ['project'], properties: {
  project: { type: 'string', title: 'Project to summarize', maxLength: 80 },
  delivery: { type: 'object', title: 'Delivery', properties: {
    enabled: { type: 'boolean', title: 'Automatic runs', default: false },
    period: { type: 'integer', title: 'Repeat interval', minimum: 1, default: 300 },
  } },
} };

describe('application-owned configuration fields', () => {
  it('REQ-OPERATOR-209: renders a different application without first-party repository recognition or read mutations', () => {
    const original = { unrelated: { keep: ['exact'] } };
    let saved: Record<string, unknown> = original;
    render(() => <OperatorApplicationFields schema={schema} value={original} onChange={value => { saved = value; }} />);
    expect(screen.getByRole('textbox', { name: 'Project to summarize' })).toBeRequired();
    expect(screen.getByRole('checkbox', { name: 'Automatic runs' })).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Repeat interval' })).toHaveValue(300);
    expect(saved).toBe(original);
    expect(original).toEqual({ unrelated: { keep: ['exact'] } });
  });

  it('REQ-OPERATOR-209: renders all declared fields and nested leaves without an extra cutoff', () => {
    const properties: Record<string, unknown> = Object.fromEntries(Array.from({ length: 65 }, (_, index) =>
      [`field${index}`, { type: 'string', title: `Field ${index}` }]));
    let nested: Record<string, unknown> = { type: 'object', properties: { leaf: { type: 'string', title: 'Nested leaf' } } };
    for (let level = 0; level < 9; level++) nested = { type: 'object', properties: { next: nested } };
    properties.nested = nested;
    render(() => <OperatorApplicationFields schema={{ type: 'object', properties }} value={{}} onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Field 64' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Nested leaf' })).toBeVisible();
  });

  it('REQ-OPERATOR-209: edits nested declared values while preserving unrelated configuration', () => {
    const initial = { project: 'one', delivery: { enabled: false, period: 120, privateOption: 'keep' }, unrelated: ['keep'] };
    const [value, setValue] = createSignal<Record<string, unknown>>(initial);
    render(() => <OperatorApplicationFields schema={schema} value={value()} onChange={setValue} />);
    fireEvent.input(screen.getByRole('textbox', { name: 'Project to summarize' }), { target: { value: 'two' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Repeat interval' }), { target: { value: '127' } });
    expect(value()).toEqual({ project: 'two', delivery: { enabled: true, period: 127, privateOption: 'keep' }, unrelated: ['keep'] });
    expect(initial.delivery.enabled).toBe(false);
    expect(initial.project).toBe('one');
  });

  it('REQ-OPERATOR-209: declared string constraints invalidate initial and edited values and clear after correction', () => {
    const [value, setValue] = createSignal<Record<string, unknown>>({ project: 'a/b' });
    render(() => <form><OperatorApplicationFields schema={{ type: 'object', properties: {
      project: { type: 'string', title: 'Project', maxLength: 4, pattern: '^[A-Za-z0-9_-]+$' },
    } }} value={value()} onChange={setValue} /></form>);
    const project = screen.getByRole('textbox', { name: 'Project' }) as HTMLInputElement;
    expect(project.form!.checkValidity()).toBe(false);
    fireEvent.input(project, { target: { value: 'longer' } });
    expect(project.form!.checkValidity()).toBe(false);
    fireEvent.input(project, { target: { value: 'a-b' } });
    expect(project.form!.checkValidity()).toBe(true);
    fireEvent.input(project, { target: { value: 'a/b' } });
    expect(project.form!.checkValidity()).toBe(false);
    fireEvent.input(project, { target: { value: 'a_b' } });
    expect(project.form!.checkValidity()).toBe(true);
  });

  it('REQ-OPERATOR-209: reuses interval controls with the application default and exact wire seconds', () => {
    const configured = { delivery: { period: 120 } };
    const [value, setValue] = createSignal<Record<string, unknown>>(configured);
    const timed = { type: 'object', properties: { delivery: { type: 'object', properties: {
      period: { type: 'integer', title: 'Polling interval', format: 'duration-seconds', default: 300 },
    } } } };
    render(() => <OperatorApplicationFields schema={timed} value={value()} onChange={setValue} />);
    expect(screen.getByRole('spinbutton', { name: 'Polling interval' })).toHaveValue(2);
    expect(screen.getByRole('combobox', { name: 'Interval unit' })).toHaveValue('minutes');
    fireEvent.change(screen.getByRole('combobox', { name: 'Interval unit' }), { target: { value: 'hours' } });
    expect(value()).toEqual({ delivery: { period: 7200 } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Polling interval to default' }));
    expect(value()).toEqual({ delivery: { period: 300 } });
    expect(screen.getByRole('spinbutton', { name: 'Polling interval' })).toHaveValue(5);
    expect(configured.delivery.period).toBe(120);
  });

  it('REQ-OPERATOR-209: preserves the selected unit and exposes duration errors to native form validation', () => {
    const [value, setValue] = createSignal<Record<string, unknown>>({ period: 120 });
    render(() => <form><OperatorApplicationFields schema={{ type: 'object', properties: {
      period: { type: 'integer', title: 'Repeat interval', format: 'duration-seconds', default: 300 },
    } }} value={value()} onChange={setValue} /></form>);
    const unit = screen.getByRole('combobox', { name: 'Interval unit' });
    const quantity = screen.getByRole('spinbutton', { name: 'Repeat interval' }) as HTMLInputElement;
    fireEvent.change(unit, { target: { value: 'seconds' } });
    fireEvent.input(quantity, { target: { value: '60' } });
    expect(unit).toHaveValue('seconds');
    expect(quantity).toHaveValue(60);
    expect(value()).toEqual({ period: 60 });
    expect(quantity.form!.checkValidity()).toBe(true);
    fireEvent.input(quantity, { target: { value: '9007199254740992' } });
    expect(quantity.form!.checkValidity()).toBe(false);
  });

  it('REQ-OPERATOR-209: scheduling OFF retains the last valid interval and hides its editor', () => {
    const [value, setValue] = createSignal<Record<string, unknown>>({ delivery: { enabled: true, period: 120 } });
    const timed = { type: 'object', properties: { delivery: { type: 'object', properties: {
      enabled: { type: 'boolean', title: 'Automatic runs' },
      period: { type: 'integer', title: 'Repeat interval', format: 'duration-seconds', default: 300 },
    } } } };
    render(() => <OperatorApplicationFields schema={timed} value={value()} onChange={setValue}
      schedule={{ enabledPath: '/delivery/enabled', intervalSecondsPath: '/delivery/period' }} />);
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Repeat interval' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(value()).toEqual({ delivery: { enabled: false, period: 120 } });
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(screen.getByRole('spinbutton', { name: 'Repeat interval' })).toHaveValue(2);
  });

  it('REQ-OPERATOR-209: preserves disabled controls and exposes package choices as text, not executable markup', () => {
    const choices = { type: 'object', properties: {
      mode: { type: 'string', title: '<script>mode</script>', enum: ['brief', 'detailed'] },
    } };
    render(() => <OperatorApplicationFields schema={choices} value={{ mode: 'brief' }} disabled onChange={() => { throw Error('Disabled field changed'); }} />);
    expect(screen.getByRole('combobox', { name: '<script>mode</script>' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '<script>mode</script>' })).toHaveValue('brief');
    expect(document.querySelector('script')).toBeNull();
  });
});
