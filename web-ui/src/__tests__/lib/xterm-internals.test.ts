import { describe, it, expect, vi } from 'vitest';
import {
  getXtermCore,
  getIframeInput,
  setIframeInput,
  getBufferActive,
  getRemoveFocusGuard,
  setRemoveFocusGuard,
  scrollBufferToBottom,
  resyncViewportScrollState,
} from '../../lib/xterm-internals';

function makeMockTerminal(overrides: Record<string, unknown> = {}) {
  return {
    _core: {
      coreService: { triggerDataEvent: () => {} },
      _coreBrowserService: {},
      _syncTextArea: () => {},
      _handleTextAreaFocus: () => {},
      _handleTextAreaBlur: () => {},
    },
    buffer: { active: { cursorY: 0, viewportY: 0, length: 24 } },
    ...overrides,
  } as any;
}

describe('xterm-internals', () => {
  describe('getXtermCore', () => {
    it('returns the _core property', () => {
      const term = makeMockTerminal();
      const core = getXtermCore(term);
      expect(core).toBe(term._core);
    });

    it('returns undefined when _core is missing', () => {
      const term = makeMockTerminal({ _core: undefined });
      expect(getXtermCore(term)).toBeUndefined();
    });
  });

  describe('getIframeInput / setIframeInput', () => {
    it('returns undefined initially', () => {
      const term = makeMockTerminal();
      expect(getIframeInput(term)).toBeUndefined();
    });

    it('round-trips a value', () => {
      const term = makeMockTerminal();
      const input = document.createElement('input');
      setIframeInput(term, input);
      expect(getIframeInput(term)).toBe(input);
    });
  });

  describe('getRemoveFocusGuard / setRemoveFocusGuard', () => {
    it('returns undefined initially', () => {
      const term = makeMockTerminal();
      expect(getRemoveFocusGuard(term)).toBeUndefined();
    });

    it('round-trips a callback', () => {
      const term = makeMockTerminal();
      const fn = () => {};
      setRemoveFocusGuard(term, fn);
      expect(getRemoveFocusGuard(term)).toBe(fn);
    });
  });

  describe('getBufferActive', () => {
    it('returns the active buffer', () => {
      const term = makeMockTerminal();
      const buffer = getBufferActive(term);
      expect(buffer).toBe(term.buffer.active);
    });

    it('returns undefined when buffer is missing', () => {
      const term = makeMockTerminal({ buffer: undefined });
      expect(getBufferActive(term)).toBeUndefined();
    });
  });

  describe('scrollBufferToBottom', () => {
    function makeScrollableTerminal(viewportY: number, baseY: number) {
      const scrollLines = vi.fn();
      const term = makeMockTerminal({
        buffer: { active: { viewportY, baseY } },
        rows: 24,
        refresh: vi.fn(),
        scrollToBottom: vi.fn(),
      });
      term._core._bufferService = { scrollLines };
      return { term, scrollLines };
    }

    it('scrolls the buffer service by the buffer-derived delta and repaints', () => {
      const { term, scrollLines } = makeScrollableTerminal(120, 500);
      scrollBufferToBottom(term);
      expect(scrollLines).toHaveBeenCalledWith(380);
      expect(term.refresh).toHaveBeenCalledWith(0, 23);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('does nothing when the viewport already sits at the bottom', () => {
      const { term, scrollLines } = makeScrollableTerminal(500, 500);
      scrollBufferToBottom(term);
      expect(scrollLines).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('falls back to the public scrollToBottom when internals are unavailable', () => {
      const term = makeMockTerminal({
        _core: undefined,
        buffer: { active: { viewportY: 120, baseY: 500 } },
        scrollToBottom: vi.fn(),
      });
      scrollBufferToBottom(term);
      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    });
  });

  describe('resyncViewportScrollState', () => {
    it('re-commands the DOM scroll state from the current buffer position without smooth scroll', () => {
      const scrollToLine = vi.fn();
      const term = makeMockTerminal({ buffer: { active: { viewportY: 321, baseY: 500 } } });
      term._core._viewport = { scrollToLine };
      resyncViewportScrollState(term);
      expect(scrollToLine).toHaveBeenCalledWith(321, true);
    });

    it('no-ops when the internal viewport is unavailable', () => {
      const term = makeMockTerminal({ buffer: { active: { viewportY: 321, baseY: 500 } } });
      expect(() => resyncViewportScrollState(term)).not.toThrow();
    });
  });
});
