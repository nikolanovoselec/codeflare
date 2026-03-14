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

    it('shows branded Connect buttons when not connected', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Connect to GitHub/)).toBeInTheDocument();
        expect(screen.getByText(/Connect to Cloudflare/)).toBeInTheDocument();
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

  describe('inline connect flow', () => {
    it('expands to show input when Connect clicked', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Connect to GitHub/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Connect to GitHub/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-row-input')).toBeInTheDocument();
        expect(screen.getByTestId('deploy-github-row-save')).toBeInTheDocument();
      });
    });

    it('saves token from inline input', async () => {
      mockUpdateDeployKeys.mockResolvedValueOnce({ githubToken: '****5678' });

      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Connect to GitHub/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Connect to GitHub/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-row-input')).toBeInTheDocument();
      });

      const input = screen.getByTestId('deploy-github-row-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'github_pat_test123' } });
      fireEvent.click(screen.getByTestId('deploy-github-row-save'));

      await waitFor(() => {
        expect(mockUpdateDeployKeys).toHaveBeenCalledWith({ githubToken: 'github_pat_test123' });
      });
    });

    it('shows external link to provider', async () => {
      render(() => <DeployKeysSection />);
      await waitFor(() => {
        expect(screen.getByText(/Connect to GitHub/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Connect to GitHub/).closest('button')!);

      await waitFor(() => {
        expect(screen.getByTestId('deploy-github-row-external')).toBeInTheDocument();
      });

      const link = screen.getByTestId('deploy-github-row-external') as HTMLAnchorElement;
      expect(link.href).toContain('github.com/settings/personal-access-tokens');
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
      fireEvent.click(disconnectButtons[0]);

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
