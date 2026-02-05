import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionContextMenu from '../../components/SessionContextMenu';

describe('SessionContextMenu', () => {
  const defaultProps = {
    isOpen: true,
    position: { x: 100, y: 200 },
    canStop: true,
    sessionName: 'Test Session',
    onStop: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup());

  describe('Rendering', () => {
    it('renders when isOpen is true', () => {
      render(() => <SessionContextMenu {...defaultProps} />);
      expect(screen.getByTestId('session-context-menu')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      render(() => <SessionContextMenu {...defaultProps} isOpen={false} />);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    });
  });

  describe('Stop action', () => {
    it('shows Stop option when canStop is true', () => {
      render(() => <SessionContextMenu {...defaultProps} />);
      expect(screen.getByTestId('context-menu-stop')).toBeInTheDocument();
    });

    it('hides Stop option when canStop is false', () => {
      render(() => <SessionContextMenu {...defaultProps} canStop={false} />);
      expect(screen.queryByTestId('context-menu-stop')).not.toBeInTheDocument();
    });

    it('calls onStop and onClose when Stop is clicked', () => {
      const onStop = vi.fn();
      const onClose = vi.fn();
      render(() => <SessionContextMenu {...defaultProps} onStop={onStop} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('context-menu-stop'));
      expect(onStop).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Delete action', () => {
    it('shows Delete option always', () => {
      render(() => <SessionContextMenu {...defaultProps} />);
      expect(screen.getByTestId('context-menu-delete')).toBeInTheDocument();
    });

    it('shows confirmation step on first click', () => {
      render(() => <SessionContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByTestId('context-menu-delete'));
      expect(screen.getByTestId('context-menu-delete-confirm')).toBeInTheDocument();
      expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    });

    it('calls onDelete on confirm click', () => {
      const onDelete = vi.fn();
      const onClose = vi.fn();
      render(() => <SessionContextMenu {...defaultProps} onDelete={onDelete} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('context-menu-delete'));
      fireEvent.click(screen.getByTestId('context-menu-delete-confirm'));
      expect(onDelete).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Viewport clamping', () => {
    it('clamps position to stay within viewport on right edge', () => {
      Object.defineProperty(window, 'innerWidth', { value: 400, writable: true, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true });

      render(() => <SessionContextMenu {...defaultProps} position={{ x: 380, y: 200 }} />);
      const menu = screen.getByTestId('session-context-menu');
      const left = parseInt(menu.style.left);
      // Should be clamped: 380 would overflow with 160px menu width
      expect(left).toBeLessThan(380);
    });

    it('clamps position to stay within viewport on bottom edge', () => {
      Object.defineProperty(window, 'innerWidth', { value: 800, writable: true, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 300, writable: true, configurable: true });

      render(() => <SessionContextMenu {...defaultProps} position={{ x: 100, y: 280 }} />);
      const menu = screen.getByTestId('session-context-menu');
      const top = parseInt(menu.style.top);
      expect(top).toBeLessThan(280);
    });
  });
});
