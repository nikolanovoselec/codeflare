import { createSignal, createEffect, onCleanup } from 'solid-js';
import { stageOrder } from '../lib/stages';
import type { InitStage } from '../types';

interface StageTime {
  start: number;
  elapsed: number;
}

const stageKeys: InitStage[] = ['creating', 'starting', 'syncing', 'verifying', 'mounting', 'ready'];

export function useStageTimings(
  stage: () => InitStage | undefined,
  progress: () => { stage: string; startedAt?: number } | null,
) {
  const [stageTimes, setStageTimes] = createSignal<Record<string, StageTime>>({});
  const [currentTime, setCurrentTime] = createSignal(Date.now());
  const [startTime, setStartTime] = createSignal<number>(0);
  const [totalTime, setTotalTime] = createSignal<number | null>(null);

  // Update current time every 100ms for live elapsed display
  let timerInterval: number | undefined;
  createEffect(() => {
    const currentStage = stage();
    if (!currentStage || currentStage === 'ready' || currentStage === 'error') {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
      }
      // Calculate total time when ready (only if startTime was captured)
      if (currentStage === 'ready' && totalTime() === null && startTime() > 0) {
        setTotalTime((Date.now() - startTime()) / 1000);
      }
      return;
    }
    if (!timerInterval) {
      timerInterval = window.setInterval(() => {
        setCurrentTime(Date.now());
      }, 100);
    }
  });

  onCleanup(() => {
    if (timerInterval) {
      clearInterval(timerInterval);
    }
  });

  // Track stage transitions for elapsed time calculation
  createEffect(() => {
    const currentStage = stage();
    if (!currentStage || currentStage === 'stopped') return;

    // Capture startTime on first real stage transition
    if (!startTime() && currentStage !== 'error') {
      const progressData = progress();
      const ts = progressData?.startedAt || Date.now();
      setStartTime(ts);
    }

    setStageTimes(prev => {
      const now = Date.now();
      const updated = { ...prev };

      // If this stage hasn't started yet, record its start time
      if (!updated[currentStage]) {
        updated[currentStage] = { start: now, elapsed: 0 };
      }

      // Mark all previous stages as completed with their elapsed times
      stageKeys.forEach(key => {
        if (stageOrder[key] < stageOrder[currentStage] && updated[key]) {
          if (updated[key].elapsed === 0) {
            const nextStageStart = updated[currentStage]?.start || now;
            updated[key] = {
              ...updated[key],
              elapsed: (nextStageStart - updated[key].start) / 1000,
            };
          }
        }
      });

      return updated;
    });
  });

  const getElapsedTime = (stageKey: InitStage, getStatus: (key: InitStage) => string): string => {
    if (stageKey === 'ready') return '';

    const times = stageTimes();
    const stageTime = times[stageKey];
    if (!stageTime) return '';

    const status = getStatus(stageKey);
    if (status === 'completed' && stageTime.elapsed > 0) {
      return `${stageTime.elapsed.toFixed(1)}s`;
    }
    if (status === 'active') {
      const elapsed = (currentTime() - stageTime.start) / 1000;
      return `${elapsed.toFixed(1)}s`;
    }
    return '';
  };

  const formatTotalTime = () => {
    const time = totalTime();
    if (time === null) return null;
    return time.toFixed(1);
  };

  return {
    stageTimes,
    currentTime,
    startTime,
    totalTime,
    getElapsedTime,
    formatTotalTime,
  };
}
