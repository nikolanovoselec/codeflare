import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = '/home/user/.cache/codeflare-hooks/graphify-active-cwd';
const ACTIVE_REPO_KEY = Symbol.for('codeflare.activeRepo');
const filesystem = vi.hoisted(() => ({ sentinel: '' }));
// Only the platform-owned fixed sentinel path is redirected to a real temp file.
// No fake Git responses, SDK width helpers or native footer implementations.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const mapped = (path: unknown) => String(path) === SENTINEL ? filesystem.sentinel : path;
  return { ...actual,
    readFileSync: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.readFileSync, actual, [mapped(path), ...args]),
    writeFileSync: (path: unknown, ...args: unknown[]) => Reflect.apply(actual.writeFileSync, actual, [mapped(path), ...args]),
  };
});
import { rememberActiveRepo } from '../../../preseed/agents/pi/extensions/active-repo-memory';
import localStatuslineExtension from '../../../preseed/agents/pi/extensions/local-statusline';

type Context = {
  mode: 'tui' | 'rpc'; hasUI: boolean; cwd: string;
  model?: { id: string; provider?: string; name?: string };
  sessionManager: { getCwd(): string };
  getContextUsage(): { percent?: number | null; tokens?: number | null; contextWindow?: number } | undefined;
  ui: { setStatus(key: string, value: string | undefined): void; setFooter(): never };
};
let root: string;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'status-producer-'));
  filesystem.sentinel = join(root, 'sentinel');
  delete (globalThis as any)[ACTIVE_REPO_KEY];
});
afterEach(() => {
  delete (globalThis as any)[ACTIVE_REPO_KEY];
  vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});
function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}
function repository(name: string, committed = false) {
  const repo = join(root, name); mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'topic');
  if (committed) git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  return repo;
}
function producer({ cwd = root, sessionCwd = cwd, mode = 'tui', usage }: {
  cwd?: string; sessionCwd?: string; mode?: 'tui' | 'rpc';
  usage?: ReturnType<Context['getContextUsage']>;
} = {}) {
  const statuses = new Map([['review', 'Review retained']]);
  const handlers = new Map<string, Array<(event: any, ctx: Context) => unknown>>();
  let effort = 'off';
  const ctx: Context = { mode, hasUI: true, cwd,
    model: { id: 'ordinary', provider: 'fixture' }, sessionManager: { getCwd: () => sessionCwd },
    getContextUsage: () => usage,
    ui: { setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      setFooter() { throw new Error('the status producer must not replace the native footer'); } },
  };
  localStatuslineExtension({ getThinkingLevel: () => effort,
    on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
  } as any);
  async function emit(type: string, extra = {}, context = ctx) {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...extra }, context);
  }
  return { ctx, statuses, emit, effort(value: string) { effort = value; },
    text: () => statuses.get('codeflare-session') ?? '' };
}

describe('REQ-AGENT-056: compact public status producer', () => {
  it('REQ-AGENT-056 AC2: preserves known, calculated and unknown context plus model and explicit off effort', async () => {
    const f = producer({ usage: { percent: 37, tokens: 20, contextWindow: 40 } });
    await f.emit('session_start'); expect(f.text()).toContain('37% | ordinary:off');
    f.ctx.getContextUsage = () => ({ tokens: 20, contextWindow: 40 });
    await f.emit('turn_end'); expect(f.text()).toContain('50% | ordinary:off');
    for (const usage of [undefined, { tokens: null, contextWindow: 40 }, { percent: NaN }, { tokens: 1, contextWindow: 0 }]) {
      f.ctx.getContextUsage = () => usage;
      await f.emit('turn_end'); expect(f.text()).toContain('--% | ordinary:off');
    }
    f.ctx.getContextUsage = () => { throw new Error('metadata unavailable'); };
    await f.emit('turn_end'); expect(f.text()).toContain('--% | ordinary:off');
    expect(f.statuses.get('review')).toBe('Review retained');
    await f.emit('session_shutdown', { reason: 'quit' });
  });

  it('REQ-AGENT-056 AC3: resolves session then context repository before remembered fallback, including detached and unborn heads', async () => {
    const sessionRepo = repository('session', true); const contextRepo = repository('context');
    const remembered = repository('remembered'); rememberActiveRepo(remembered);
    const f = producer({ sessionCwd: sessionRepo, cwd: contextRepo });
    await f.emit('session_start'); expect(f.text()).toContain('session:topic');
    git(sessionRepo, 'checkout', '--detach'); const short = git(sessionRepo, 'rev-parse', '--short', 'HEAD');
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.text()).toContain(`session:${short}`);
    f.ctx.sessionManager.getCwd = () => root;
    await f.emit('resources_discover', { reason: 'reload', cwd: root });
    expect(f.text()).toContain('context:topic'); // Valid unborn repository.
    f.ctx.cwd = root;
    await f.emit('tool_execution_end', { toolCallId: 'done', toolName: 'bash', result: {}, isError: false });
    expect(f.text()).toContain('remembered:topic');
    await f.emit('session_shutdown', { reason: 'quit' });
  });

  it('REQ-AGENT-056 AC4: sentinel fallback accepts only in-root Git repos and never changes sentinel data', async () => {
    const sessionRoot = join(root, 'workspace'); mkdirSync(sessionRoot);
    const inside = repository('workspace/inside'); const sibling = repository('workspace-other');
    const nonGit = join(sessionRoot, 'not-git'); mkdirSync(nonGit);
    const f = producer({ cwd: sessionRoot });
    for (const value of [inside, sibling, root, nonGit, join(root, 'missing'), '']) {
      writeFileSync(filesystem.sentinel, `${value}\n`);
      const before = readFileSync(filesystem.sentinel);
      await f.emit('session_start', { reason: 'startup' });
      if (value === inside) expect(f.text()).toContain(`${basename(inside)}:topic`);
      else expect(f.text()).toBe('--% | ordinary:off');
      expect(readFileSync(filesystem.sentinel)).toEqual(before);
      await f.emit('session_shutdown', { reason: 'new' });
    }
  });

  it('REQ-AGENT-056 AC7: session/resource/turn/model/effort and TTL refresh visible facts, then replacement/shutdown fence stale contexts', async () => {
    const repo = repository('active');
    const f = producer({ cwd: repo });
    await f.emit('session_start'); expect(f.text()).toContain('ordinary:off | active:topic');
    for (const type of ['resources_discover', 'turn_start', 'turn_end', 'model_select', 'thinking_level_select']) {
      f.ctx.model = { id: type }; f.effort('high');
      await f.emit(type); expect(f.text()).toContain(`${type}:high`);
    }
    git(repo, 'checkout', '-b', 'fresh');
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.text()).toContain('active:fresh');
    // A replacement context must not be overwritten by an earlier interval.
    const replacement = { ...f.ctx, model: { id: 'replacement' } };
    f.ctx.model = { id: 'old-context' };
    // Exercise the public session lifecycle, not private cache/registration state.
    await f.emit('session_shutdown', { reason: 'new' });
    await f.emit('session_start', { reason: 'new' }, replacement);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.text()).toContain('replacement:high');
    await f.emit('session_shutdown', { reason: 'quit' }, replacement);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.statuses.has('codeflare-session')).toBe(false);
    expect(f.statuses.get('review')).toBe('Review retained');
  });
});
