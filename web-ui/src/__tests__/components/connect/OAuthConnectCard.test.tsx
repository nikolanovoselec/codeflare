import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import OAuthConnectCard from '../../../components/connect/OAuthConnectCard';
import { GITHUB_TIERS } from '../../../lib/token-scopes';
import { mdiGithub } from '@mdi/js';

afterEach(() => cleanup());

const base = {
  provider: 'cloudflare',
  icon: mdiGithub,
  name: 'Cloudflare',
  connectUrl: '/api/cloudflare/connect',
  onDisconnect: () => {},
};

describe('OAuthConnectCard', () => {
  describe('disconnected', () => {
    it('renders the connect button with the connect URL as its navigation contract', () => {
      render(() => <OAuthConnectCard {...base} status="disconnected" />);
      expect(screen.getByTestId('cloudflare-connect-card')).toBeInTheDocument();
      const btn = screen.getByTestId('cloudflare-connect-btn');
      expect(btn.getAttribute('data-href')).toBe('/api/cloudflare/connect');
      // No connected/connecting affordances in the disconnected state.
      expect(screen.queryByTestId('cloudflare-disconnect-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloudflare-connected-badge')).not.toBeInTheDocument();
    });

    it('offers the scope tiers as a segmented control + subtitle, encodes the selected tier into the connect URL, and routes changes', () => {
      const onSelect = vi.fn();
      render(() => (
        <OAuthConnectCard
          {...base}
          status="disconnected"
          tierOptions={{ tiers: GITHUB_TIERS, selected: 'advanced', onSelect }}
        />
      ));
      // Selected tier is encoded into the navigation contract.
      expect(screen.getByTestId('cloudflare-connect-btn').getAttribute('data-href')).toBe('/api/cloudflare/connect?tier=advanced');
      // Tier is a segmented control listing all three levels, the selected one marked.
      for (const t of ['minimal', 'recommended', 'advanced'] as const) {
        expect(screen.getByTestId(`cloudflare-tier-${t}`)).toBeInTheDocument();
      }
      expect(
        screen.getByTestId('cloudflare-tier-advanced').closest('.oauth-connect-tier-option')?.classList.contains('oauth-connect-tier-option--selected'),
      ).toBe(true);
      expect(
        screen.getByTestId('cloudflare-tier-minimal').closest('.oauth-connect-tier-option')?.classList.contains('oauth-connect-tier-option--selected'),
      ).toBe(false);
      // Subtitle reflects the SELECTED tier's description (catalog-sourced wiring, not arbitrary copy).
      expect(screen.getByTestId('cloudflare-tier-desc').textContent).toBe(GITHUB_TIERS.advanced.description);
      // Choosing a level routes through onSelect.
      fireEvent.click(screen.getByTestId('cloudflare-tier-minimal'));
      expect(onSelect).toHaveBeenCalledWith('minimal');
    });

    it('navigates to the connect URL on click', () => {
      const originalLocation = window.location;
      const mockLocation = { href: '', search: '', pathname: '/app/' };
      Object.defineProperty(window, 'location', { value: mockLocation, writable: true });

      render(() => <OAuthConnectCard {...base} status="disconnected" />);
      fireEvent.click(screen.getByTestId('cloudflare-connect-btn'));
      expect(mockLocation.href).toBe('/api/cloudflare/connect');

      Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
    });
  });

  describe('connecting', () => {
    it('shows the connecting state and neither connect nor disconnect buttons', () => {
      render(() => <OAuthConnectCard {...base} status="connecting" />);
      expect(screen.getByTestId('cloudflare-connecting')).toBeInTheDocument();
      expect(screen.queryByTestId('cloudflare-connect-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloudflare-disconnect-btn')).not.toBeInTheDocument();
    });
  });

  describe('connected', () => {
    it('renders identity + disconnect and fires onDisconnect', () => {
      const onDisconnect = vi.fn();
      render(() => (
        <OAuthConnectCard {...base} status="connected" identity="acme-co" onDisconnect={onDisconnect} />
      ));
      expect(screen.getByTestId('cloudflare-connected-badge')).toBeInTheDocument();
      expect(screen.getByTestId('cloudflare-identity')).toHaveTextContent('acme-co');
      expect(screen.queryByTestId('cloudflare-connect-btn')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('cloudflare-disconnect-btn'));
      expect(onDisconnect).toHaveBeenCalled();
    });

    it('renders an account picker and routes selection when accounts are provided', () => {
      const onSelectAccount = vi.fn();
      render(() => (
        <OAuthConnectCard
          {...base}
          status="connected"
          accounts={[{ id: 'a', name: 'Acct A' }, { id: 'b', name: 'Acct B' }]}
          selectedAccountId="a"
          onSelectAccount={onSelectAccount}
        />
      ));
      const select = document.querySelector('.oauth-connect-account') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['a', 'b']);
      fireEvent.change(select, { target: { value: 'b' } });
      expect(onSelectAccount).toHaveBeenCalledWith('b');
    });

    it('omits the account picker when no accounts are provided', () => {
      render(() => <OAuthConnectCard {...base} status="connected" identity="acme-co" />);
      expect(document.querySelector('.oauth-connect-account')).toBeNull();
    });
  });
});
