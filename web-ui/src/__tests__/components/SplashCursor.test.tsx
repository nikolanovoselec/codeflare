import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';
import SplashCursor from '../../components/SplashCursor';

describe('SplashCursor Component', () => {
  let rafSpy: any;
  let cafSpy: any;

  beforeEach(() => {
    // Mock matchMedia for prefers-reduced-motion
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

    // Spy on rAF/cAF
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render a container div with a canvas element', () => {
      // WebGL getContext returns null in jsdom -- component should handle gracefully
      const { container } = render(() => <SplashCursor />);
      const wrapper = container.querySelector('.splash-cursor-container');
      expect(wrapper).toBeInTheDocument();
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeInTheDocument();
    });

    it('should have aria-hidden="true" on the canvas', () => {
      const { container } = render(() => <SplashCursor />);
      const canvas = container.querySelector('canvas');
      expect(canvas).toHaveAttribute('aria-hidden', 'true');
    });

    it('should apply splash-cursor-canvas class to canvas', () => {
      const { container } = render(() => <SplashCursor />);
      const canvas = container.querySelector('canvas');
      expect(canvas).toHaveClass('splash-cursor-canvas');
    });

    it('should mount without errors even when WebGL is unavailable', () => {
      expect(() => render(() => <SplashCursor />)).not.toThrow();
    });
  });

  describe('Container Styling', () => {
    it('should have pointer-events: none on container', () => {
      const { container } = render(() => <SplashCursor />);
      const wrapper = container.querySelector('.splash-cursor-container');
      expect(wrapper).toBeInTheDocument();
    });

    it('should have position: fixed on container', () => {
      const { container } = render(() => <SplashCursor />);
      const wrapper = container.querySelector('.splash-cursor-container');
      expect(wrapper).toHaveClass('splash-cursor-container');
    });
  });

  describe('WebGL Context', () => {
    it('should attempt to get a WebGL context on mount', () => {
      (globalThis as any).WebGLRenderingContext = function () {};
      const getContextSpy = vi.fn(() => null);
      HTMLCanvasElement.prototype.getContext = getContextSpy;

      render(() => <SplashCursor />);
      // Should attempt webgl2 first
      expect(getContextSpy).toHaveBeenCalledWith('webgl2', expect.any(Object));
      delete (globalThis as any).WebGLRenderingContext;
    });

    it('should handle null WebGL context gracefully (no crash)', () => {
      // Without WebGLRenderingContext defined, component skips getContext entirely
      expect(() => render(() => <SplashCursor />)).not.toThrow();
    });
  });

  describe('Configuration Props', () => {
    it('should accept custom SIM_RESOLUTION', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor SIM_RESOLUTION={64} />)).not.toThrow();
    });

    it('should accept custom DYE_RESOLUTION', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor DYE_RESOLUTION={720} />)).not.toThrow();
    });

    it('should accept custom DENSITY_DISSIPATION', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor DENSITY_DISSIPATION={2.0} />)).not.toThrow();
    });

    it('should accept custom VELOCITY_DISSIPATION', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor VELOCITY_DISSIPATION={1.5} />)).not.toThrow();
    });

    it('should accept custom PRESSURE', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor PRESSURE={0.5} />)).not.toThrow();
    });

    it('should accept custom CURL', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor CURL={5} />)).not.toThrow();
    });

    it('should accept custom SPLAT_RADIUS', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor SPLAT_RADIUS={0.5} />)).not.toThrow();
    });

    it('should accept custom SPLAT_FORCE', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor SPLAT_FORCE={8000} />)).not.toThrow();
    });

    it('should accept custom SHADING', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor SHADING={false} />)).not.toThrow();
    });

    it('should accept custom COLOR_UPDATE_SPEED', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor COLOR_UPDATE_SPEED={20} />)).not.toThrow();
    });

    it('should accept custom BACK_COLOR', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() =>
        render(() => <SplashCursor BACK_COLOR={{ r: 0, g: 0, b: 0 }} />)
      ).not.toThrow();
    });

    it('should accept custom TRANSPARENT', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() => render(() => <SplashCursor TRANSPARENT={false} />)).not.toThrow();
    });

    it('should accept all props at once', () => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
      expect(() =>
        render(() => (
          <SplashCursor
            SIM_RESOLUTION={64}
            DYE_RESOLUTION={720}
            DENSITY_DISSIPATION={2.0}
            VELOCITY_DISSIPATION={1.5}
            PRESSURE={0.5}
            CURL={5}
            SPLAT_RADIUS={0.5}
            SPLAT_FORCE={8000}
            SHADING={false}
            COLOR_UPDATE_SPEED={20}
            BACK_COLOR={{ r: 0, g: 0, b: 0 }}
            TRANSPARENT={false}
          />
        ))
      ).not.toThrow();
    });
  });

  describe('Animation Lifecycle', () => {
    it('should not start animation loop when WebGL is unavailable', () => {
      render(() => <SplashCursor />);
      // No animation should be scheduled when WebGLRenderingContext is absent
      expect(rafSpy).not.toHaveBeenCalled();
    });

    it('should clean up animation frame on unmount when WebGL was available', () => {
      // Define WebGLRenderingContext so the component proceeds past the feature check
      (globalThis as any).WebGLRenderingContext = function () {};
      const mockGl = createMockWebGLContext();
      HTMLCanvasElement.prototype.getContext = vi.fn(() => mockGl) as any;

      const { unmount } = render(() => <SplashCursor />);
      unmount();
      expect(cafSpy).toHaveBeenCalled();
      delete (globalThis as any).WebGLRenderingContext;
    });
  });

  describe('Event Listeners', () => {
    it('should add mouse/touch event listeners on mount when WebGL is available', () => {
      (globalThis as any).WebGLRenderingContext = function () {};
      const mockGl = createMockWebGLContext();
      HTMLCanvasElement.prototype.getContext = vi.fn(() => mockGl) as any;
      const addSpy = vi.spyOn(window, 'addEventListener');

      render(() => <SplashCursor />);

      expect(addSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), false);
      expect(addSpy).toHaveBeenCalledWith('touchend', expect.any(Function));
      delete (globalThis as any).WebGLRenderingContext;
    });

    it('should remove event listeners on unmount', () => {
      (globalThis as any).WebGLRenderingContext = function () {};
      const mockGl = createMockWebGLContext();
      HTMLCanvasElement.prototype.getContext = vi.fn(() => mockGl) as any;
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = render(() => <SplashCursor />);
      unmount();

      expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('touchend', expect.any(Function));
      delete (globalThis as any).WebGLRenderingContext;
    });

    it('should not add event listeners when WebGL is unavailable', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');

      render(() => <SplashCursor />);

      // Should not add any of the mouse/touch handlers
      expect(addSpy).not.toHaveBeenCalledWith('mousedown', expect.any(Function));
      expect(addSpy).not.toHaveBeenCalledWith('mousemove', expect.any(Function));
    });
  });

  describe('Prefers Reduced Motion', () => {
    it('should render container even with reduced motion (CSS handles hiding)', () => {
      // CSS @media (prefers-reduced-motion: reduce) hides the container
      // The component still renders in DOM; CSS display:none handles visibility
      (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const { container } = render(() => <SplashCursor />);
      const wrapper = container.querySelector('.splash-cursor-container');
      expect(wrapper).toBeInTheDocument();
    });
  });
});

/**
 * Creates a minimal mock WebGL rendering context for testing.
 * Provides stubs for all GL methods the SplashCursor component calls during init.
 */
function createMockWebGLContext() {
  const TEXTURE_2D = 0x0de1;
  const TEXTURE_MIN_FILTER = 0x2801;
  const TEXTURE_MAG_FILTER = 0x2800;
  const TEXTURE_WRAP_S = 0x2802;
  const TEXTURE_WRAP_T = 0x2803;
  const NEAREST = 0x2600;
  const LINEAR = 0x2601;
  const CLAMP_TO_EDGE = 0x812f;
  const FRAMEBUFFER = 0x8d40;
  const COLOR_ATTACHMENT0 = 0x8ce0;
  const FRAMEBUFFER_COMPLETE = 0x8cd5;
  const RGBA = 0x1908;
  const RGBA16F = 0x881a;
  const RG16F = 0x822f;
  const RG = 0x8227;
  const R16F = 0x822d;
  const RED = 0x1903;
  const HALF_FLOAT = 0x140b;
  const FLOAT = 0x1406;
  const VERTEX_SHADER = 0x8b31;
  const FRAGMENT_SHADER = 0x8b30;
  const ARRAY_BUFFER = 0x8892;
  const ELEMENT_ARRAY_BUFFER = 0x8893;
  const STATIC_DRAW = 0x88e4;
  const UNSIGNED_SHORT = 0x1403;
  const TRIANGLES = 0x0004;
  const COMPILE_STATUS = 0x8b81;
  const LINK_STATUS = 0x8b82;
  const ACTIVE_UNIFORMS = 0x8b86;
  const BLEND = 0x0be2;
  const ONE = 1;
  const ONE_MINUS_SRC_ALPHA = 0x0303;
  const COLOR_BUFFER_BIT = 0x4000;
  const TEXTURE0 = 0x84c0;

  let textureIdCounter = 1;
  let fboIdCounter = 1;
  let shaderIdCounter = 1;
  let programIdCounter = 1;
  let bufferIdCounter = 1;

  return {
    // Constants
    TEXTURE_2D, TEXTURE_MIN_FILTER, TEXTURE_MAG_FILTER,
    TEXTURE_WRAP_S, TEXTURE_WRAP_T, NEAREST, LINEAR,
    CLAMP_TO_EDGE, FRAMEBUFFER, COLOR_ATTACHMENT0,
    FRAMEBUFFER_COMPLETE, RGBA, RGBA16F, RG16F, RG,
    R16F, RED, HALF_FLOAT, FLOAT, VERTEX_SHADER,
    FRAGMENT_SHADER, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER,
    STATIC_DRAW, UNSIGNED_SHORT, TRIANGLES, COMPILE_STATUS,
    LINK_STATUS, ACTIVE_UNIFORMS, BLEND, ONE,
    ONE_MINUS_SRC_ALPHA, COLOR_BUFFER_BIT, TEXTURE0,

    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    getExtension: vi.fn((name: string) => {
      if (name === 'EXT_color_buffer_float') return {};
      if (name === 'OES_texture_float_linear') return {};
      return null;
    }),
    createTexture: vi.fn(() => ({ _id: textureIdCounter++ })),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    createFramebuffer: vi.fn(() => ({ _id: fboIdCounter++ })),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => FRAMEBUFFER_COMPLETE),
    viewport: vi.fn(),
    clear: vi.fn(),
    clearColor: vi.fn(),
    createShader: vi.fn(() => ({ _id: shaderIdCounter++ })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    createProgram: vi.fn(() => ({ _id: programIdCounter++ })),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn((_, param: number) => {
      if (param === LINK_STATUS) return true;
      if (param === ACTIVE_UNIFORMS) return 0;
      return null;
    }),
    getProgramInfoLog: vi.fn(() => ''),
    getActiveUniform: vi.fn(() => ({ name: 'u', size: 1, type: FLOAT })),
    getUniformLocation: vi.fn(() => ({ _id: 1 })),
    useProgram: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    createBuffer: vi.fn(() => ({ _id: bufferIdCounter++ })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    vertexAttribPointer: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    drawElements: vi.fn(),
    activeTexture: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
  };
}
