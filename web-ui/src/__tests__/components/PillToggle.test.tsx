import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import PillToggle from '../../components/ui/PillToggle';

afterEach(() => cleanup());

describe('PillToggle', () => {
  it('renders a pill per item', () => {
    render(() => <PillToggle items={['a', 'b', 'c']} selected={[]} onToggle={() => {}} />);
    expect(document.querySelectorAll('.pill').length).toBe(3);
  });

  it('marks selected pills on and the rest off', () => {
    render(() => <PillToggle items={['a', 'b']} selected={['b']} onToggle={() => {}} />);
    const a = document.querySelector('[data-value="a"]') as HTMLElement;
    const b = document.querySelector('[data-value="b"]') as HTMLElement;
    expect(a.getAttribute('data-state')).toBe('off');
    expect(b.getAttribute('data-state')).toBe('on');
    expect(a.classList.contains('pill--off')).toBe(true);
    expect(b.classList.contains('pill--on')).toBe(true);
  });

  it('fires onToggle with the value on click', () => {
    const onToggle = vi.fn();
    render(() => <PillToggle items={['a', 'b']} selected={[]} onToggle={onToggle} />);
    fireEvent.click(document.querySelector('[data-value="a"]')!);
    expect(onToggle).toHaveBeenCalledWith('a');
  });

  it('reflects aria-pressed for the selected state', () => {
    render(() => <PillToggle items={['a']} selected={['a']} onToggle={() => {}} />);
    expect((document.querySelector('[data-value="a"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not fire onToggle when disabled', () => {
    const onToggle = vi.fn();
    render(() => <PillToggle items={['a']} selected={[]} onToggle={onToggle} disabled />);
    fireEvent.click(document.querySelector('[data-value="a"]')!);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
