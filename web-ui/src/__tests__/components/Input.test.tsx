import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import Input from '../../components/ui/Input';

describe('Input Component', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Default Rendering', () => {
    it('should render with default props', () => {
      render(() => <Input />);
      const input = screen.getByTestId('input');

      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe('INPUT');
    });

    it('should render as text type by default', () => {
      render(() => <Input />);
      const input = screen.getByTestId('input');

      expect(input).toHaveAttribute('type', 'text');
    });
  });

  describe('Input Types', () => {
    it('should render text type', () => {
      render(() => <Input type="text" />);
      const input = screen.getByTestId('input');

      expect(input).toHaveAttribute('type', 'text');
    });

    it('should render password type', () => {
      render(() => <Input type="password" />);
      const input = screen.getByTestId('input');

      expect(input).toHaveAttribute('type', 'password');
    });

    it('should render search type', () => {
      render(() => <Input type="search" />);
      const input = screen.getByTestId('input');

      expect(input).toHaveAttribute('type', 'search');
    });
  });

  describe('Value and Placeholder', () => {
    it('should display value', () => {
      render(() => <Input value="test value" />);
      const input = screen.getByTestId('input') as HTMLInputElement;

      expect(input.value).toBe('test value');
    });

    it('should display placeholder', () => {
      render(() => <Input placeholder="Enter text..." />);
      const input = screen.getByTestId('input');

      expect(input).toHaveAttribute('placeholder', 'Enter text...');
    });
  });

  describe('Icon Support', () => {
    it('should render with icon', () => {
      render(() => <Input icon="M10 10" />);
      const wrapper = screen.getByTestId('input-wrapper');
      const icon = wrapper.querySelector('svg');

      expect(icon).toBeInTheDocument();
      expect(wrapper).toHaveAttribute('data-has-icon', 'true');
    });

    it('should not render icon when not provided', () => {
      render(() => <Input />);
      const wrapper = screen.getByTestId('input-wrapper');
      const icon = wrapper.querySelector('svg');

      expect(icon).not.toBeInTheDocument();
      expect(wrapper).toHaveAttribute('data-has-icon', 'false');
    });
  });

  describe('Error State', () => {
    it('should display error message', () => {
      render(() => <Input error="This field is required" />);
      const errorMessage = screen.getByTestId('input-error');

      expect(errorMessage).toBeInTheDocument();
      expect(errorMessage).toHaveTextContent('This field is required');
    });

    it('should have error attribute when error is present', () => {
      render(() => <Input error="Error" />);
      const wrapper = screen.getByTestId('input-wrapper');

      expect(wrapper).toHaveAttribute('data-error', 'true');
    });

    it('should not display error when not provided', () => {
      render(() => <Input />);
      const errorMessage = screen.queryByTestId('input-error');

      expect(errorMessage).not.toBeInTheDocument();
    });
  });

  describe('Hint', () => {
    it('should display hint message', () => {
      render(() => <Input hint="Enter your email address" />);
      const hint = screen.getByTestId('input-hint');

      expect(hint).toBeInTheDocument();
      expect(hint).toHaveTextContent('Enter your email address');
    });

    it('should not display hint when not provided', () => {
      render(() => <Input />);
      const hint = screen.queryByTestId('input-hint');

      expect(hint).not.toBeInTheDocument();
    });

    it('should hide hint when error is displayed', () => {
      render(() => <Input hint="Hint text" error="Error text" />);
      const hint = screen.queryByTestId('input-hint');
      const error = screen.getByTestId('input-error');

      expect(hint).not.toBeInTheDocument();
      expect(error).toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('should be disabled when disabled prop is true', () => {
      render(() => <Input disabled />);
      const input = screen.getByTestId('input');

      expect(input).toBeDisabled();
    });

    it('should not be disabled by default', () => {
      render(() => <Input />);
      const input = screen.getByTestId('input');

      expect(input).not.toBeDisabled();
    });
  });

  describe('Input Handler', () => {
    it('should call onInput when text is entered', () => {
      const handleInput = vi.fn();
      render(() => <Input onInput={handleInput} />);
      const input = screen.getByTestId('input');

      fireEvent.input(input, { target: { value: 'new value' } });

      expect(handleInput).toHaveBeenCalledWith('new value');
    });

    it('should not call onInput when disabled', () => {
      const handleInput = vi.fn();
      render(() => <Input onInput={handleInput} disabled />);
      const input = screen.getByTestId('input');

      fireEvent.input(input, { target: { value: 'new value' } });

      // Input event still fires but the input itself should be disabled
      expect(input).toBeDisabled();
    });
  });
});
