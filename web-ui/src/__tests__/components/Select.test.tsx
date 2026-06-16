import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import Select from '../../components/ui/Select';

afterEach(() => cleanup());

describe('Select', () => {
  const opts = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];

  it('renders one option per item with the default route-select class', () => {
    render(() => <Select value="a" options={opts} onChange={() => {}} />);
    const sel = document.querySelector('select.route-select') as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('fires onChange with the selected value', () => {
    const onChange = vi.fn();
    render(() => <Select value="a" options={opts} onChange={onChange} />);
    const sel = document.querySelector('select') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('honors the disabled prop', () => {
    render(() => <Select value="a" options={opts} disabled onChange={() => {}} />);
    expect((document.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
  });

  it('uses a custom class when provided', () => {
    render(() => <Select value="a" options={opts} class="custom-sel" onChange={() => {}} />);
    expect(document.querySelector('select.custom-sel')).not.toBeNull();
  });
});
