import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import Button from '../../components/ui/Button';

describe('Button Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Default Rendering', () => {
    it('should render with default props', () => {
      render(() => <Button>Click me</Button>);
      const button = screen.getByTestId('button');

      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('Click me');
      expect(button).not.toBeDisabled();
    });

    it('should render as a button element', () => {
      render(() => <Button>Test</Button>);
      const button = screen.getByTestId('button');

      expect(button.tagName).toBe('BUTTON');
    });
  });

  describe('Variants', () => {
    it('should render primary variant by default', () => {
      render(() => <Button>Primary</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-variant', 'primary');
    });

    it('should render secondary variant', () => {
      render(() => <Button variant="secondary">Secondary</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-variant', 'secondary');
    });

    it('should render ghost variant', () => {
      render(() => <Button variant="ghost">Ghost</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-variant', 'ghost');
    });

    it('should render danger variant', () => {
      render(() => <Button variant="danger">Danger</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-variant', 'danger');
    });
  });

  describe('Sizes', () => {
    it('should render medium size by default', () => {
      render(() => <Button>Medium</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-size', 'md');
    });

    it('should render small size', () => {
      render(() => <Button size="sm">Small</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-size', 'sm');
    });

    it('should render large size', () => {
      render(() => <Button size="lg">Large</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-size', 'lg');
    });
  });

  describe('Icon Support', () => {
    it('should render with icon on the left by default', () => {
      render(() => <Button icon="M10 10">With Icon</Button>);
      const button = screen.getByTestId('button');
      const icon = button.querySelector('svg');

      expect(icon).toBeInTheDocument();
      expect(button).toHaveAttribute('data-icon-position', 'left');
    });

    it('should render with icon on the right', () => {
      render(() => (
        <Button icon="M10 10" iconPosition="right">
          With Icon
        </Button>
      ));
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-icon-position', 'right');
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner when loading', () => {
      render(() => <Button loading>Loading</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-loading', 'true');
      expect(button.querySelector('.button-spinner')).toBeInTheDocument();
    });

    it('should be disabled when loading', () => {
      render(() => <Button loading>Loading</Button>);
      const button = screen.getByTestId('button');

      expect(button).toBeDisabled();
    });

    it('should not show loading spinner when not loading', () => {
      render(() => <Button>Not Loading</Button>);
      const button = screen.getByTestId('button');

      expect(button).toHaveAttribute('data-loading', 'false');
      expect(button.querySelector('.button-spinner')).not.toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('should be disabled when disabled prop is true', () => {
      render(() => <Button disabled>Disabled</Button>);
      const button = screen.getByTestId('button');

      expect(button).toBeDisabled();
    });

    it('should not be disabled by default', () => {
      render(() => <Button>Enabled</Button>);
      const button = screen.getByTestId('button');

      expect(button).not.toBeDisabled();
    });
  });

  describe('Click Handler', () => {
    it('should call onClick when clicked', () => {
      const handleClick = vi.fn();
      render(() => <Button onClick={handleClick}>Click</Button>);
      const button = screen.getByTestId('button');

      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when disabled', () => {
      const handleClick = vi.fn();
      render(() => (
        <Button onClick={handleClick} disabled>
          Disabled
        </Button>
      ));
      const button = screen.getByTestId('button');

      fireEvent.click(button);

      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should not call onClick when loading', () => {
      const handleClick = vi.fn();
      render(() => (
        <Button onClick={handleClick} loading>
          Loading
        </Button>
      ));
      const button = screen.getByTestId('button');

      fireEvent.click(button);

      expect(handleClick).not.toHaveBeenCalled();
    });
  });
});
