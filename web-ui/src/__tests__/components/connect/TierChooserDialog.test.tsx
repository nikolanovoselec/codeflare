import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignal } from 'solid-js';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import TierChooserDialog from '../../../components/connect/TierChooserDialog';
import { GITHUB_TIERS } from '../../../lib/token-scopes';

afterEach(() => cleanup());

const TIERS = ['minimal', 'recommended', 'advanced'] as const;

const base = {
  provider: 'github',
  tiers: GITHUB_TIERS,
  selected: 'recommended' as const,
  onClose: () => {},
  onPick: () => {},
};

describe('TierChooserDialog', () => {
  it('renders nothing while closed', () => {
    render(() => <TierChooserDialog {...base} open={false} />);
    expect(screen.queryByTestId('github-tier-dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.csd-backdrop')).toBeNull();
  });

  it('offers every tier with its catalog label + description when open', () => {
    render(() => <TierChooserDialog {...base} open={true} />);
    expect(screen.getByTestId('github-tier-dialog')).toBeInTheDocument();
    for (const t of TIERS) {
      const row = screen.getByTestId(`github-tier-${t}`);
      // Each row routes the catalog label + description (data wiring, not hardcoded copy).
      expect(row.querySelector('.csd-agent-label')?.textContent).toBe(GITHUB_TIERS[t].label);
      expect(row.querySelector('.csd-agent-desc')?.textContent).toBe(GITHUB_TIERS[t].description);
    }
  });

  it('marks the selected tier row and only that row', () => {
    render(() => <TierChooserDialog {...base} open={true} selected="advanced" />);
    expect(screen.getByTestId('github-tier-advanced').classList.contains('csd-agent-btn--last-used')).toBe(true);
    expect(screen.getByTestId('github-tier-minimal').classList.contains('csd-agent-btn--last-used')).toBe(false);
  });

  it('fires onPick with the chosen tier (pick = connect)', () => {
    const onPick = vi.fn();
    render(() => <TierChooserDialog {...base} open={true} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('github-tier-minimal'));
    expect(onPick).toHaveBeenCalledWith('minimal');
  });

  it('closes on backdrop click and on Escape', () => {
    const onClose = vi.fn();
    render(() => <TierChooserDialog {...base} open={true} onClose={onClose} />);
    fireEvent.click(document.querySelector('.csd-backdrop') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('is a focus-managed modal: marks aria-modal and moves focus into the dialog on open', () => {
    render(() => <TierChooserDialog {...base} open={true} />);
    const dialog = screen.getByTestId('github-tier-dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus moves into the dialog so keyboard users are inside the modal.
    expect(document.activeElement).toBe(dialog);
  });

  it('traps Tab focus, wrapping last→first and first→last within the dialog', () => {
    render(() => <TierChooserDialog {...base} open={true} />);
    const tiers = ['minimal', 'recommended', 'advanced'].map((t) => screen.getByTestId(`github-tier-${t}`));
    const first = tiers[0];
    const last = tiers[tiers.length - 1];
    // Tab from the last focusable wraps back to the first.
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    // Shift+Tab from the first focusable wraps to the last.
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the trigger when it closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const [open, setOpen] = createSignal(true);
    render(() => <TierChooserDialog {...base} open={open()} anchorRef={trigger} />);
    // Closing the dialog returns focus to the trigger (the connect button).
    setOpen(false);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('scopes its testids by provider so two instances stay distinct', () => {
    render(() => <TierChooserDialog {...base} provider="cloudflare" open={true} />);
    expect(screen.getByTestId('cloudflare-tier-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('cloudflare-tier-recommended')).toBeInTheDocument();
  });
});
