import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiSync } from '@mdi/js';
import IconButton from '../../components/ui/IconButton';

afterEach(() => cleanup());

describe('IconButton', () => {
  it('renders the given icon path', () => {
    render(() => <IconButton icon={mdiSync} label="Refresh" onClick={() => {}} testId="ib" />);
    expect(screen.getByTestId('ib').querySelector('path')?.getAttribute('d')).toBe(mdiSync);
  });

  it('exposes the label as aria-label', () => {
    render(() => <IconButton icon={mdiSync} label="Refresh" onClick={() => {}} testId="ib" />);
    expect(screen.getByTestId('ib').getAttribute('aria-label')).toBe('Refresh');
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(() => <IconButton icon={mdiSync} label="Refresh" onClick={onClick} testId="ib" />);
    fireEvent.click(screen.getByTestId('ib'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(() => <IconButton icon={mdiSync} label="Refresh" onClick={onClick} disabled testId="ib" />);
    fireEvent.click(screen.getByTestId('ib'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks the active face with aria-pressed + active class', () => {
    render(() => <IconButton icon={mdiSync} label="Flip" onClick={() => {}} active testId="ib" />);
    const btn = screen.getByTestId('ib');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('icon-button--active')).toBe(true);
  });

  it('spins the icon when spinning', () => {
    render(() => <IconButton icon={mdiSync} label="Refresh" onClick={() => {}} spinning testId="ib" />);
    expect(screen.getByTestId('ib').querySelector('.icon-button-spin')).not.toBeNull();
  });
});
