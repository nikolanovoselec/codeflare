import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import Checkbox from '../../components/ui/Checkbox';

afterEach(() => cleanup());

describe('Checkbox', () => {
  it('reflects the checked prop', () => {
    render(() => <Checkbox checked label="Opt" onChange={() => {}} />);
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it('routes the label prop into the DOM', () => {
    render(() => <Checkbox checked={false} label="My Option" onChange={() => {}} />);
    expect(screen.getByText('My Option')).toBeInTheDocument();
  });

  it('fires onChange with the new checked state', () => {
    const onChange = vi.fn();
    render(() => <Checkbox checked={false} label="Opt" onChange={onChange} />);
    fireEvent.click(document.querySelector('input[type="checkbox"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('honors the disabled prop', () => {
    render(() => <Checkbox checked={false} label="Opt" disabled onChange={() => {}} />);
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
  });
});
