import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import DeployKeysSection from '../../../components/settings/DeployKeysSection';

const mockGetGithubStatus = vi.fn();
const mockDisconnectGithub = vi.fn().mockResolvedValue({ success: true });
const mockGetCloudflareStatus = vi.fn();
const mockDisconnectCloudflare = vi.fn();
const mockSelectCloudflareAccount = vi.fn();

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

// REQ-AGENT-018/064: Settings Integrations offers only configured Cloudflare.
// REQ-AGENT-028: scope selection remains an explicit user-owned OAuth action.
describe('DeployKeysSection (Settings Integrations)', () => {
  let originalLocation: Location;
  let location: { href: string };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGithubStatus.mockResolvedValue({ enabled: true, connected: true, login: 'octocat' });
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: false });
    mockDisconnectCloudflare.mockResolvedValue({ success: true });
    mockSelectCloudflareAccount.mockResolvedValue({ success: true, accountId: 'b' });
    originalLocation = window.location;
    location = { href: '' };
    Object.defineProperty(window, 'location', { value: location, writable: true });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('offers only Cloudflare, never GitHub or other provider placeholders', async () => {
    render(() => <DeployKeysSection />);
    expect(await screen.findByTestId('cloudflare-connect-btn')).toHaveTextContent('Connect Cloudflare');
    expect(screen.queryByTestId('github-connect-card')).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub|AWS|Amazon Web Services|Azure|GCP|Google Cloud/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not offer a provider before authoritative configured status has loaded', async () => {
    let resolve!: (value: { configured: boolean; connected: boolean }) => void;
    mockGetCloudflareStatus.mockReturnValueOnce(new Promise(response => { resolve = response; }));
    render(() => <DeployKeysSection />);
    expect(screen.queryByTestId('cloudflare-connect-card')).not.toBeInTheDocument();
    expect(screen.getByRole('status').textContent?.trim()).toBeTruthy();
    expect(screen.queryByText(/not configured|unconfigured/i)).not.toBeInTheDocument();
    expect(location.href).toBe('');
    resolve({ configured: true, connected: false });
    expect(await screen.findByTestId('cloudflare-connect-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-connected-badge')).not.toBeInTheDocument();
  });

  it.each([
    { configured: false, connected: false },
    { configured: false, connected: true, accountId: 'stale-account' },
    { connected: true, accountId: 'stale-account' },
  ])('does not infer provider availability from connection state: %j', async status => {
    let resolve!: (value: typeof status) => void;
    const response = new Promise<typeof status>(done => { resolve = done; });
    mockGetCloudflareStatus.mockReturnValueOnce(response);
    render(() => <DeployKeysSection />);
    resolve(status);
    await response;
    await waitFor(() => expect(screen.queryByTestId('cloudflare-connect-card')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Connect Cloudflare|Disconnect/ })).not.toBeInTheDocument();
    expect(location.href).toBe('');
  });

  it('does not offer Cloudflare when its configuration status read fails', async () => {
    const response = Promise.reject(new Error('Status unavailable'));
    mockGetCloudflareStatus.mockReturnValueOnce(response);
    render(() => <DeployKeysSection />);
    await response.catch(() => undefined);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent?.trim()).toBeTruthy();
    expect(screen.queryByText(/not configured|unconfigured/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-connect-card')).not.toBeInTheDocument();
    expect(location.href).toBe('');
  });

  it('requires a user Connect even with a configured client and carries each selected scope tier to OAuth', async () => {
    render(() => <DeployKeysSection />);
    const connect = await screen.findByTestId('cloudflare-connect-btn');
    expect(screen.queryByTestId('cloudflare-connected-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-disconnect-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('cloudflare-tier-recommended')).toBeChecked();
    expect(location.href).toBe('');
    for (const tier of ['recommended', 'minimal', 'advanced']) {
      fireEvent.click(screen.getByTestId(`cloudflare-tier-${tier}`));
      expect(screen.getByTestId(`cloudflare-tier-${tier}`)).toBeChecked();
      expect(screen.getByTestId('cloudflare-tier-desc').textContent?.trim()).toBeTruthy();
      expect(connect).toHaveAttribute('data-href', `/api/cloudflare/connect?tier=${tier}`);
      fireEvent.click(connect);
      expect(location.href).toBe(`/api/cloudflare/connect?tier=${tier}`);
    }
  });

  it('keeps account selection and refreshed selected identity for connected users', async () => {
    const accounts = [{ id: 'a', name: 'Acct A' }, { id: 'b', name: 'Acct B' }];
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accounts });
    mockSelectCloudflareAccount.mockImplementation(async (accountId: string) => {
      mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accounts, accountId });
      return { success: true, accountId };
    });
    render(() => <DeployKeysSection />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    const picker = screen.getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(picker.options).map(option => [option.value, option.textContent])).toEqual([
      ['a', 'Acct A'], ['b', 'Acct B'],
    ]);
    fireEvent.change(picker, { target: { value: 'b' } });
    expect(await screen.findByTestId('cloudflare-identity')).toHaveTextContent('b');
    expect(screen.getByRole('combobox')).toHaveValue('b');
    expect(mockSelectCloudflareAccount).toHaveBeenCalledWith('b');
    expect(screen.queryByTestId('cloudflare-connect-btn')).not.toBeInTheDocument();
  });

  it('waits for disconnect then refreshes to an available but disconnected provider', async () => {
    mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'a' });
    let finishDisconnect!: () => void;
    mockDisconnectCloudflare.mockImplementation(() => new Promise(resolve => {
      finishDisconnect = () => {
        mockGetCloudflareStatus.mockResolvedValue({ configured: true, connected: false });
        resolve({ success: true });
      };
    }));
    render(() => <DeployKeysSection />);
    const disconnect = await screen.findByTestId('cloudflare-disconnect-btn');
    fireEvent.click(disconnect);
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('cloudflare-connect-btn')).not.toBeInTheDocument();
    finishDisconnect();
    expect(await screen.findByTestId('cloudflare-connect-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-identity')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(location.href).toBe('');
  });
});
