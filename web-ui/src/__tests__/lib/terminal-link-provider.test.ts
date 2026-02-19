import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the internal helper types exported from the module.
// Since registerMultiLineLinkProvider requires a full xterm Terminal instance,
// we test it by constructing a mock terminal that satisfies the ILinkProvider interface.

vi.mock('../../lib/mobile', () => ({
  isTouchDevice: vi.fn(() => false),
}));

import { registerMultiLineLinkProvider } from '../../lib/terminal-link-provider';
import type { XTermBuffer, XTermLine } from '../../lib/terminal-link-provider';

function createMockLine(text: string, isWrapped = false): XTermLine {
  return {
    isWrapped,
    translateToString: (_trimRight?: boolean) => text,
  };
}

function createMockBuffer(lines: XTermLine[]): XTermBuffer {
  return {
    length: lines.length,
    getLine: (y: number) => lines[y],
  };
}

function createMockTerminal(lines: XTermLine[], cols: number) {
  const buffer = createMockBuffer(lines);
  let registeredProvider: any = null;

  return {
    buffer: { active: buffer },
    cols,
    registerLinkProvider(provider: any) {
      registeredProvider = provider;
      return { dispose: vi.fn() };
    },
    getProvider() { return registeredProvider; },
  };
}

describe('terminal-link-provider', () => {
  describe('registerMultiLineLinkProvider', () => {
    it('registers a link provider and returns a disposable', () => {
      const terminal = createMockTerminal(
        [createMockLine('Hello world')],
        80,
      );

      const disposable = registerMultiLineLinkProvider(terminal as any);

      expect(disposable).toBeTruthy();
      expect(typeof disposable.dispose).toBe('function');
    });

    it('detects a simple URL on a single line', () => {
      const terminal = createMockTerminal(
        [createMockLine('Visit https://example.com for details')],
        80,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeTruthy();
          expect(links).toHaveLength(1);
          expect(links[0].text).toBe('https://example.com');
          resolve();
        });
      });
    });

    it('returns undefined when no URLs are found', () => {
      const terminal = createMockTerminal(
        [createMockLine('No links here')],
        80,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it('detects URLs spanning wrapped lines', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(60);
      const part1 = longUrl.slice(0, 40);
      const part2 = longUrl.slice(40);

      const terminal = createMockTerminal(
        [
          createMockLine(part1, false),
          createMockLine(part2, true),
        ],
        40,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeTruthy();
          expect(links).toHaveLength(1);
          expect(links[0].text).toBe(longUrl);
          resolve();
        });
      });
    });

    it('detects multiple URLs on the same line', () => {
      const terminal = createMockTerminal(
        [createMockLine('See https://a.com and https://b.com')],
        80,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeTruthy();
          expect(links).toHaveLength(2);
          expect(links[0].text).toBe('https://a.com');
          expect(links[1].text).toBe('https://b.com');
          resolve();
        });
      });
    });

    it('returns undefined for empty lines', () => {
      const terminal = createMockTerminal(
        [createMockLine('')],
        80,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    // Bubble Tea TUI simulation tests: OpenCode renders auth URLs inside
    // an alternate screen buffer with surrounding TUI chrome (borders, padding).
    // The link provider must detect URLs even when surrounded by box-drawing
    // characters and padding from lipgloss/Bubble Tea rendering.
    describe('Bubble Tea TUI output (OpenCode auth URL)', () => {
      it('detects URL on a line with leading whitespace (TUI padding)', () => {
        const terminal = createMockTerminal(
          [createMockLine('  Please open this URL in your browser to authenticate:'),
           createMockLine('  https://console.anthropic.com/oauth/authorize?client_id=abc&state=xyz')],
          120,
        );

        registerMultiLineLinkProvider(terminal as any);
        const provider = terminal.getProvider();

        return new Promise<void>((resolve) => {
          provider.provideLinks(2, (links: any) => {
            expect(links).toBeTruthy();
            expect(links).toHaveLength(1);
            expect(links[0].text).toContain('https://console.anthropic.com/oauth/authorize');
            resolve();
          });
        });
      });

      it('detects URL surrounded by box-drawing characters', () => {
        // Simulates lipgloss border rendering: │ url │
        const terminal = createMockTerminal(
          [createMockLine('│ Authenticate your account at                                            │'),
           createMockLine('│ https://console.anthropic.com/oauth/authorize?client_id=abc&state=xyz  │'),
           createMockLine('│ (press ENTER to open in browser)                                      │')],
          80,
        );

        registerMultiLineLinkProvider(terminal as any);
        const provider = terminal.getProvider();

        return new Promise<void>((resolve) => {
          provider.provideLinks(2, (links: any) => {
            expect(links).toBeTruthy();
            expect(links).toHaveLength(1);
            expect(links[0].text).toContain('https://console.anthropic.com/oauth/authorize');
            resolve();
          });
        });
      });

      it('detects long OAuth URL that wraps across multiple lines in TUI', () => {
        // Long OAuth URLs with many query params may wrap at the terminal width
        const longUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc123&redirect_uri=http%3A%2F%2Flocalhost%3A9876%2Fcallback&scope=user%3Asessions&state=randomstate123456789';
        const cols = 80;
        const part1 = longUrl.slice(0, cols);
        const part2 = longUrl.slice(cols);

        const terminal = createMockTerminal(
          [createMockLine(part1, false),
           createMockLine(part2, true)],
          cols,
        );

        registerMultiLineLinkProvider(terminal as any);
        const provider = terminal.getProvider();

        return new Promise<void>((resolve) => {
          provider.provideLinks(1, (links: any) => {
            expect(links).toBeTruthy();
            expect(links).toHaveLength(1);
            expect(links[0].text).toBe(longUrl);
            resolve();
          });
        });
      });

      it('detects URL after "Please open this URL" warning text', () => {
        // OpenCode's fallback message when xdg-open fails
        const terminal = createMockTerminal(
          [createMockLine('  WARN  Please open this URL in your browser to authenticate:'),
           createMockLine('  https://console.anthropic.com/oauth/authorize?response_type=code')],
          120,
        );

        registerMultiLineLinkProvider(terminal as any);
        const provider = terminal.getProvider();

        return new Promise<void>((resolve) => {
          provider.provideLinks(2, (links: any) => {
            expect(links).toBeTruthy();
            expect(links).toHaveLength(1);
            expect(links[0].text).toContain('https://console.anthropic.com/oauth/authorize');
            resolve();
          });
        });
      });
    });
  });

  describe('TUI dialog URL detection (narrow dialog, wide terminal)', () => {
    it('detects URL split across non-wrapped lines inside a narrow TUI dialog', () => {
      // Simulates a 40-column dialog inside an 80-column terminal.
      // The URL spans two lines but neither line fills the terminal width.
      // The insideUrl heuristic should still join them because fullText ends mid-URL.
      const url = 'https://console.anthropic.com/oauth/authorize?client_id=abc123&state=xyz';
      const cols = 80;
      // Line 0: dialog text with start of URL (40 chars, way less than 80 cols)
      const line0 = url.slice(0, 40);  // "https://console.anthropic.com/oauth/auth"
      const line1 = url.slice(40);     // "orize?client_id=abc123&state=xyz"

      const terminal = createMockTerminal(
        [
          createMockLine(line0, false),
          createMockLine(line1, false),  // NOT wrapped — app-inserted newline
        ],
        cols,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeTruthy();
          expect(links).toHaveLength(1);
          expect(links[0].text).toBe(url);
          resolve();
        });
      });
    });

    it('does not false-positive join non-URL narrow lines', () => {
      // Two short lines that are NOT URLs should NOT be joined
      const cols = 80;
      const terminal = createMockTerminal(
        [
          createMockLine('Hello world, this is a test', false),
          createMockLine('Another line of text here', false),
        ],
        cols,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it('detects URL split across 3 non-wrapped lines in narrow dialog', () => {
      const url = 'https://console.anthropic.com/oauth/authorize?client_id=abc123&redirect_uri=http%3A%2F%2Flocalhost&state=xyz789';
      const cols = 80;
      const line0 = url.slice(0, 35);
      const line1 = url.slice(35, 70);
      const line2 = url.slice(70);

      const terminal = createMockTerminal(
        [
          createMockLine(line0, false),
          createMockLine(line1, false),
          createMockLine(line2, false),
        ],
        cols,
      );

      registerMultiLineLinkProvider(terminal as any);
      const provider = terminal.getProvider();

      return new Promise<void>((resolve) => {
        provider.provideLinks(1, (links: any) => {
          expect(links).toBeTruthy();
          expect(links).toHaveLength(1);
          expect(links[0].text).toBe(url);
          resolve();
        });
      });
    });
  });
});
