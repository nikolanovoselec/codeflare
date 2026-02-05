import { describe, it, expect } from 'vitest';
import {
  containerHealthCB,
  containerInternalCB,
  containerSessionsCB,
  r2AdminCB,
  cfApiCB,
} from '../../lib/circuit-breakers';

describe('pre-configured circuit breakers', () => {
  it('containerHealthCB is in CLOSED state', () => {
    expect(containerHealthCB.getState()).toBe('CLOSED');
  });

  it('containerInternalCB is in CLOSED state', () => {
    expect(containerInternalCB.getState()).toBe('CLOSED');
  });

  it('containerSessionsCB is in CLOSED state', () => {
    expect(containerSessionsCB.getState()).toBe('CLOSED');
  });

  it('r2AdminCB is in CLOSED state', () => {
    expect(r2AdminCB.getState()).toBe('CLOSED');
  });

  it('cfApiCB is in CLOSED state', () => {
    expect(cfApiCB.getState()).toBe('CLOSED');
  });

  it('pre-configured breakers are distinct instances', () => {
    const all = [containerHealthCB, containerInternalCB, containerSessionsCB, r2AdminCB, cfApiCB];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });
});
