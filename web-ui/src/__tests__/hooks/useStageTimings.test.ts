import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot, createSignal, createEffect } from 'solid-js';
import { useStageTimings } from '../../hooks/useStageTimings';
import type { InitStage } from '../../types';

describe('useStageTimings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not set startTime until the first stage transition', () => {
    let result!: ReturnType<typeof useStageTimings>;
    let setStage!: (s: InitStage | undefined) => void;
    let setProgress!: (p: { stage: string } | null) => void;

    const dispose = createRoot((dispose) => {
      const [stage, _setStage] = createSignal<InitStage | undefined>(undefined);
      const [progress, _setProgress] = createSignal<{ stage: string } | null>(null);
      setStage = _setStage;
      setProgress = _setProgress;
      result = useStageTimings(stage, progress);
      return dispose;
    });

    // Before any stage, startTime should be 0 (unset)
    expect(result.startTime()).toBe(0);

    // Trigger a stage transition
    setStage('creating');
    setProgress({ stage: 'creating' });

    // After stage transition, startTime should be set
    expect(result.startTime()).toBeGreaterThan(0);

    dispose();
  });

  it('should calculate totalTime > 0 when reaching ready', () => {
    let result!: ReturnType<typeof useStageTimings>;
    let setStage!: (s: InitStage | undefined) => void;
    let setProgress!: (p: { stage: string } | null) => void;
    let now = 1000;

    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const dispose = createRoot((dispose) => {
      const [stage, _setStage] = createSignal<InitStage | undefined>(undefined);
      const [progress, _setProgress] = createSignal<{ stage: string } | null>(null);
      setStage = _setStage;
      setProgress = _setProgress;
      result = useStageTimings(stage, progress);
      return dispose;
    });

    // Start creating stage at t=1000
    setStage('creating');
    setProgress({ stage: 'creating' });
    expect(result.startTime()).toBe(1000);

    // Advance time to t=3500 and move to ready
    now = 3500;
    setStage('ready');
    setProgress({ stage: 'ready' });

    // totalTime should be 2.5 seconds
    expect(result.totalTime()).toBe(2.5);
    expect(result.formatTotalTime()).toBe('2.5');

    dispose();
  });

  it('should not update startTime on subsequent stage changes', () => {
    let result!: ReturnType<typeof useStageTimings>;
    let setStage!: (s: InitStage | undefined) => void;
    let setProgress!: (p: { stage: string } | null) => void;
    let now = 5000;

    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const dispose = createRoot((dispose) => {
      const [stage, _setStage] = createSignal<InitStage | undefined>(undefined);
      const [progress, _setProgress] = createSignal<{ stage: string } | null>(null);
      setStage = _setStage;
      setProgress = _setProgress;
      result = useStageTimings(stage, progress);
      return dispose;
    });

    // First stage at t=5000
    setStage('creating');
    setProgress({ stage: 'creating' });
    expect(result.startTime()).toBe(5000);

    // Move to next stage at t=6000
    now = 6000;
    setStage('starting');
    setProgress({ stage: 'starting' });

    // startTime should remain as original
    expect(result.startTime()).toBe(5000);

    dispose();
  });

  it('should use startedAt from progress when available', () => {
    let result!: ReturnType<typeof useStageTimings>;
    let setStage!: (s: InitStage | undefined) => void;
    let setProgress!: (p: { stage: string; startedAt?: number } | null) => void;

    vi.spyOn(Date, 'now').mockImplementation(() => 1000);

    const dispose = createRoot((dispose) => {
      const [stage, _setStage] = createSignal<InitStage | undefined>(undefined);
      const [progress, _setProgress] = createSignal<{ stage: string; startedAt?: number } | null>(null);
      setStage = _setStage;
      setProgress = _setProgress;
      result = useStageTimings(stage, progress);
      return dispose;
    });

    // Set progress with startedAt = 500 (earlier than Date.now() mock of 1000)
    setProgress({ stage: 'creating', startedAt: 500 });
    setStage('creating');

    // startTime should use startedAt (500), not Date.now() (1000)
    expect(result.startTime()).toBe(500);

    dispose();
  });

  it('should not set startTime for stopped stage', () => {
    let result!: ReturnType<typeof useStageTimings>;
    let setStage!: (s: InitStage | undefined) => void;
    let setProgress!: (p: { stage: string } | null) => void;

    const dispose = createRoot((dispose) => {
      const [stage, _setStage] = createSignal<InitStage | undefined>(undefined);
      const [progress, _setProgress] = createSignal<{ stage: string } | null>(null);
      setStage = _setStage;
      setProgress = _setProgress;
      result = useStageTimings(stage, progress);
      return dispose;
    });

    setStage('stopped');
    setProgress({ stage: 'stopped' });

    // startTime should remain 0 for 'stopped'
    expect(result.startTime()).toBe(0);

    dispose();
  });
});
