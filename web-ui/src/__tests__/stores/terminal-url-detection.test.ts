import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Mock constants before importing
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    URL_CHECK_INTERVAL_MS: 50,
  };
});

// Mock API client
vi.mock('../../api/client', () => ({
  getTerminalWebSocketUrl: vi.fn(
    (sessionId: string, terminalId: string) =>
      `ws://localhost/api/terminal/${sessionId}-${terminalId}/ws`
  ),
}));

// Import after mocks
import {
  registerUrlDetectionDeps,
  startUrlDetection,
  stopUrlDetection,
} from '../../stores/terminal-url-detection';

describe('terminal-url-detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopUrlDetection();
    vi.useRealTimers();
  });

  it('startUrlDetection detects auth URLs via periodic buffer scan', () => {
    // Create a mock terminal with a buffer containing an auth URL
    const mockBuffer = {
      active: {
        length: 5,
        viewportY: 0,
        getLine: (i: number) => {
          if (i === 0) return {
            isWrapped: false,
            translateToString: () => 'Visit https://console.anthropic.com/login to authenticate',
          };
          return null;
        },
      },
    };
    const mockTerminal = {
      cols: 80,
      rows: 24,
      buffer: mockBuffer,
    } as unknown as Terminal;

    // Provide a getter that returns our mock terminal
    const setAuthUrl = vi.fn();
    const setNormalUrl = vi.fn();

    registerUrlDetectionDeps(
      (_sid: string, _tid: string) => mockTerminal, // getTerminal
      setAuthUrl,
      setNormalUrl,
    );

    startUrlDetection('test-session', '1');

    // Advance past the interval
    vi.advanceTimersByTime(60);

    // Should have detected the auth URL
    expect(setAuthUrl).toHaveBeenCalledWith(expect.stringContaining('console.anthropic.com'));
  });

  it('stopUrlDetection clears detected URLs', () => {
    const setAuthUrl = vi.fn();
    const setNormalUrl = vi.fn();

    registerUrlDetectionDeps(
      (_sid: string, _tid: string) => undefined, // no terminal
      setAuthUrl,
      setNormalUrl,
    );

    startUrlDetection('test-session', '1');
    stopUrlDetection();

    // After stop, both URL signals should be cleared
    expect(setAuthUrl).toHaveBeenCalledWith(null);
    expect(setNormalUrl).toHaveBeenCalledWith(null);
  });
});
