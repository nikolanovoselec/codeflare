import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type HeaderFactory = (
  tui: unknown,
  theme: {
    bold(text: string): string;
    fg(style: string, text: string): string;
  },
) => { render(width: number): string[]; invalidate(): void };

type HeaderContext = {
  hasUI: boolean;
  cwd: string;
  model: { provider: string; id: string };
  getContextUsage(): { tokens: number; contextWindow: number; percent: number };
  sessionManager: { getSessionFile(): string };
  ui: { setHeader(factory: HeaderFactory | undefined): void };
};

type StartupHeaderExtension = (pi: {
  getActiveTools(): unknown[];
  getAllTools(): unknown[];
  getThinkingLevel(): string;
  on(event: string, handler: (event: unknown, ctx: HeaderContext) => void): void;
  registerCommand(name: string, command: unknown): void;
}) => void;

async function loadStartupHeaderExtension(): Promise<StartupHeaderExtension> {
  const sourcePath = resolve(repoRoot, 'preseed/agents/pi/extensions/startup-header.ts');
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'pi-tui-fixture',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@earendil-works\/pi-tui$/ }, () => ({
          path: 'pi-tui-fixture',
          namespace: 'fixture',
        }));
        esbuild.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `
            export const visibleWidth = (text) => text.length;
            export const truncateToWidth = (text, width) => text.slice(0, Math.max(0, width));
          `,
          loader: 'js',
        }));
      },
    }],
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return (await import(moduleUrl)).default as StartupHeaderExtension;
}

describe('REQ-AGENT-161: Pi startup header terminal width safety', () => {
  it('keeps every rendered line within narrow terminal widths', async () => {
    const handlers = new Map<string, (event: unknown, ctx: HeaderContext) => void>();
    let headerFactory: HeaderFactory | undefined;
    const startupHeaderExtension = await loadStartupHeaderExtension();
    const ctx: HeaderContext = {
      hasUI: true,
      cwd: '/home/user/workspace',
      model: { provider: 'openai-codex', id: 'gpt-5.6-solo' },
      getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
      sessionManager: {
        getSessionFile: () => '/home/user/.pi/agent/sessions/mobile-session.jsonl',
      },
      ui: {
        setHeader: (factory) => { headerFactory = factory; },
      },
    };

    startupHeaderExtension({
      getActiveTools: () => Array.from({ length: 24 }),
      getAllTools: () => Array.from({ length: 32 }),
      getThinkingLevel: () => 'medium',
      on: (event, handler) => { handlers.set(event, handler); },
      registerCommand: () => undefined,
    });
    handlers.get('session_start')?.({}, ctx);
    const component = headerFactory?.({}, {
      bold: (text) => text,
      fg: (_style, text) => text,
    });
    if (!component) throw new Error('startup header was not installed');

    for (const width of [44, 36, 20, 2, 1, 0]) {
      const lines = component.render(width);
      if (width >= 2) expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => line.length <= width)).toBe(true);
    }
  });
});
