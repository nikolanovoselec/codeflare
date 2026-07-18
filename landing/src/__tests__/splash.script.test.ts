// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokensCss = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const globalCss = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');

function expectedBackground(token: string, value: string): string {
  const resolvedToken = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  expect(resolvedToken).toBe(value);
  const probe = document.createElement('div');
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  const background = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return background;
}

const splash = vi.hoisted(() => ({
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  pointerMove: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('../lib/splash-cursor-logic', () => ({
  createSplashSimulation: vi.fn(() => splash),
}));

beforeEach(() => {
  document.body.innerHTML = '<div data-flare-fluid></div>';
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(pointer: fine)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.resetModules();
});

describe('landing flare-fluid lifecycle', () => {
  it('retires the decorative canvas when a touch page is backgrounded', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    let queuedSweep: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedSweep = callback;
      return 42;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      await import('../scripts/splash');
      const canvas = document.querySelector<HTMLCanvasElement>('.flare-fluid-canvas')!;
      window.dispatchEvent(new Event('scroll'));
      expect(queuedSweep).toBeTypeOf('function');

      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(canvas.hidden).toBe(true);
      expect(canvas.style.display).toBe('none');
      expect(cancelFrame).toHaveBeenCalledWith(42);
      expect(splash.destroy).toHaveBeenCalledOnce();

      const pointerCallsAfterRetirement = splash.pointerMove.mock.calls.length;
      queuedSweep!(0);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('scroll'));

      expect(splash.pause).not.toHaveBeenCalled();
      expect(splash.resume).not.toHaveBeenCalled();
      expect(splash.pointerMove).toHaveBeenCalledTimes(pointerCallsAfterRetirement);
      expect(splash.destroy).toHaveBeenCalledOnce();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('does not start the decorative simulation when a touch page loads hidden', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });

    try {
      await import('../scripts/splash');
      const canvas = document.querySelector<HTMLCanvasElement>('.flare-fluid-canvas')!;
      expect(canvas.hidden).toBe(true);
      expect(canvas.style.display).toBe('none');
      expect(splash.start).not.toHaveBeenCalled();
      expect(splash.destroy).toHaveBeenCalledOnce();
    } finally {
      if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('falls back to the stable dark CSS background when the WebGL context is lost', async () => {
    const style = document.createElement('style');
    style.textContent = `${tokensCss}\n${globalCss}`;
    document.head.appendChild(style);

    try {
      await import('../scripts/splash');

      const canvas = document.querySelector<HTMLCanvasElement>('.flare-fluid-canvas')!;
      expect(canvas).not.toBeNull();
      expect(splash.start).toHaveBeenCalledOnce();

      const contextLost = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(contextLost);

      expect(contextLost.defaultPrevented).toBe(false);
      expect(canvas.hidden).toBe(true);
      expect(canvas.style.display).toBe('none');
      expect(splash.destroy).toHaveBeenCalledOnce();
      const darkBackground = expectedBackground('--bg-base', '#0a0a0c');
      expect(getComputedStyle(document.documentElement).backgroundColor).toBe(darkBackground);
      expect(getComputedStyle(document.body).backgroundColor).toBe(darkBackground);
    } finally {
      style.remove();
    }
  });
});
