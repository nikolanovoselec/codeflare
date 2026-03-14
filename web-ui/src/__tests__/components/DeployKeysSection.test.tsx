import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import DeployKeysSection from '../../components/settings/DeployKeysSection';

const mockGetDeployKeys = vi.hoisted(() => vi.fn());
const mockUpdateDeployKeys = vi.hoisted(() => vi.fn());
const mockDeleteDeployKeys = vi.hoisted(() => vi.fn());

mockGetDeployKeys.mockResolvedValue({});
mockUpdateDeployKeys.mockResolvedValue({});
mockDeleteDeployKeys.mockResolvedValue(undefined);

vi.mock('../../api/client', () => ({
  getDeployKeys: (...args: unknown[]) => mockGetDeployKeys(...args),
  updateDeployKeys: (body: unknown) => mockUpdateDeployKeys(body),
  deleteDeployKeys: (...args: unknown[]) => mockDeleteDeployKeys(...args),
}));

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

  describe('provider rows', () => {
    it('renders GitHub and Cloudflare provider rows', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-row')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-cf-row')).toBeInTheDocument();
      });
    });

    it('shows Connect buttons when not connected', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        const rows = screen.getAllByText('Connect');
        expect(rows.length).toBe(2);
      });
    });

    it('shows Connected badges when tokens exist', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({
        githubToken: '****1234',
        cloudflareApiToken: '****abcd',
      });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-row-badge')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-cf-row-badge')).toBeInTheDocument();
      });
    });
  });

  describe('connect modal', () => {
    it('opens GitHub modal when Connect clicked', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Connect').length).toBeGreaterThan(0);
      });

      const connectButtons = screen.getAllByText('Connect');
      fireEvent.click(connectButtons[0].closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('connect-provider-modal')).toBeInTheDocument();
        expect(screen.getByText('Connect to GitHub')).toBeInTheDocument();
      });
    });

    it('opens external URL when brand button clicked', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Connect').length).toBeGreaterThan(0);
      });

      const connectButtons = screen.getAllByText('Connect');
      fireEvent.click(connectButtons[0].closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('cpm-external-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('cpm-external-btn'));
      expect(mockWindowOpen).toHaveBeenCalledWith(
        expect.stringContaining('github.com/settings/personal-access-tokens/new'),
        '_blank',
      );
    });

    it('saves token from modal', async () => {
      mockUpdateDeployKeys.mockResolvedValueOnce({ githubToken: '****5678' });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Connect').length).toBeGreaterThan(0);
      });

      const connectButtons = screen.getAllByText('Connect');
      fireEvent.click(connectButtons[0].closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('cpm-token-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('cpm-token-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'github_pat_test123' } });
      fireEvent.click(screen.getByTestId('cpm-save-btn'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({ githubToken: 'github_pat_test123' });
      });
    });

    it('closes modal on backdrop click', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Connect').length).toBeGreaterThan(0);
      });

      const connectButtons = screen.getAllByText('Connect');
      fireEvent.click(connectButtons[0].closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('cpm-backdrop')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('cpm-backdrop'));

      await waitFor(() => {
        expect(screen.queryByTestId('connect-provider-modal')).not.toBeInTheDocument();
      });
    });
  });

  describe('disconnect', () => {
    it('disconnects GitHub from provider row', async () => {
      mockGetDeployKeys.mockResolvedValueOnce({ githubToken: '****1234' });
      mockUpdateDeployKeys.mockResolvedValueOnce({});

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getAllByText('Disconnect').length).toBeGreaterThan(0);
      });

      const disconnectButtons = screen.getAllByText('Disconnect');
      fireEvent.click(disconnectButtons[0].closest('button')!);

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({ githubToken: null });
      });
    });
  });

  describe('hint text', () => {
    it('shows hint about next session start', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByTestId('deploy-keys-hint')).toHaveTextContent('next session start');
      });
    });
  });
});
