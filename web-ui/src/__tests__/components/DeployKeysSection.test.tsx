import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import DeployKeysSection from '../../components/settings/DeployKeysSection';

const mockGetDeployKeys = vi.hoisted(() => vi.fn());
const mockUpdateDeployKeys = vi.hoisted(() => vi.fn());
const mockDeleteDeployKeys = vi.hoisted(() => vi.fn());

mockGetDeployKeys.mockResolvedValue({});
mockUpdateDeployKeys.mockResolvedValue({});
mockDeleteDeployKeys.mockResolvedValue(undefined);

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    getDeployKeys: (...args: unknown[]) => mockGetDeployKeys(...args),
    updateDeployKeys: (body: unknown) => mockUpdateDeployKeys(body),
    deleteDeployKeys: (...args: unknown[]) => mockDeleteDeployKeys(...args),
  };
});

// Mock window.open
const mockWindowOpen = vi.fn();
vi.stubGlobal('open', mockWindowOpen);

describe('DeployKeysSection Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDeployKeys.mockResolvedValue({});
    mockUpdateDeployKeys.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  // ─── Initial Load ────────────────────────────────────────────────────

  describe('initial load', () => {
    it('calls getDeployKeys on mount', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(mockGetDeployKeys).toHaveBeenCalledTimes(1);
      });
    });

    it('shows connect instructions when no tokens stored', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-instructions')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-cf-instructions')).toBeInTheDocument();
      });
    });

    it('shows connected state when tokens exist', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({
        githubToken: '****1234',
        cloudflareApiToken: '****abcd',
        cloudflareAccountId: 'acct-123',
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-status')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-cf-status')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-github-masked')).toHaveTextContent('****1234');
        expect(screen.getByTestId('deploy-cf-masked')).toHaveTextContent('****abcd');
        expect(screen.getByTestId('deploy-cf-account-id')).toHaveTextContent('acct-123');
      });
    });

    it('hides instructions when connected', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({
        githubToken: '****1234',
        cloudflareApiToken: '****abcd',
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.queryByTestId('deploy-github-instructions')).not.toBeInTheDocument();
        expect(screen.queryByTestId('deploy-cf-instructions')).not.toBeInTheDocument();
      });
    });
  });

  // ─── GitHub Connect ──────────────────────────────────────────────────

  describe('GitHub connect', () => {
    it('opens GitHub token URL in new tab on connect click', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-connect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('deploy-github-connect'));
      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining('github.com/settings/personal-access-tokens/new'),
        '_blank',
      );
    });

    it('saves GitHub token and shows masked result', async () => {
      mockUpdateDeployKeys.mockResolvedValueOnce({
        githubToken: '****5678',
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-token-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('deploy-github-token-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'github_pat_test1234567890' } });
      fireEvent.click(screen.getByTestId('deploy-github-save'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({
          githubToken: 'github_pat_test1234567890',
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-success')).toBeInTheDocument();
      });
    });

    it('shows error when save fails', async () => {
      mockUpdateDeployKeys.mockRejectedValueOnce(new Error('Invalid GitHub token'));

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-token-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('deploy-github-token-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'bad-token' } });
      fireEvent.click(screen.getByTestId('deploy-github-save'));

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-error')).toHaveTextContent('Invalid GitHub token');
      });
    });

    it('shows error when trying to save empty token', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-save')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('deploy-github-save'));

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-error')).toHaveTextContent('Paste a new token');
      });
      expect(mockUpdateDeployKeys).not.toHaveBeenCalled();
    });
  });

  // ─── GitHub Disconnect ───────────────────────────────────────────────

  describe('GitHub disconnect', () => {
    it('disconnects GitHub and clears token', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({ githubToken: '****1234' });
      mockUpdateDeployKeys.mockResolvedValueOnce({});

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-disconnect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('deploy-github-disconnect'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({ githubToken: null });
      });

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-success')).toHaveTextContent('disconnected');
      });
    });
  });

  // ─── Cloudflare Connect ──────────────────────────────────────────────

  describe('Cloudflare connect', () => {
    it('opens Cloudflare token URL in new tab on connect click', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-connect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('deploy-cf-connect'));
      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining('dash.cloudflare.com/profile/api-tokens'),
        '_blank',
      );
    });

    it('saves CF token and auto-selects single account', async () => {
      mockUpdateDeployKeys.mockResolvedValueOnce({
        cloudflareApiToken: '****abcd',
        cloudflareAccountId: 'acct-auto',
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-token-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('deploy-cf-token-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'cf-token-test' } });
      fireEvent.click(screen.getByTestId('deploy-cf-save'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({
          cloudflareApiToken: 'cf-token-test',
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-success')).toBeInTheDocument();
      });
    });

    it('shows account dropdown when multiple accounts', async () => {
      mockUpdateDeployKeys.mockResolvedValueOnce({
        cloudflareApiToken: '****abcd',
        cloudflareAccounts: [
          { id: 'acct-1', name: 'Personal' },
          { id: 'acct-2', name: 'Work' },
        ],
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-token-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('deploy-cf-token-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'cf-token-multi' } });
      fireEvent.click(screen.getByTestId('deploy-cf-save'));

      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-account-select')).toBeInTheDocument();
      });

      const dropdown = screen.getByTestId('deploy-cf-account-dropdown') as HTMLSelectElement;
      expect(dropdown.options).toHaveLength(3); // placeholder + 2 accounts
    });
  });

  // ─── Cloudflare Disconnect ───────────────────────────────────────────

  describe('Cloudflare disconnect', () => {
    it('disconnects Cloudflare and clears token + account', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({
        cloudflareApiToken: '****abcd',
        cloudflareAccountId: 'acct-123',
      });
      mockUpdateDeployKeys.mockResolvedValueOnce({});

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-disconnect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('deploy-cf-disconnect'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({ cloudflareApiToken: null });
      });

      await waitFor(() => {
        expect(screen.getByTestId('deploy-cf-success')).toHaveTextContent('disconnected');
      });
    });
  });

  // ─── Hint text ───────────────────────────────────────────────────────

  describe('hint text', () => {
    it('shows hint about next session start', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-keys-hint')).toHaveTextContent('next session start');
      });
    });
  });
});
