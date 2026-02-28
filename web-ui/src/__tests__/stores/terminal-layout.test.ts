import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FitAddon } from '@xterm/addon-fit';

// Mock constants before importing
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    CSS_TRANSITION_DELAY_MS: 10,
  };
});

// Mock API client
vi.mock('../../api/client', () => ({
  getTerminalWebSocketUrl: vi.fn(),
}));

// Import after mocks
import {
  registerFitAddon,
  unregisterFitAddon,
  triggerLayoutResize,
  getLayoutChangeCounter,
} from '../../stores/terminal-layout';

describe('terminal-layout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggerLayoutResize increments layout change counter', () => {
    const before = getLayoutChangeCounter();
    triggerLayoutResize();
    expect(getLayoutChangeCounter()).toBe(before + 1);
  });

  it('registerFitAddon/unregisterFitAddon manages addon map', () => {
    const mockFitAddon = { fit: vi.fn() } as unknown as FitAddon;

    // Should not throw
    expect(() => {
      registerFitAddon('session-1', '1', mockFitAddon);
    }).not.toThrow();

    expect(() => {
      unregisterFitAddon('session-1', '1');
    }).not.toThrow();
  });
});
