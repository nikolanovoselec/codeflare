import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import TiledTerminalContainer from '../../components/TiledTerminalContainer';
import type { TerminalTab, TileLayout } from '../../types';

describe('TiledTerminalContainer Component', () => {
  const mockSessionId = 'test-session-123';
  const mockOnTileClick = vi.fn();

  const createTerminals = (count: number): TerminalTab[] =>
    Array.from({ length: count }, (_, i) => ({
      id: String(i + 1),
      createdAt: new Date().toISOString(),
    }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Terminal Slot Rendering', () => {
    it('should render correct number of terminal slots for 2-split layout', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      expect(screen.getByTestId('tiled-slot-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-2')).toBeInTheDocument();
      expect(screen.queryByTestId('tiled-slot-3')).not.toBeInTheDocument();
    });

    it('should render correct number of terminal slots for 3-split layout', () => {
      const terminals = createTerminals(3);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2', '3']}
          layout="3-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      expect(screen.getByTestId('tiled-slot-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-2')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-3')).toBeInTheDocument();
      expect(screen.queryByTestId('tiled-slot-4')).not.toBeInTheDocument();
    });

    it('should render correct number of terminal slots for 4-grid layout', () => {
      const terminals = createTerminals(4);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2', '3', '4']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      expect(screen.getByTestId('tiled-slot-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-2')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-3')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-4')).toBeInTheDocument();
    });

    it('should render empty slots when fewer terminals than layout requires', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      // Should still have 4 slots (some empty)
      expect(screen.getByTestId('tiled-slot-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-2')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-2')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-3')).toBeInTheDocument();
    });
  });

  describe('CSS Layout Classes', () => {
    it('should apply tiled--2-split class for 2-split layout', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).toHaveClass('tiled--2-split');
    });

    it('should apply tiled--3-split class for 3-split layout', () => {
      const terminals = createTerminals(3);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2', '3']}
          layout="3-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).toHaveClass('tiled--3-split');
    });

    it('should apply tiled--4-grid class for 4-grid layout', () => {
      const terminals = createTerminals(4);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2', '3', '4']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).toHaveClass('tiled--4-grid');
    });

    it('should not apply any tiled class for tabbed layout', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="tabbed"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).not.toHaveClass('tiled--2-split');
      expect(container).not.toHaveClass('tiled--3-split');
      expect(container).not.toHaveClass('tiled--4-grid');
    });
  });

  describe('Active Tile Indicator', () => {
    it('should apply active class to the active tile', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const activeSlot = screen.getByTestId('tiled-slot-1');
      const inactiveSlot = screen.getByTestId('tiled-slot-2');

      expect(activeSlot).toHaveClass('tiled-terminal-slot--active');
      expect(inactiveSlot).not.toHaveClass('tiled-terminal-slot--active');
    });

    it('should update active indicator when activeTabId changes', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="2"
          onTileClick={mockOnTileClick}
        />
      ));

      const slot1 = screen.getByTestId('tiled-slot-1');
      const slot2 = screen.getByTestId('tiled-slot-2');

      expect(slot1).not.toHaveClass('tiled-terminal-slot--active');
      expect(slot2).toHaveClass('tiled-terminal-slot--active');
    });

    it('should handle null activeTabId gracefully', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId={null}
          onTileClick={mockOnTileClick}
        />
      ));

      const slot1 = screen.getByTestId('tiled-slot-1');
      const slot2 = screen.getByTestId('tiled-slot-2');

      expect(slot1).not.toHaveClass('tiled-terminal-slot--active');
      expect(slot2).not.toHaveClass('tiled-terminal-slot--active');
    });
  });

  describe('Tab Order', () => {
    it('should render tabs in tabOrder sequence', () => {
      const terminals = createTerminals(3);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['3', '1', '2']}
          layout="3-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      const slots = container.querySelectorAll('[data-testid^="tiled-slot-"]');

      // First slot should be tab 3, second tab 1, third tab 2
      expect(slots[0]).toHaveAttribute('data-testid', 'tiled-slot-3');
      expect(slots[1]).toHaveAttribute('data-testid', 'tiled-slot-1');
      expect(slots[2]).toHaveAttribute('data-testid', 'tiled-slot-2');
    });

    it('should maintain order when tabOrder differs from terminal creation order', () => {
      const terminals = createTerminals(4);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['4', '3', '2', '1']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      const slots = container.querySelectorAll('[data-testid^="tiled-slot-"]');

      expect(slots[0]).toHaveAttribute('data-testid', 'tiled-slot-4');
      expect(slots[1]).toHaveAttribute('data-testid', 'tiled-slot-3');
      expect(slots[2]).toHaveAttribute('data-testid', 'tiled-slot-2');
      expect(slots[3]).toHaveAttribute('data-testid', 'tiled-slot-1');
    });
  });

  describe('Click Handler', () => {
    it('should call onTileClick with correct tabId when tile is clicked', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const slot2 = screen.getByTestId('tiled-slot-2');
      fireEvent.click(slot2);

      expect(mockOnTileClick).toHaveBeenCalledWith('2');
    });

    it('should call onTileClick with first tabId when first tile is clicked', () => {
      const terminals = createTerminals(3);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2', '3']}
          layout="3-split"
          activeTabId="2"
          onTileClick={mockOnTileClick}
        />
      ));

      const slot1 = screen.getByTestId('tiled-slot-1');
      fireEvent.click(slot1);

      expect(mockOnTileClick).toHaveBeenCalledWith('1');
    });

    it('should not call onTileClick when empty slot is clicked', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const emptySlot = screen.getByTestId('tiled-slot-empty-2');
      fireEvent.click(emptySlot);

      expect(mockOnTileClick).not.toHaveBeenCalled();
    });
  });

  describe('Container Base Class', () => {
    it('should always have tiled-terminal-container class', () => {
      const terminals = createTerminals(2);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1', '2']}
          layout="2-split"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).toHaveClass('tiled-terminal-container');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty terminals array', () => {
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={[]}
          tabOrder={[]}
          layout="2-split"
          activeTabId={null}
          onTileClick={mockOnTileClick}
        />
      ));

      const container = screen.getByTestId('tiled-terminal-container');
      expect(container).toBeInTheDocument();
      // Should have 2 empty slots for 2-split layout
      expect(screen.getByTestId('tiled-slot-empty-0')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-1')).toBeInTheDocument();
    });

    it('should handle single terminal in multi-slot layout', () => {
      const terminals = createTerminals(1);
      render(() => (
        <TiledTerminalContainer
          sessionId={mockSessionId}
          terminals={terminals}
          tabOrder={['1']}
          layout="4-grid"
          activeTabId="1"
          onTileClick={mockOnTileClick}
        />
      ));

      expect(screen.getByTestId('tiled-slot-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-1')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-2')).toBeInTheDocument();
      expect(screen.getByTestId('tiled-slot-empty-3')).toBeInTheDocument();
    });
  });
});
