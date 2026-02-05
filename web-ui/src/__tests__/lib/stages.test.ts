import { describe, it, expect } from 'vitest';
import { stageOrder } from '../../lib/stages';

describe('stages', () => {
  describe('stageOrder', () => {
    it('defines ordering for all init stages', () => {
      expect(stageOrder).toHaveProperty('stopped');
      expect(stageOrder).toHaveProperty('creating');
      expect(stageOrder).toHaveProperty('starting');
      expect(stageOrder).toHaveProperty('syncing');
      expect(stageOrder).toHaveProperty('verifying');
      expect(stageOrder).toHaveProperty('mounting');
      expect(stageOrder).toHaveProperty('ready');
      expect(stageOrder).toHaveProperty('error');
    });

    it('orders stages in correct progression (creating < starting < syncing < ... < ready)', () => {
      expect(stageOrder.creating).toBeLessThan(stageOrder.starting);
      expect(stageOrder.starting).toBeLessThan(stageOrder.syncing);
      expect(stageOrder.syncing).toBeLessThan(stageOrder.verifying);
      expect(stageOrder.verifying).toBeLessThan(stageOrder.mounting);
      expect(stageOrder.mounting).toBeLessThan(stageOrder.ready);
    });

    it('places error and stopped below the normal progression', () => {
      expect(stageOrder.error).toBeLessThan(stageOrder.creating);
      expect(stageOrder.stopped).toBeLessThan(stageOrder.creating);
    });

    it('can be used for stage comparison sorting', () => {
      const stages = ['ready', 'creating', 'starting', 'error'] as const;
      const sorted = [...stages].sort((a, b) => stageOrder[a] - stageOrder[b]);
      expect(sorted).toEqual(['error', 'creating', 'starting', 'ready']);
    });
  });
});
