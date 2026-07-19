import { onMount, onCleanup } from 'solid-js';
import '../styles/splash-cursor.css';
import { createSplashSimulation, type SplashConfig } from '../lib/splash-cursor-logic';

interface SplashCursorProps {
  SIM_RESOLUTION?: number;
  DYE_RESOLUTION?: number;
  CAPTURE_RESOLUTION?: number;
  DENSITY_DISSIPATION?: number;
  VELOCITY_DISSIPATION?: number;
  PRESSURE?: number;
  PRESSURE_ITERATIONS?: number;
  CURL?: number;
  SPLAT_RADIUS?: number;
  SPLAT_FORCE?: number;
  SHADING?: boolean;
  COLOR_UPDATE_SPEED?: number;
  BACK_COLOR?: { r: number; g: number; b: number };
  TRANSPARENT?: boolean;
}

export default function SplashCursor(props: SplashCursorProps) {
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(() => {
    const canvas = canvasRef!;
    if (!canvas) return;

    const config: SplashConfig = {
      SIM_RESOLUTION: props.SIM_RESOLUTION ?? 128,
      DYE_RESOLUTION: props.DYE_RESOLUTION ?? 1440,
      CAPTURE_RESOLUTION: props.CAPTURE_RESOLUTION ?? 512,
      DENSITY_DISSIPATION: props.DENSITY_DISSIPATION ?? 3.5,
      VELOCITY_DISSIPATION: props.VELOCITY_DISSIPATION ?? 2,
      PRESSURE: props.PRESSURE ?? 0.1,
      PRESSURE_ITERATIONS: props.PRESSURE_ITERATIONS ?? 20,
      CURL: props.CURL ?? 3,
      SPLAT_RADIUS: props.SPLAT_RADIUS ?? 0.2,
      SPLAT_FORCE: props.SPLAT_FORCE ?? 6000,
      SHADING: props.SHADING ?? true,
      COLOR_UPDATE_SPEED: props.COLOR_UPDATE_SPEED ?? 10,
      PAUSED: false,
      BACK_COLOR: props.BACK_COLOR ?? { r: 0.035, g: 0.035, b: 0.043 },
      TRANSPARENT: props.TRANSPARENT ?? true,
    };

    const sim = createSplashSimulation(canvas, config);
    if (!sim) return;

    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    let disabled = false;
    const disableCanvas = () => {
      if (disabled) return;
      disabled = true;
      canvas.hidden = true;
      canvas.style.display = 'none';
      sim.destroy();
    };
    const handleContextLost = () => {
      // Do not cancel the event: cancellation asks the browser to restore this
      // context, while this decorative surface is intentionally retired.
      disableCanvas();
    };
    const handleVisibilityChange = () => {
      if (coarsePointer && document.visibilityState === 'hidden') disableCanvas();
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    onCleanup(() => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (!disabled) sim.destroy();
    });

    if (coarsePointer && document.visibilityState === 'hidden') {
      disableCanvas();
      return;
    }
    sim.start();
  });

  return (
    <div class="splash-cursor-container">
      <canvas
        ref={canvasRef}
        class="splash-cursor-canvas"
        aria-hidden="true"
      />
    </div>
  );
}
