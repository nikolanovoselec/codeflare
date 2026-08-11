import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';

const splashMocks = vi.hoisted(() => ({
  createSplashSimulation: vi.fn(),
}));

vi.mock('../../lib/splash-cursor-logic', () => ({
  createSplashSimulation: splashMocks.createSplashSimulation,
}));

import SplashCursor from '../../components/SplashCursor';

function createSimulation() {
  return {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    pointerMove: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('SplashCursor Codeflare wrapper boundary', () => {
  let simulation: ReturnType<typeof createSimulation>;
  let originalVisibility: PropertyDescriptor | undefined;

  beforeEach(() => {
    simulation = createSimulation();
    splashMocks.createSplashSimulation.mockReset().mockReturnValue(simulation);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  });

  it('REQ-MOB-018 wrapper boundary: renders one inaccessible decorative canvas', () => {
    const { container } = render(() => <SplashCursor />);

    const canvas = container.querySelectorAll('canvas');
    expect(canvas).toHaveLength(1);
    expect(canvas[0]).toHaveClass('splash-cursor-canvas');
    expect(canvas[0]).toHaveAttribute('aria-hidden', 'true');
    expect(canvas[0].parentElement).toHaveClass('splash-cursor-container');
  });

  it('REQ-MOB-018 wrapper boundary: forwards Codeflare defaults once and starts the owned simulation', () => {
    const { container } = render(() => <SplashCursor />);
    const canvas = container.querySelector('canvas');

    expect(splashMocks.createSplashSimulation).toHaveBeenCalledWith(canvas, {
      SIM_RESOLUTION: 128,
      DYE_RESOLUTION: 1440,
      CAPTURE_RESOLUTION: 512,
      DENSITY_DISSIPATION: 3.5,
      VELOCITY_DISSIPATION: 2,
      PRESSURE: 0.1,
      PRESSURE_ITERATIONS: 20,
      CURL: 3,
      SPLAT_RADIUS: 0.2,
      SPLAT_FORCE: 6000,
      SHADING: true,
      COLOR_UPDATE_SPEED: 10,
      PAUSED: false,
      BACK_COLOR: { r: 0.035, g: 0.035, b: 0.043 },
      TRANSPARENT: true,
    });
    expect(simulation.start).toHaveBeenCalledOnce();
  });

  it('REQ-MOB-018 wrapper boundary: leaves the decorative canvas inert when simulation setup is unavailable', () => {
    splashMocks.createSplashSimulation.mockReturnValue(null);
    const { container } = render(() => <SplashCursor />);

    expect(container.querySelector('canvas')).toBeInTheDocument();
    expect(simulation.start).not.toHaveBeenCalled();
    expect(simulation.destroy).not.toHaveBeenCalled();
  });

  it('REQ-MOB-018 AC1: retires a coarse-pointer canvas when the page is backgrounded', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { container } = render(() => <SplashCursor />);
    const canvas = container.querySelector('canvas')!;

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(canvas).toHaveAttribute('hidden');
    expect(canvas.style.display).toBe('none');
    expect(simulation.destroy).toHaveBeenCalledOnce();
  });

  it('REQ-MOB-018 AC1: never starts a coarse-pointer simulation when the page mounts hidden', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    const { container } = render(() => <SplashCursor />);
    const canvas = container.querySelector('canvas')!;

    expect(canvas).toHaveAttribute('hidden');
    expect(canvas.style.display).toBe('none');
    expect(simulation.start).not.toHaveBeenCalled();
    expect(simulation.destroy).toHaveBeenCalledOnce();
  });

  it('REQ-MOB-018 AC2: context loss permanently retires the canvas without requesting restoration', () => {
    const { container } = render(() => <SplashCursor />);
    const canvas = container.querySelector('canvas')!;
    const contextLost = new Event('webglcontextlost', { cancelable: true });

    canvas.dispatchEvent(contextLost);

    expect(contextLost.defaultPrevented).toBe(false);
    expect(canvas).toHaveAttribute('hidden');
    expect(canvas.style.display).toBe('none');
    expect(simulation.destroy).toHaveBeenCalledOnce();
  });

  it('REQ-MOB-018 cleanup boundary: destroys a live simulation once on unmount', () => {
    const { unmount } = render(() => <SplashCursor />);

    unmount();

    expect(simulation.destroy).toHaveBeenCalledOnce();
  });
});
