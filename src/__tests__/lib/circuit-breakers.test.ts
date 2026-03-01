import { describe, it, expect } from 'vitest';
import {
  r2AdminCB,
  cfApiCB,
  getContainerHealthCB,
  getContainerInternalCB,
  getContainerSessionsCB,
} from '../../lib/circuit-breakers';

describe('pre-configured circuit breakers', () => {
  it('r2AdminCB is in CLOSED state', () => {
    expect(r2AdminCB.getState()).toBe('CLOSED');
  });

  it('cfApiCB is in CLOSED state', () => {
    expect(cfApiCB.getState()).toBe('CLOSED');
  });

  it('pre-configured non-container breakers are distinct instances', () => {
    const all = [r2AdminCB, cfApiCB];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  it('per-container breaker factories return CLOSED state by default', () => {
    expect(getContainerHealthCB('test-cb').getState()).toBe('CLOSED');
    expect(getContainerInternalCB('test-cb').getState()).toBe('CLOSED');
    expect(getContainerSessionsCB('test-cb').getState()).toBe('CLOSED');
  });
});
