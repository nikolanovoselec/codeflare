import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import TilingButton from '../../components/TilingButton';

describe('TilingButton Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Visibility', () => {
    it('should be hidden when tabCount < 2', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={1}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.queryByTestId('tiling-button');
      expect(button).not.toBeInTheDocument();
    });

    it('should be hidden when tabCount is 0', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={0}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.queryByTestId('tiling-button');
      expect(button).not.toBeInTheDocument();
    });

    it('should be visible when tabCount >= 2', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={2}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button).toBeInTheDocument();
    });

    it('should be visible when tabCount is 6', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={6}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button).toBeInTheDocument();
    });
  });

  describe('Active State', () => {
    it('should show active state when isActive=true', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={3}
          isActive={true}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button).toHaveAttribute('data-active', 'true');
    });

    it('should not show active state when isActive=false', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={3}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button).toHaveAttribute('data-active', 'false');
    });
  });

  describe('Click Handler', () => {
    it('should call onClick when clicked', () => {
      const handleClick = vi.fn();
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={4}
          isActive={false}
          onClick={handleClick}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should call onClick on each click', () => {
      const handleClick = vi.fn();
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={2}
          isActive={true}
          onClick={handleClick}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(3);
    });
  });

  describe('Rendering', () => {
    it('should render as a button element', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={2}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button.tagName).toBe('BUTTON');
    });

    it('should have an SVG icon', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={2}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('should have tooltip/aria-label for accessibility', () => {
      render(() => (
        <TilingButton
          sessionId="test-session-123"
          tabCount={2}
          isActive={false}
          onClick={() => {}}
        />
      ));

      const button = screen.getByTestId('tiling-button');
      expect(button).toHaveAttribute('aria-label');
    });
  });
});
