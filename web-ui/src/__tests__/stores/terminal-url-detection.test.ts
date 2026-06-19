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
  getLastUrlFromBuffer,
} from '../../stores/terminal-url-detection';

describe('terminal-url-detection / REQ-AGENT-013 / REQ-TERM-015 (browser shim for OAuth)', () => {
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

  it('REQ-TERM-015: keeps the focused pane scanner when an older pane cleans up', () => {
    const scanned: string[] = [];
    const setAuthUrl = vi.fn();
    const setNormalUrl = vi.fn();

    const focusedTerminal = {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          length: 1,
          viewportY: 0,
          getLine: () => ({ isWrapped: false, translateToString: () => 'https://console.anthropic.com/login' }),
        },
      },
    } as unknown as Terminal;

    registerUrlDetectionDeps(
      (sessionId: string, terminalId: string) => {
        scanned.push(`${sessionId}:${terminalId}`);
        return sessionId === 'session-b' && terminalId === '1' ? focusedTerminal : undefined;
      },
      setAuthUrl,
      setNormalUrl,
    );

    startUrlDetection('session-a', '1');
    startUrlDetection('session-b', '1');
    setAuthUrl.mockClear();
    setNormalUrl.mockClear();
    stopUrlDetection('session-a', '1');

    vi.advanceTimersByTime(60);

    expect(scanned).toContain('session-b:1');
    expect(scanned).not.toContain('session-a:1');
    expect(setAuthUrl).toHaveBeenCalledWith(expect.stringContaining('console.anthropic.com'));
  });

  it('joins a long OAuth URL whose tail wraps past the viewport edge (no truncation)', () => {
    // Regression: a real Antigravity Google sign-in URL printed by `agy` wraps
    // across ~13 narrow-mobile rows. With the on-screen keyboard open `rows` is
    // small, so the URL's tail lands below the visible viewport. The previous
    // join loop was bounded by `viewportY + rows + 3` and cut the URL mid-string
    // (".../auth/cclog+https%3A%2F%2Fwww.googleapi"), which Google rejected with
    // invalid_scope. The fix follows continuation rows to buffer.length instead.
    const scopes = [
      'cloud-platform',
      'userinfo.email',
      'userinfo.profile',
      'cclog',
      'experimentsandconfigs',
    ];
    const scopeParam = scopes
      .map((s) => `https%3A%2F%2Fwww.googleapis.com%2Fauth%2F${s}`)
      .join('+');
    const fullUrl =
      'https://accounts.google.com/o/oauth2/auth?response_type=code&scope=' +
      scopeParam +
      '+openid&state=_M7OFsKu7L5FTcCCgWnG1A';

    // Slice the URL into 50-char physical rows. Row 0 is the logical line start
    // (isWrapped:false); every subsequent row is a soft-wrap continuation.
    const WIDTH = 50;
    const rowTexts: string[] = [];
    for (let p = 0; p < fullUrl.length; p += WIDTH) {
      rowTexts.push(fullUrl.slice(p, p + WIDTH));
    }
    const lines = rowTexts.map((text, idx) => ({
      isWrapped: idx > 0,
      translateToString: () => text,
    }));

    const mockTerminal = {
      // rows tiny (mobile keyboard) so viewportY+rows+3 stops well short of the
      // URL tail; buffer.length spans every continuation row.
      cols: WIDTH,
      rows: 4,
      buffer: {
        active: {
          length: lines.length,
          viewportY: 0,
          getLine: (i: number) => lines[i],
        },
      },
    } as unknown as Terminal;

    const detected = getLastUrlFromBuffer(mockTerminal);
    expect(detected).toBe(fullUrl);
    // Explicit guard against the historical cut point.
    expect(detected).not.toMatch(/googleapi$/);
    expect(detected).toContain('experimentsandconfigs');
    expect(detected).toContain('state=_M7OFsKu7L5FTcCCgWnG1A');
  });
});
