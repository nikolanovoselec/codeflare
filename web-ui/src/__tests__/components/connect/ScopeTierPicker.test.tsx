import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import ScopeTierPicker from '../../../components/connect/ScopeTierPicker';
import { GITHUB_TIERS, CLOUDFLARE_TIERS } from '../../../lib/token-scopes';

afterEach(() => cleanup());

describe('ScopeTierPicker', () => {
  it('presents all three tiers and marks the selected one active', () => {
    render(() => (
      <ScopeTierPicker provider="github" tiers={GITHUB_TIERS} selected="recommended" onSelect={() => {}} />
    ));
    for (const t of ['minimal', 'recommended', 'advanced']) {
      expect(screen.getByTestId(`github-tier-${t}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('github-tier-recommended').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('github-tier-minimal').getAttribute('data-state')).toBe('off');
    expect(screen.getByTestId('github-tier-advanced').getAttribute('data-state')).toBe('off');
  });

  it('fires onSelect with the clicked tier and scopes testids by provider', () => {
    const onSelect = vi.fn();
    render(() => (
      <ScopeTierPicker provider="cloudflare" tiers={CLOUDFLARE_TIERS} selected="recommended" onSelect={onSelect} />
    ));
    fireEvent.click(screen.getByTestId('cloudflare-tier-advanced'));
    expect(onSelect).toHaveBeenCalledWith('advanced');
  });

  it('renders a subtitle that tracks the selection (sourced from the catalog, not hardcoded)', () => {
    const { unmount } = render(() => (
      <ScopeTierPicker provider="github" tiers={GITHUB_TIERS} selected="minimal" onSelect={() => {}} />
    ));
    const minimalDesc = screen.getByTestId('github-tier-desc').textContent;
    expect(minimalDesc).toBeTruthy();
    unmount();
    render(() => (
      <ScopeTierPicker provider="github" tiers={GITHUB_TIERS} selected="advanced" onSelect={() => {}} />
    ));
    const advancedDesc = screen.getByTestId('github-tier-desc').textContent;
    expect(advancedDesc).toBeTruthy();
    // Different tier selected → different subtitle: proves the subtitle is wired to selection.
    expect(advancedDesc).not.toBe(minimalDesc);
  });
});
