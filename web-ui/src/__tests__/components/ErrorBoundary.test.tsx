import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import AppErrorBoundary, { formatErrorMessage } from '../../components/ErrorBoundary';
import { ApiError } from '../../api/fetch-helper';

// Mock logger to avoid console noise in tests
vi.mock('../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup();
  });

  // ==========================================================================
  // API errors show user-friendly messages
  // ==========================================================================
  describe('API error messages', () => {
    it('should show session-expired message for 401 ApiError', () => {
      const message = formatErrorMessage(
        new ApiError('Authentication redirect detected', 401, 'Unauthorized')
      );
      expect(message).toContain('session has expired');
      expect(message).toContain('refresh');
    });

    it('should show generic server error message for 5xx ApiError', () => {
      const message = formatErrorMessage(
        new ApiError('Internal Server Error', 500, 'Internal Server Error')
      );
      expect(message).toContain('server error');
      expect(message).toContain('try again');
    });

    it('should pass through ApiError message for 4xx client errors', () => {
      const message = formatErrorMessage(
        new ApiError('Invalid session name', 400, 'Bad Request')
      );
      expect(message).toBe('Invalid session name');
    });

    it('should use Error.message for non-API errors', () => {
      const message = formatErrorMessage(new TypeError('Cannot read properties of null'));
      expect(message).toBe('Cannot read properties of null');
    });

    it('should return fallback message for unknown error types', () => {
      const message = formatErrorMessage('string error');
      expect(message).toContain('unexpected error');
    });
  });

  // ==========================================================================
  // Render errors are caught by ErrorBoundary
  // ==========================================================================
  describe('render error catching', () => {
    it('should render children when no error occurs', () => {
      render(() => (
        <AppErrorBoundary>
          <div data-testid="child">Hello</div>
        </AppErrorBoundary>
      ));

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    it('should catch render errors and show fallback UI', () => {
      const ThrowingComponent = () => {
        throw new Error('Render explosion');
      };

      render(() => (
        <AppErrorBoundary>
          <ThrowingComponent />
        </AppErrorBoundary>
      ));

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('Render explosion')).toBeInTheDocument();
    });

    it('should show "Try again" button that resets the boundary', () => {
      const [shouldThrow, setShouldThrow] = createSignal(true);

      const MaybeThrow = () => {
        if (shouldThrow()) throw new Error('Temporary error');
        return <div data-testid="recovered">Recovered</div>;
      };

      render(() => (
        <AppErrorBoundary>
          <MaybeThrow />
        </AppErrorBoundary>
      ));

      // Error state
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Fix the error and reset
      setShouldThrow(false);
      fireEvent.click(screen.getByText('Try again'));

      expect(screen.getByTestId('recovered')).toBeInTheDocument();
    });

    it('should use custom fallback when provided', () => {
      const ThrowingComponent = () => {
        throw new Error('Custom fallback test');
      };

      render(() => (
        <AppErrorBoundary
          fallback={(err, reset) => (
            <div data-testid="custom-fallback">
              Custom: {err.message}
              <button onClick={reset}>Reset</button>
            </div>
          )}
        >
          <ThrowingComponent />
        </AppErrorBoundary>
      ));

      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
      expect(screen.getByText(/Custom: Custom fallback test/)).toBeInTheDocument();
    });

    it('should show user-friendly message for ApiError in render', () => {
      const ThrowingComponent = () => {
        throw new ApiError('Session expired', 401, 'Unauthorized');
      };

      render(() => (
        <AppErrorBoundary>
          <ThrowingComponent />
        </AppErrorBoundary>
      ));

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/session has expired/)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // WebSocket disconnect shows reconnection UI
  // ==========================================================================
  describe('WebSocket disconnect reconnection context', () => {
    it('should format connection-related errors with user-friendly text', () => {
      // WebSocket disconnects surface as generic errors in the UI layer.
      // The Terminal component handles reconnection UI directly, but if a
      // connection error propagates to the boundary, it should still be
      // user-friendly.
      const message = formatErrorMessage(
        new ApiError('WebSocket connection failed', 503, 'Service Unavailable')
      );
      expect(message).toContain('server error');
      expect(message).toContain('try again');
    });

    it('should format network errors as user-friendly messages', () => {
      const message = formatErrorMessage(new TypeError('Failed to fetch'));
      expect(message).toBe('Failed to fetch');
    });
  });
});
