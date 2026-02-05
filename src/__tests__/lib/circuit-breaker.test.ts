import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../lib/circuit-breaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('stays closed on success', () => {
    it('remains CLOSED after successful executions', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const successFn = vi.fn().mockResolvedValue('success');

      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');

      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');

      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');

      expect(successFn).toHaveBeenCalledTimes(3);
    });

    it('resets failure count on success', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Two failures
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED');

      // One success - should reset counter
      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');

      // Two more failures - should still be closed (counter was reset)
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('opens after threshold failures', () => {
    it('opens circuit after reaching failure threshold', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // First two failures - still closed
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED');

      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED');

      // Third failure - opens circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');
    });

    it('rejects calls immediately when circuit is open', async () => {
      const cb = new CircuitBreaker('test-open', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Should reject immediately without calling the function
      await expect(cb.execute(successFn)).rejects.toThrow(
        'Service test-open is temporarily unavailable'
      );
      expect(successFn).not.toHaveBeenCalled();
    });
  });

  describe('transitions to half-open after timeout', () => {
    it('transitions to HALF_OPEN after reset timeout', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Advance time past reset timeout
      vi.advanceTimersByTime(5001);

      // Next call should transition to HALF_OPEN and execute
      await cb.execute(successFn);
      expect(successFn).toHaveBeenCalled();
    });

    it('stays OPEN before reset timeout elapses', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Advance time but not past reset timeout
      vi.advanceTimersByTime(4999);

      // Should still reject
      await expect(cb.execute(successFn)).rejects.toThrow('Service test is temporarily unavailable');
      expect(successFn).not.toHaveBeenCalled();
    });
  });

  describe('closes on success in half-open state', () => {
    it('transitions from HALF_OPEN to CLOSED on success', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Wait for reset timeout
      vi.advanceTimersByTime(5001);

      // Execute successfully - should close circuit
      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');

      // Subsequent calls should work normally
      await cb.execute(successFn);
      expect(successFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('re-opens on failure in half-open state', () => {
    it('transitions from HALF_OPEN to OPEN on single failure by default', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        // halfOpenMaxAttempts defaults to 1
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Wait for reset timeout to transition to HALF_OPEN
      vi.advanceTimersByTime(5001);

      // Fail in half-open state - should re-open
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');
    });

    it('allows multiple attempts in half-open state before re-opening', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenMaxAttempts: 3,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Wait for reset timeout
      vi.advanceTimersByTime(5001);

      // First failure in half-open - still half-open (need 3 to re-open)
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      // State should still allow attempts since we haven't reached halfOpenMaxAttempts

      // Success should still close the circuit
      await cb.execute(successFn);
      expect(cb.getState()).toBe('CLOSED');
    });

    it('re-opens after reaching halfOpenMaxAttempts failures', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
        halfOpenMaxAttempts: 2,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Wait for reset timeout
      vi.advanceTimersByTime(5001);

      // First failure in half-open
      await expect(cb.execute(failFn)).rejects.toThrow('fail');

      // Wait again to get back to half-open for second attempt
      vi.advanceTimersByTime(5001);

      // Second failure - should re-open
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');
    });
  });

  describe('reset()', () => {
    it('resets circuit to CLOSED state', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');

      // Reset
      cb.reset();
      expect(cb.getState()).toBe('CLOSED');

      // Should accept calls again
      const successFn = vi.fn().mockResolvedValue('success');
      await cb.execute(successFn);
      expect(successFn).toHaveBeenCalled();
    });

    it('resets failure count', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Accumulate some failures
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED');

      // Reset
      cb.reset();

      // Should need full threshold again to open
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('CLOSED'); // Only 2 failures after reset

      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN'); // Now 3 failures
    });
  });

  describe('return value', () => {
    it('returns the result from the executed function', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const result = await cb.execute(() => Promise.resolve({ data: 'test' }));
      expect(result).toEqual({ data: 'test' });
    });

    it('propagates errors from the executed function', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const customError = new Error('Custom error message');
      await expect(cb.execute(() => Promise.reject(customError))).rejects.toThrow(
        'Custom error message'
      );
    });
  });
});
