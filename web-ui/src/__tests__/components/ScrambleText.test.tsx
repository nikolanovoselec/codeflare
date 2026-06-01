import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@solidjs/testing-library';
import ScrambleText from '../../components/ScrambleText';

/**
 * Helper: install a matchMedia mock that reports the given reduced-motion
 * preference. ScrambleText (via useScrambleText) reads
 * `(prefers-reduced-motion: reduce)` at hook-init time.
 */
function mockMatchMedia(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduce : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('ScrambleText', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('first mount', () => {
    beforeEach(() => {
      mockMatchMedia(false);
    });

    it('eventually renders the final text', async () => {
      const { container } = render(() => <ScrambleText text="Codeflare" />);

      await waitFor(() => {
        expect(container.querySelector('span')?.textContent).toBe('Codeflare');
      });
    });

    it('passes the class prop through to the rendered span', () => {
      const { container } = render(() => (
        <ScrambleText text="Codeflare" class="login-title-scramble" />
      ));

      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      expect(span).toHaveClass('login-title-scramble');
    });
  });

  describe('prefers-reduced-motion', () => {
    beforeEach(() => {
      mockMatchMedia(true);
    });

    it('renders the final text immediately with no animation scheduled', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

      const { container } = render(() => <ScrambleText text="Codeflare" />);

      // Final text shown synchronously, no waitFor / timers needed.
      expect(container.querySelector('span')?.textContent).toBe('Codeflare');
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(rafSpy).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    beforeEach(() => {
      mockMatchMedia(false);
    });

    it('clears the animation interval when the component is disposed', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const { unmount } = render(() => <ScrambleText text="Codeflare" />);

      // The 4-phase loop schedules exactly one interval.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const timerId = setIntervalSpy.mock.results[0].value;

      unmount();

      // The same interval is torn down on dispose — no leaked timer.
      expect(clearIntervalSpy).toHaveBeenCalledWith(timerId);
    });
  });
});
