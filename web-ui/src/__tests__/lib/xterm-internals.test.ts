import { describe, it, expect } from 'vitest';
import {
  getXtermCore,
  getXtermViewport,
  getIframeInput,
  setIframeInput,
  getBufferActive,
  removeIframeInput,
  getRemoveFocusGuard,
  setRemoveFocusGuard,
} from '../../lib/xterm-internals';

function makeMockTerminal(overrides: Record<string, unknown> = {}) {
  return {
    _core: {
      viewport: { handleTouchStart: () => {}, handleTouchMove: () => false },
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

  describe('getXtermViewport', () => {
    it('returns the viewport from core', () => {
      const term = makeMockTerminal();
      const viewport = getXtermViewport(term);
      expect(viewport).toBe(term._core.viewport);
    });

    it('returns undefined when core is missing', () => {
      const term = makeMockTerminal({ _core: undefined });
      expect(getXtermViewport(term)).toBeUndefined();
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

  describe('removeIframeInput', () => {
    it('removes the stored value', () => {
      const term = makeMockTerminal();
      const input = document.createElement('input');
      setIframeInput(term, input);
      removeIframeInput(term);
      expect(getIframeInput(term)).toBeUndefined();
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
});
