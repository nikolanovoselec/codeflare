import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/mobile', () => ({
  isTouchDevice: vi.fn(() => false),
}));

vi.mock('../../lib/constants', async () => {
  const actual = await vi.importActual('../../lib/constants') as Record<string, unknown>;
  return actual;
});

import { terminalStore } from '../../stores/terminal';

interface MockLine {
  isWrapped: boolean;
  translateToString: (trimRight?: boolean) => string;
}

function createMockLine(text: string, isWrapped = false): MockLine {
  return {
    isWrapped,
    translateToString: (_trimRight?: boolean) => text,
  };
}

function createMockTerminal(lines: MockLine[], cols = 80) {
  return {
    cols,
    rows: 24,
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number) => lines[y],
      },
    },
  };
}

describe('getLastUrlFromBuffer', () => {
  describe('single-line URLs', () => {
    it('finds a URL on a single line', () => {
      const term = createMockTerminal([
        createMockLine('Visit https://example.com/path?q=1 for info'),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://example.com/path?q=1');
    });

    it('returns the LAST URL when multiple exist', () => {
      const term = createMockTerminal([
        createMockLine('https://first.com'),
        createMockLine('some text'),
        createMockLine('https://last.com/final'),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://last.com/final');
    });

    it('returns null when no URLs exist', () => {
      const term = createMockTerminal([
        createMockLine('no urls here'),
        createMockLine('just plain text'),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBeNull();
    });
  });

  describe('xterm isWrapped continuation', () => {
    it('joins wrapped lines for long URLs', () => {
      const fullUrl = 'https://example.com/' + 'a'.repeat(100);
      const part1 = fullUrl.slice(0, 80);
      const part2 = fullUrl.slice(80);

      const term = createMockTerminal([
        createMockLine(part1, false),
        createMockLine(part2, true),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe(fullUrl);
    });
  });

  describe('whitespace-padded TUI dialog (Claude Code / ink)', () => {
    it('joins URL split across padded lines', () => {
      const term = createMockTerminal([
        createMockLine('                    https://claude.ai/oauth/authorize?'),
        createMockLine('                    code=true&client_id=abc-def-123'),
        createMockLine('                    &response_type=code&state=xyz'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe(
        'https://claude.ai/oauth/authorize?code=true&client_id=abc-def-123&response_type=code&state=xyz'
      );
    });

    it('does not join padded non-URL lines', () => {
      const term = createMockTerminal([
        createMockLine('                    Hello world'),
        createMockLine('                    this is just text'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBeNull();
    });
  });

  describe('box-drawing bordered TUI dialog (OpenCode / Bubble Tea)', () => {
    it('joins URL split across │-bordered lines', () => {
      const term = createMockTerminal([
        createMockLine('│ Paste the authorization code here:              │'),
        createMockLine('│                                                 │'),
        createMockLine('│ https://claude.ai/oauth/authorize?              │'),
        createMockLine('│ code=true&client_id=9d1c250a-e61b-44d9-88ed-   │'),
        createMockLine('│ 5944d1962f5e&response_type=code                │'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe(
        'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code'
      );
    });

    it('joins full OAuth URL across many bordered lines', () => {
      const term = createMockTerminal([
        createMockLine('│ https://claude.ai/oauth/authorize?          │', false),
        createMockLine('│ code=true&client_id=9d1c250a-e61b-44d9-    │', false),
        createMockLine('│ 88ed-5944d1962f5e&response_type=code&      │', false),
        createMockLine('│ redirect_uri=https%3A%2F%2Fconsole.anthro  │', false),
        createMockLine('│ pic.com%2Foauth%2Fcode%2Fcallback          │', false),
      ], 60);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).not.toBeNull();
      expect(url).toContain('https://claude.ai/oauth/authorize?');
      expect(url).toContain('code=true');
      expect(url).toContain('client_id=9d1c250a');
      expect(url).toContain('redirect_uri=https%3A%2F%2Fconsole.anthro');
      expect(url).toContain('pic.com%2Foauth%2Fcode%2Fcallback');
    });

    it('finds single-line URL inside borders', () => {
      const term = createMockTerminal([
        createMockLine('│ https://github.com/login/device                           │'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://github.com/login/device');
    });

    it('does not join bordered text lines after a URL', () => {
      const term = createMockTerminal([
        createMockLine('│ https://example.com/login                                 │'),
        createMockLine('│ Press ENTER to continue                                   │'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://example.com/login');
    });

    it('handles ┃ (heavy vertical) borders', () => {
      const term = createMockTerminal([
        createMockLine('┃ https://accounts.google.com/o/oauth2/auth?              ┃'),
        createMockLine('┃ client_id=abc123&scope=email                            ┃'),
      ]);

      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toContain('https://accounts.google.com/o/oauth2/auth?');
      expect(url).toContain('client_id=abc123&scope=email');
    });
  });

  describe('isActionableUrl', () => {
    it('classifies OAuth authorize URL as actionable', () => {
      expect(terminalStore.isActionableUrl('https://claude.ai/oauth/authorize?code=true')).toBe(true);
    });

    it('classifies console.anthropic.com URL as actionable', () => {
      expect(terminalStore.isActionableUrl('https://console.anthropic.com/settings')).toBe(true);
    });

    it('classifies GitHub device login as actionable', () => {
      expect(terminalStore.isActionableUrl('https://github.com/login/device')).toBe(true);
    });

    it('classifies Google OAuth as actionable', () => {
      expect(terminalStore.isActionableUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true);
    });

    it('does NOT classify regular URLs as actionable', () => {
      expect(terminalStore.isActionableUrl('https://example.com')).toBe(false);
      expect(terminalStore.isActionableUrl('https://google.com/search?q=test')).toBe(false);
    });
  });

  describe('regression: non-bordered agents still work', () => {
    it('plain output URL (Codex / Gemini)', () => {
      const term = createMockTerminal([
        createMockLine('https://github.com/login/device?code=ABCD-1234'),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://github.com/login/device?code=ABCD-1234');
    });

    it('URL followed by shell prompt is not extended', () => {
      const term = createMockTerminal([
        createMockLine('https://example.com/oauth/authorize?code=abc'),
        createMockLine('$ '),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://example.com/oauth/authorize?code=abc');
    });

    it('URL followed by new URL does not merge them', () => {
      const term = createMockTerminal([
        createMockLine('https://example.com/first'),
        createMockLine('https://example.com/second'),
      ]);
      const url = terminalStore.getLastUrlFromBuffer(term as any);
      expect(url).toBe('https://example.com/second');
    });
  });
});
