// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
  .replace(/^@import[^;]+;\s*$/gm, '');
const globalCss = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8')
  .replace(/^@import[^;]+;\s*$/gm, '');

function expectStableRootBackgroundToken(): void {
  const style = document.createElement('style');
  style.textContent = tokensCss;
  document.head.appendChild(style);
  try {
    const rootRule = Array.from(style.sheet?.cssRules ?? []).find(
      (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ':root',
    );
    expect(rootRule?.style.getPropertyValue('--bg-base').trim()).toBe('#0a0a0c');
  } finally {
    style.remove();
  }
}

function expectedBackground(value: string): string {
  const probe = document.createElement('div');
  probe.style.backgroundColor = value;
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
    expectStableRootBackgroundToken();
    const backgroundSentinel = '#123456';
    const style = document.createElement('style');
    // happy-dom does not resolve stylesheet custom properties. Use a sentinel to
    // exercise the production selectors separately from the CSSOM token check.
    style.textContent = globalCss.split('var(--bg-base)').join(backgroundSentinel);
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
      const darkBackground = expectedBackground(backgroundSentinel);
      expect(getComputedStyle(document.documentElement).backgroundColor).toBe(darkBackground);
      expect(getComputedStyle(document.body).backgroundColor).toBe(darkBackground);
    } finally {
      style.remove();
    }
  });
});
