import type { InitStage } from '../types';

export const stageOrder: Record<InitStage, number> = {
  stopped: -1,
  creating: 0,
  starting: 1,
  syncing: 2,
  verifying: 3,
  mounting: 4,
  ready: 5,
  error: -2,
};
