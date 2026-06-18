import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import DeployKeysSection from '../../../components/settings/DeployKeysSection';

const mockGetGithubStatus = vi.fn();
const mockDisconnectGithub = vi.fn().mockResolvedValue({ success: true });
const mockGetCloudflareStatus = vi.fn();
const mockDisconnectCloudflare = vi.fn().mockResolvedValue({ success: true });
const mockSelectCloudflareAccount = vi.fn().mockResolvedValue({ success: true, accountId: 'a' });

vi.mock('../../../api/github', () => ({
  getGithubStatus: () => mockGetGithubStatus(),
  disconnectGithub: () => mockDisconnectGithub(),
  githubConnectUrl: () => '/api/github/connect',
}));
vi.mock('../../../api/cloudflare', () => ({
  getCloudflareStatus: () => mockGetCloudflareStatus(),
  disconnectCloudflare: () => mockDisconnectCloudflare(),
  selectCloudflareAccount: (id: string) => mockSelectCloudflareAccount(id),
  cloudflareConnectUrl: () => '/api/cloudflare/connect',
}));

describe('DeployKeysSection (OAuth connect surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: false });
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: false });
  });

  afterEach(() => cleanup());

  it('composes GitHub + Cloudflare connect cards, each with its connect URL and a segmented scope-level control + subtitle', async () => {
    render(() => <DeployKeysSection />);
    await waitFor(() => expect(screen.getByTestId('github-connect-card')).toBeInTheDocument());
    expect(screen.getByTestId('cloudflare-connect-card')).toBeInTheDocument();
    expect(screen.getByTestId('github-connect-btn').getAttribute('data-href')).toContain('/api/github/connect');
    expect(screen.getByTestId('cloudflare-connect-btn').getAttribute('data-href')).toContain('/api/cloudflare/connect');
    // Both providers expose the segmented scope-level control (all three tiers) + explanatory subtitle.
    for (const p of ['github', 'cloudflare']) {
      for (const t of ['minimal', 'recommended', 'advanced']) {
        expect(screen.getByTestId(`${p}-tier-${t}`)).toBeInTheDocument();
      }
      expect(screen.getByTestId(`${p}-tier-desc`).textContent).toBeTruthy();
    }
    expect(screen.getByTestId('deploy-keys-hint')).toBeInTheDocument();
  });

  it('reflects a connected GitHub status and disconnects via the API', async () => {
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: true, login: 'octocat' });
    render(() => <DeployKeysSection />);
    await waitFor(() => expect(screen.getByTestId('github-disconnect-btn')).toBeInTheDocument());
    expect(screen.getByTestId('github-identity')).toHaveTextContent('octocat');
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    expect(mockDisconnectGithub).toHaveBeenCalled();
  });

  it('surfaces the Cloudflare account picker when connected without a selected account', async () => {
    mockGetCloudflareStatus.mockResolvedValue({
      configured: true,
      connected: true,
      accounts: [{ id: 'a', name: 'Acct A' }, { id: 'b', name: 'Acct B' }],
    });
    render(() => <DeployKeysSection />);
    await waitFor(() => expect(screen.getByTestId('cloudflare-connected-badge')).toBeInTheDocument());
    const picker = document.querySelector('.oauth-connect-account') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['a', 'b']);
    fireEvent.change(picker, { target: { value: 'b' } });
    expect(mockSelectCloudflareAccount).toHaveBeenCalledWith('b');
  });
});
