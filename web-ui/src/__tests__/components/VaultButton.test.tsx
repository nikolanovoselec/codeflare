import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import VaultButton from '../../components/VaultButton';

describe('VaultButton', () => {
  afterEach(() => cleanup());

  const btn = () => screen.getByTestId('header-vault-button');

  it('armed status is openable, carries the green-breathing class, and fires onOpen on click', () => {
    const onOpen = vi.fn();
    render(() => <VaultButton status="armed" onOpen={onOpen} />);
    expect(btn().dataset.vaultStatus).toBe('armed');
    expect(btn().getAttribute('aria-disabled')).toBe('false');
    expect(btn().classList.contains('header-vault-button--armed')).toBe(true);
    fireEvent.click(btn());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preparing status is not openable and carries the accent-breathing class', () => {
    const onOpen = vi.fn();
    render(() => <VaultButton status="preparing" onOpen={onOpen} />);
    expect(btn().dataset.vaultStatus).toBe('preparing');
    expect(btn().getAttribute('aria-disabled')).toBe('true');
    expect(btn().classList.contains('header-vault-button--preparing')).toBe(true);
    fireEvent.click(btn());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ready status is openable and fires onOpen', () => {
    const onOpen = vi.fn();
    render(() => <VaultButton status="ready" onOpen={onOpen} />);
    expect(btn().getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(btn());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('prewarming status is disabled and does not open', () => {
    const onOpen = vi.fn();
    render(() => <VaultButton status="prewarming" onOpen={onOpen} />);
    expect(btn().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('available status is openable (click 1 starts the prewarm) and carries no breathing class', () => {
    const onOpen = vi.fn();
    render(() => <VaultButton status="available" onOpen={onOpen} />);
    expect(btn().dataset.vaultStatus).toBe('available');
    expect(btn().getAttribute('aria-disabled')).toBe('false');
    expect(btn().classList.contains('header-vault-button--available')).toBe(true);
    expect(btn().classList.contains('header-vault-button--preparing')).toBe(false);
    expect(btn().classList.contains('header-vault-button--armed')).toBe(false);
    fireEvent.click(btn());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preparing auto-surfaces the status region without a click and wires aria-describedby', () => {
    render(() => <VaultButton status="preparing" onOpen={vi.fn()} />);
    // The focus-loss warning appears on its own the moment the button breathes.
    expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();
    expect(btn().getAttribute('aria-describedby')).toBe('header-vault-button-status');
  });

  it('armed auto-surfaces the ready region, then auto-hides it after 5s while the breathing class stays', () => {
    vi.useFakeTimers();
    try {
      render(() => <VaultButton status="armed" onOpen={vi.fn()} />);
      expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();
      vi.advanceTimersByTime(5000);
      expect(screen.queryByTestId('header-vault-status')).not.toBeInTheDocument();
      // The green breathing class is independent of the tooltip and remains.
      expect(btn().classList.contains('header-vault-button--armed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
