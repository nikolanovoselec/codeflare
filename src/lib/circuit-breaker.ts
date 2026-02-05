import { CircuitBreakerOpenError } from './error-types';

/**
 * Circuit breaker state
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is tripped, requests are rejected immediately
 * - HALF_OPEN: Testing if the service has recovered
 */
/** @internal */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Configuration options for the circuit breaker
 */
interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in milliseconds to wait before transitioning from OPEN to HALF_OPEN */
  resetTimeoutMs: number;
  /** Maximum number of failed attempts allowed in HALF_OPEN state before re-opening (default: 1) */
  halfOpenMaxAttempts?: number;
}

/**
 * Circuit breaker implementation to prevent cascading failures
 *
 * The circuit breaker pattern prevents an application from repeatedly trying
 * to execute an operation that's likely to fail, allowing it to continue
 * without waiting for the fault to be fixed or wasting resources.
 *
 * State transitions:
 * - CLOSED -> OPEN: After failureThreshold consecutive failures
 * - OPEN -> HALF_OPEN: After resetTimeoutMs has elapsed
 * - HALF_OPEN -> CLOSED: On successful execution
 * - HALF_OPEN -> OPEN: After halfOpenMaxAttempts failures
 *
 * @example
 * ```typescript
 * const cb = new CircuitBreaker('external-api', {
 *   failureThreshold: 5,
 *   resetTimeoutMs: 30000,
 *   halfOpenMaxAttempts: 2,
 * });
 *
 * try {
 *   const result = await cb.execute(() => fetchFromExternalApi());
 * } catch (error) {
 *   if (error.message.includes('Circuit breaker')) {
 *     // Service is unavailable, use fallback
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  /**
   * Create a new circuit breaker
   * @param name - Identifier for this circuit breaker (used in error messages)
   * @param options - Configuration options
   */
  constructor(
    private name: string,
    private options: CircuitBreakerOptions
  ) {}

  /**
   * Execute a function through the circuit breaker
   *
   * @param fn - Async function to execute
   * @returns The result of the function if successful
   * @throws Error if circuit is OPEN or if the function throws
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /**
   * Handle successful execution
   * Resets failure count and closes the circuit
   */
  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  /**
   * Handle failed execution
   * Increments failure count and potentially opens the circuit
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= (this.options.halfOpenMaxAttempts ?? 1)) {
        this.state = 'OPEN';
      }
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  /**
   * Get the current state of the circuit breaker
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Manually reset the circuit breaker to CLOSED state
   * Useful for administrative intervention or testing
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }
}
