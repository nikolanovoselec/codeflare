import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import StoragePanel from '../../components/StoragePanel';

// Mock StorageBrowser
vi.mock('../../components/StorageBrowser', () => ({
  default: () => <div data-testid="storage-browser">StorageBrowser</div>,
}));

describe('StoragePanel Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Panel Visibility', () => {
    it('should have open class when isOpen is true', () => {
      render(() => <StoragePanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('storage-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveClass('open');
    });

    it('should not have open class when isOpen is false', () => {
      render(() => <StoragePanel isOpen={false} onClose={() => {}} />);

      const panel = screen.getByTestId('storage-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).not.toHaveClass('open');
    });

    it('should show backdrop when open', () => {
      render(() => <StoragePanel isOpen={true} onClose={() => {}} />);

      const backdrop = screen.getByTestId('storage-panel-backdrop');
      expect(backdrop).toHaveClass('open');
    });

    it('should hide backdrop when closed', () => {
      render(() => <StoragePanel isOpen={false} onClose={() => {}} />);

      const backdrop = screen.getByTestId('storage-panel-backdrop');
      expect(backdrop).not.toHaveClass('open');
    });
  });

  describe('Contains Child Components', () => {
    it('should contain StorageBrowser', () => {
      render(() => <StoragePanel isOpen={true} onClose={() => {}} />);

      expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
    });
  });

  describe('Dismiss Behavior', () => {
    it('should call onClose when backdrop is clicked', () => {
      const handleClose = vi.fn();
      render(() => <StoragePanel isOpen={true} onClose={handleClose} />);

      const backdrop = screen.getByTestId('storage-panel-backdrop');
      fireEvent.click(backdrop);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when close button is clicked', () => {
      const handleClose = vi.fn();
      render(() => <StoragePanel isOpen={true} onClose={handleClose} />);

      const closeButton = screen.getByTestId('storage-panel-close-button');
      fireEvent.click(closeButton);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when Escape key is pressed on backdrop', () => {
      const handleClose = vi.fn();
      render(() => <StoragePanel isOpen={true} onClose={handleClose} />);

      const backdrop = screen.getByTestId('storage-panel-backdrop');
      fireEvent.keyDown(backdrop, { key: 'Escape' });

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose on Escape when panel is closed', () => {
      const handleClose = vi.fn();
      render(() => <StoragePanel isOpen={false} onClose={handleClose} />);

      const backdrop = screen.getByTestId('storage-panel-backdrop');
      fireEvent.keyDown(backdrop, { key: 'Escape' });

      expect(handleClose).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('should have correct ARIA attributes', () => {
      render(() => <StoragePanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('storage-panel');
      expect(panel).toHaveAttribute('role', 'dialog');
      expect(panel).toHaveAttribute('aria-label', 'Storage');
    });

    it('should have aria-hidden when closed', () => {
      render(() => <StoragePanel isOpen={false} onClose={() => {}} />);

      const panel = screen.getByTestId('storage-panel');
      expect(panel).toHaveAttribute('aria-hidden', 'true');
    });

    it('should not be aria-hidden when open', () => {
      render(() => <StoragePanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('storage-panel');
      expect(panel).toHaveAttribute('aria-hidden', 'false');
    });
  });
});
