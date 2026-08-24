import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import startupHeaderExtension from '../../../preseed/agents/pi/extensions/startup-header';

type HeaderFactory = (
  tui: unknown,
  theme: {
    bold(text: string): string;
    fg(style: string, text: string): string;
  },
) => { render(width: number): string[]; invalidate(): void };

describe('REQ-AGENT-161: Pi startup header terminal width safety', () => {
  it('keeps every rendered line within narrow terminal widths', () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    let headerFactory: HeaderFactory | undefined;
    const pi = {
      getActiveTools: () => Array.from({ length: 24 }),
      getAllTools: () => Array.from({ length: 32 }),
      getThinkingLevel: () => 'medium',
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
        handlers.set(event, handler);
      },
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      cwd: '/home/user/workspace',
      model: { provider: 'openai-codex', id: 'gpt-5.6-solo' },
      getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
      sessionManager: {
        getSessionFile: () => '/home/user/.pi/agent/sessions/mobile-session.jsonl',
      },
      ui: {
        setHeader: (factory: HeaderFactory | undefined) => { headerFactory = factory; },
      },
    } as unknown as ExtensionContext;

    startupHeaderExtension(pi);
    handlers.get('session_start')?.({}, ctx);
    const component = headerFactory?.({}, {
      bold: (text) => text,
      fg: (_style, text) => text,
    });
    if (!component) throw new Error('startup header was not installed');

    for (const width of [44, 36, 20, 2, 1, 0]) {
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});
