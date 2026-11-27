import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignal, Show } from 'solid-js';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import VaultButton, { type VaultButtonStatus } from '../../components/VaultButton';

// REQ-VAULT-019: Vault key-recoverable open gate
// REQ-VAULT-022: Vault armed-state open flow and persistence

describe('VaultButton', () => {
  afterEach(() => cleanup());

  const btn = () => screen.getByTestId('header-vault-button');

  it('preserves guarded Vault feedback and activation as a labeled Profile action', () => {
    const [status, setStatus] = createSignal<VaultButtonStatus>('prewarming');
    const onOpen = vi.fn();
    render(() => <VaultButton status={status()} onOpen={onOpen} inProfile />);
    expect(btn()).toHaveTextContent('Vault');
    fireEvent.click(btn());
    expect(screen.getByRole('status')).toHaveTextContent('Preparing Vault on this device');
    expect(onOpen).not.toHaveBeenCalled();
    setStatus('ready');
    fireEvent.click(btn());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 'idle' as const, feedback: 'Vault is waiting for the session to be ready.' },
    { status: 'prewarming' as const, feedback: 'Preparing Vault on this device. First use in a browser can take a few minutes.' },
  ])('REQ-VAULT-033 AC3: unavailable $status control stays visible and explains the wait without opening', ({ status, feedback }) => {
    const [opened, setOpened] = createSignal(false);
    render(() => <>
      <VaultButton status={status} onOpen={() => setOpened(true)} />
      <Show when={opened()}><p>Editor opened</p></Show>
    </>);
    expect(btn()).toBeVisible();
    expect(btn()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(btn());
    expect(screen.getByRole('status')).toHaveTextContent(feedback);
    expect(btn()).toBeVisible();
    expect(screen.queryByText('Editor opened')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(btn()).toBeVisible();
  });

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

  it.each(['timeout', 'error'] as const)('%s never retries in the background and one user click starts exactly one retry', (status) => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      render(() => <VaultButton status={status} onOpen={onOpen} />);

      expect(btn().getAttribute('aria-disabled')).toBe('false');
      expect(btn().getAttribute('title')).toBe('Retry Vault preparation');
      vi.advanceTimersByTime(60_000);
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.click(btn());
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preparing auto-surfaces the status region without a click and wires aria-describedby', () => {
    render(() => <VaultButton status="preparing" onOpen={vi.fn()} />);
    // The focus-loss warning appears on its own the moment the button breathes.
    expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();
    expect(btn()).toHaveAccessibleDescription(/Preparing your Vault/);
  });

  it('armed auto-surfaces the ready region on the genuine preparing->armed transition, then auto-hides after 5s while the breathing class stays', () => {
    vi.useFakeTimers();
    try {
      const [status, setStatus] = createSignal<VaultButtonStatus>('preparing');
      render(() => <VaultButton status={status()} onOpen={vi.fn()} />);
      // Transition preparing -> armed: the ready confirmation surfaces.
      setStatus('armed');
      expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();
      vi.advanceTimersByTime(5000);
      expect(screen.queryByTestId('header-vault-status')).not.toBeInTheDocument();
      // The green breathing class is independent of the tooltip and remains.
      expect(btn().classList.contains('header-vault-button--armed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh already-armed remount does not re-pop the ready tooltip', () => {
    // No preparing->armed transition happened in this mount, so the confirmation
    // stays hidden when returning from the Vault tab within this dashboard lifetime.
    render(() => <VaultButton status="armed" onOpen={vi.fn()} />);
    expect(screen.queryByTestId('header-vault-status')).not.toBeInTheDocument();
    // Still green and openable on a single click.
    expect(btn().classList.contains('header-vault-button--armed')).toBe(true);
    expect(btn().getAttribute('aria-disabled')).toBe('false');
  });
});
