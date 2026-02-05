import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import TilingOverlay from '../../components/TilingOverlay';
import type { TileLayout } from '../../types';

describe('TilingOverlay Component', () => {
  const mockOnSelectLayout = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Layout Option Visibility', () => {
    it('should show only tabbed and 2-split when tabCount=2', () => {
      render(() => (
        <TilingOverlay
          tabCount={2}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByTestId('tiling-option-tabbed')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-2-split')).toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-3-split')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-4-grid')).not.toBeInTheDocument();
    });

    it('should show tabbed, 2-split and 3-split when tabCount=3', () => {
      render(() => (
        <TilingOverlay
          tabCount={3}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByTestId('tiling-option-tabbed')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-2-split')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-3-split')).toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-4-grid')).not.toBeInTheDocument();
    });

    it('should show tabbed, 2-split, 3-split and 4-grid when tabCount>=4', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByTestId('tiling-option-tabbed')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-2-split')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-3-split')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-4-grid')).toBeInTheDocument();
    });

    it('should show all options when tabCount=6', () => {
      render(() => (
        <TilingOverlay
          tabCount={6}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByTestId('tiling-option-tabbed')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-2-split')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-3-split')).toBeInTheDocument();
      expect(screen.getByTestId('tiling-option-4-grid')).toBeInTheDocument();
    });

    it('should not show any split options when tabCount=1', () => {
      render(() => (
        <TilingOverlay
          tabCount={1}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByTestId('tiling-option-tabbed')).toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-2-split')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-3-split')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tiling-option-4-grid')).not.toBeInTheDocument();
    });
  });

  describe('Current Layout Highlighting', () => {
    it('should highlight tabbed layout when current', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const tabbedOption = screen.getByTestId('tiling-option-tabbed');
      expect(tabbedOption).toHaveClass('tiling-option--active');
    });

    it('should highlight 2-split layout when current', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="2-split"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-2-split');
      expect(splitOption).toHaveClass('tiling-option--active');
    });

    it('should highlight 3-split layout when current', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="3-split"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-3-split');
      expect(splitOption).toHaveClass('tiling-option--active');
    });

    it('should highlight 4-grid layout when current', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="4-grid"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const gridOption = screen.getByTestId('tiling-option-4-grid');
      expect(gridOption).toHaveClass('tiling-option--active');
    });

    it('should not highlight non-current layouts', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="2-split"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const tabbedOption = screen.getByTestId('tiling-option-tabbed');
      const gridOption = screen.getByTestId('tiling-option-4-grid');

      expect(tabbedOption).not.toHaveClass('tiling-option--active');
      expect(gridOption).not.toHaveClass('tiling-option--active');
    });
  });

  describe('Layout Selection', () => {
    it('should call onSelectLayout with tabbed when tabbed option clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="2-split"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const tabbedOption = screen.getByTestId('tiling-option-tabbed');
      fireEvent.click(tabbedOption);

      expect(mockOnSelectLayout).toHaveBeenCalledWith('tabbed');
    });

    it('should call onSelectLayout with 2-split when 2-split option clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-2-split');
      fireEvent.click(splitOption);

      expect(mockOnSelectLayout).toHaveBeenCalledWith('2-split');
    });

    it('should call onSelectLayout with 3-split when 3-split option clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-3-split');
      fireEvent.click(splitOption);

      expect(mockOnSelectLayout).toHaveBeenCalledWith('3-split');
    });

    it('should call onSelectLayout with 4-grid when 4-grid option clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const gridOption = screen.getByTestId('tiling-option-4-grid');
      fireEvent.click(gridOption);

      expect(mockOnSelectLayout).toHaveBeenCalledWith('4-grid');
    });
  });

  describe('Close Behavior', () => {
    it('should call onClose when backdrop is clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const backdrop = screen.getByTestId('tiling-overlay-backdrop');
      fireEvent.click(backdrop);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should not call onClose when overlay content is clicked', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const overlay = screen.getByTestId('tiling-overlay');
      fireEvent.click(overlay);

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('SVG Preview Icons', () => {
    it('should render SVG preview for tabbed layout', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const tabbedOption = screen.getByTestId('tiling-option-tabbed');
      const svg = tabbedOption.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render SVG preview for 2-split layout', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-2-split');
      const svg = splitOption.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render SVG preview for 3-split layout', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const splitOption = screen.getByTestId('tiling-option-3-split');
      const svg = splitOption.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render SVG preview for 4-grid layout', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const gridOption = screen.getByTestId('tiling-option-4-grid');
      const svg = gridOption.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have role menu on overlay', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const overlay = screen.getByTestId('tiling-overlay');
      expect(overlay).toHaveAttribute('role', 'menu');
    });

    it('should have role menuitem on options', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const option = screen.getByTestId('tiling-option-tabbed');
      expect(option).toHaveAttribute('role', 'menuitem');
    });

    it('should have aria-label describing the layout', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      const tabbedOption = screen.getByTestId('tiling-option-tabbed');
      expect(tabbedOption).toHaveAttribute('aria-label', 'Tabbed layout');
    });
  });

  describe('Layout Labels', () => {
    it('should display label for each layout option', () => {
      render(() => (
        <TilingOverlay
          tabCount={4}
          currentLayout="tabbed"
          onSelectLayout={mockOnSelectLayout}
          onClose={mockOnClose}
        />
      ));

      expect(screen.getByText('Tabbed')).toBeInTheDocument();
      expect(screen.getByText('2 Split')).toBeInTheDocument();
      expect(screen.getByText('3 Split')).toBeInTheDocument();
      expect(screen.getByText('4 Grid')).toBeInTheDocument();
    });
  });
});
