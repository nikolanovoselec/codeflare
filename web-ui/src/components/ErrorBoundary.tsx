import { ErrorBoundary as SolidErrorBoundary, type JSX, createSignal, Show } from 'solid-js';
import { ApiError } from '../api/fetch-helper';
import { logger } from '../lib/logger';

interface AppErrorBoundaryProps {
  children: JSX.Element;
  fallback?: (err: Error, reset: () => void) => JSX.Element;
}

/**
 * Formats an error into a user-friendly message.
 * ApiErrors get special treatment to surface HTTP context without raw stack traces.
 */
function formatErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'Your session has expired. Please refresh the page to re-authenticate.';
    }
    if (err.status >= 500) {
      return 'A server error occurred. Please try again in a moment.';
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unexpected error occurred.';
}

/**
 * Application-level error boundary that catches render errors and displays
 * a user-friendly fallback UI. Wraps SolidJS's built-in ErrorBoundary with
 * consistent styling and error logging.
 */
export default function AppErrorBoundary(props: AppErrorBoundaryProps) {
  return (
    <SolidErrorBoundary
      fallback={(err, reset) => {
        logger.error('ErrorBoundary caught:', err);

        if (props.fallback) {
          return props.fallback(err instanceof Error ? err : new Error(String(err)), reset);
        }

        const message = formatErrorMessage(err);

        return (
          <div class="error-boundary" role="alert">
            <h2>Something went wrong</h2>
            <p class="error-boundary-message">{message}</p>
            <button type="button" onClick={reset}>
              Try again
            </button>
          </div>
        );
      }}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}

export { formatErrorMessage };
