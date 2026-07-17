import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = '/home/user/.cache/codeflare-hooks/graphify-active-cwd';
const ACTIVE_REPO_KEY = Symbol.for('codeflare.activeRepo');
const fsFixture = vi.hoisted(() => ({ sentinelRepo: undefined as string | undefined }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync(path: unknown, ...args: unknown[]) {
      if (String(path) === SENTINEL) {
        if (fsFixture.sentinelRepo === undefined) throw new Error('sentinel missing');
        return fsFixture.sentinelRepo;
      }
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    },
  };
});

import { rememberActiveRepo } from '../../../preseed/agents/pi/extensions/codeflare-pi';
import localStatuslineExtension from '../../../preseed/agents/pi/extensions/local-statusline';

type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(style: string, text: string): string },
  footerData: {
    onBranchChange(handler: () => void): () => void;
    getExtensionStatuses(): Map<string, string>;
  },
) => { dispose(): void; invalidate(): void; render(width: number): string[] };

type StatuslineContext = {
  hasUI: boolean;
  cwd: string;
  model?: { id?: string };
  sessionManager: { getCwd(): string };
  getContextUsage?: () => { percent?: number; tokens?: number | null; contextWindow?: number };
  ui: { setFooter(factory: FooterFactory): void };
};

function installStatusline(ctx: StatuslineContext, statuses = new Map<string, string>()) {
  const handlers = new Map<string, (event: unknown, context: StatuslineContext) => void>();
  let footerFactory: FooterFactory | undefined;
  localStatuslineExtension({
    getThinkingLevel: () => 'xhigh',
    on: (event: string, handler: (event: unknown, context: StatuslineContext) => void) => handlers.set(event, handler),
  });
  handlers.get('session_start')?.({}, {
    ...ctx,
    ui: { setFooter: (factory) => { footerFactory = factory; } },
  });
  const component = footerFactory?.(
    { requestRender: () => undefined },
    { fg: (_style, text) => text },
    { onBranchChange: () => () => undefined, getExtensionStatuses: () => statuses },
  );
  if (!component) throw new Error('statusline footer was not installed');
  return { component, handlers };
}

function repoFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return { root, repo };
}

beforeEach(() => {
  vi.useFakeTimers();
  fsFixture.sentinelRepo = undefined;
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[ACTIVE_REPO_KEY];
});

afterEach(() => {
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[ACTIVE_REPO_KEY];
  fsFixture.sentinelRepo = undefined;
  vi.useRealTimers();
});

describe('REQ-AGENT-056: Pi local statusline repository resolution', () => {
  it('REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation', () => {
    const { root, repo } = repoFixture('statusline-cwd-');
    const nested = join(repo, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    const statuses = new Map([
      ['review', 'Review \x1b[32mclean\x1b[0m'],
      ['background', 'Background agent active'],
    ]);

    try {
      const { component } = installStatusline({
        hasUI: true,
        cwd: nested,
        model: { id: 'gpt-5.5' },
        sessionManager: { getCwd: () => nested },
        getContextUsage: () => ({ tokens: 20, contextWindow: 40 }),
        ui: { setFooter: () => undefined },
      }, statuses);

      const full = component.render(120);
      expect(full[0]).toBe(`50% | gpt-5.5:xhigh | ${basename(repo)}:detached`);
      expect(full[1].replace(/\x1b\[[0-9;]*m/g, '')).toBe('Review clean | Background agent active');

      const narrow = component.render(20);
      expect(narrow.every((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length <= 20)).toBe(true);
      expect(narrow[1]).toContain('\x1b[32m');
      expect(narrow[1].replace(/\x1b\[[0-9;]*m/g, '')).toBe('Review clean | Back…');
      component.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-056: resolves the active repository remembered by the main Pi extension', () => {
    const { root, repo } = repoFixture('statusline-memory-');
    rememberActiveRepo(repo);

    try {
      const { component } = installStatusline({
        hasUI: true,
        cwd: root,
        sessionManager: { getCwd: () => root },
        ui: { setFooter: () => undefined },
      });
      expect(component.render(120)[0]).toBe(`--% | model:xhigh | ${basename(repo)}:detached`);
      component.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-056: uses the display sentinel only when its repository is inside the session root', () => {
    const inside = repoFixture('statusline-sentinel-inside-');
    const outside = repoFixture('statusline-sentinel-outside-');

    try {
      fsFixture.sentinelRepo = inside.repo;
      const insideFooter = installStatusline({
        hasUI: true,
        cwd: inside.root,
        sessionManager: { getCwd: () => inside.root },
        ui: { setFooter: () => undefined },
      }).component;
      expect(insideFooter.render(120)[0]).toBe(`--% | model:xhigh | ${basename(inside.repo)}:detached`);
      insideFooter.dispose();

      fsFixture.sentinelRepo = outside.repo;
      const guardedFooter = installStatusline({
        hasUI: true,
        cwd: inside.root,
        sessionManager: { getCwd: () => inside.root },
        ui: { setFooter: () => undefined },
      }).component;
      expect(guardedFooter.render(120)[0]).toBe('--% | model:xhigh');
      guardedFooter.dispose();
    } finally {
      rmSync(inside.root, { recursive: true, force: true });
      rmSync(outside.root, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-056: refreshes the footer on session, resource, turn, model, and effort changes', () => {
    const handlers = new Map<string, (event: unknown, context: StatuslineContext) => void>();
    const installed: FooterFactory[] = [];
    const ctx: StatuslineContext = {
      hasUI: true,
      cwd: '/tmp',
      sessionManager: { getCwd: () => '/tmp' },
      ui: { setFooter: (factory) => installed.push(factory) },
    };
    localStatuslineExtension({
      getThinkingLevel: () => 'low',
      on: (event: string, handler: (event: unknown, context: StatuslineContext) => void) => handlers.set(event, handler),
    });

    const refreshEvents = ['session_start', 'resources_discover', 'turn_start', 'turn_end', 'model_select', 'thinking_level_select'];
    expect([...handlers.keys()]).toEqual(refreshEvents);
    for (const event of refreshEvents) handlers.get(event)?.({}, ctx);
    expect(installed).toHaveLength(refreshEvents.length);
  });
});
