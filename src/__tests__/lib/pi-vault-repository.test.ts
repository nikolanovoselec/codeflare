import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ home: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const redirect = (path: any) => typeof path === 'string' && path.startsWith('/home/user/')
    ? join(paths.home, path.slice('/home/user/'.length)) : path;
  return {
    ...fs,
    existsSync: (path: any) => fs.existsSync(redirect(path)),
    readFileSync: (path: any, ...args: any[]) => Reflect.apply(fs.readFileSync, fs, [redirect(path), ...args]),
    writeFileSync: (path: any, ...args: any[]) => Reflect.apply(fs.writeFileSync, fs, [redirect(path), ...args]),
    mkdirSync: (path: any, ...args: any[]) => Reflect.apply(fs.mkdirSync, fs, [redirect(path), ...args]),
    realpathSync: (path: any, ...args: any[]) => Reflect.apply(fs.realpathSync, fs, [redirect(path), ...args]),
    readdirSync: (path: any, ...args: any[]) => Reflect.apply(fs.readdirSync, fs, [redirect(path), ...args]),
    statSync: (path: any, ...args: any[]) => Reflect.apply(fs.statSync, fs, [redirect(path), ...args]),
  };
});
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, execFileSync: () => 'fixture graph result' };
});

import registerRuntime from '../../../preseed/agents/pi/extensions/codeflare-pi';
import registerGraphTools from '../../../preseed/agents/pi/extensions/graphify-native';

let root: string;
let sentinel: string;
let vault: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-vault-repository-'));
  paths.home = root;
  vault = join(root, 'Vault');
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  mkdirSync(join(vault, 'graphify-out'));
  writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{"nodes":[]}');
  sentinel = join(root, '.cache', 'codeflare-hooks', 'graphify-active-cwd');
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, '/retained/previous-checkout\n');
  mkdirSync(join(root, '.graphify'));
  writeFileSync(join(root, '.graphify', 'global-graph.json'), '{"nodes":[]}');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  paths.home = '';
});

function runtime(notifications: string[] = []) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  registerRuntime({
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
  } as never);
  return async (cwd: string, eventName = 'tool_result') => {
    let result: any;
    for (const handler of handlers.get(eventName) ?? []) {
      result = await handler({ toolName: 'read', input: { path: join(cwd, 'note.md') }, systemPrompt: 'original' }, {
        sessionManager: { getCwd: () => cwd }, ui: { notify(message: string) { notifications.push(message); } },
      });
    }
    return result;
  };
}

async function query(cwd: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const tools = new Map<string, any>();
  registerGraphTools({ registerTool: (tool: any) => tools.set(tool.name, tool) });
  return tools.get('graphify_query').execute('query', { question: 'retained knowledge' }, undefined, undefined, {
    cwd, sessionManager: { getCwd: () => cwd },
  });
}

describe('REQ-VAULT-004 AC3: a Git-initialized Vault never becomes the active repository', () => {
  for (const marker of ['directory', 'worktree-file']) {
    it(`preserves the active sentinel and global query scope for a Vault with a ${marker}`, async () => {
      if (marker === 'directory') mkdirSync(join(vault, '.git'));
      else writeFileSync(join(vault, '.git'), 'gitdir: /unused/worktree\n');
      const before = readFileSync(sentinel, 'utf8');
      await runtime()(join(vault, 'Notes'));
      expect(readFileSync(sentinel, 'utf8')).toBe(before);
      const result = await query(join(vault, 'Notes'));
      expect(result.isError).not.toBe(true);
      expect(result.details.graph).toBe('/home/user/.graphify/global-graph.json');
    });
  }

  it('excludes a symlink alias of a Git-initialized Vault', async () => {
    mkdirSync(join(vault, '.git'));
    const alias = join(root, 'notes-alias');
    symlinkSync(vault, alias);
    const before = readFileSync(sentinel, 'utf8');
    await runtime()(join(alias, 'Notes'));
    expect(readFileSync(sentinel, 'utf8')).toBe(before);
    expect((await query(join(alias, 'Notes'))).details.graph).toBe('/home/user/.graphify/global-graph.json');
  });

  it('does not revive a Vault path from the retained sentinel', async () => {
    mkdirSync(join(vault, '.git'));
    writeFileSync(sentinel, `${vault}\n`);
    const outside = join(root, 'without-repository');
    mkdirSync(outside);
    expect((await query(outside)).details.graph).toBe('/home/user/.graphify/global-graph.json');
  });

  it('ignores a stale Vault sentinel during startup without rewriting it or advertising it as a repository', async () => {
    mkdirSync(join(vault, '.git'));
    writeFileSync(sentinel, `${vault}\n`);
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(sentinel, old, old);
    const before = readFileSync(sentinel);
    const mtime = statSync(sentinel).mtimeMs;
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const notices: string[] = [];
    const dispatch = runtime(notices);
    await dispatch(outside, 'session_start');
    const prompt = await dispatch(outside, 'before_agent_start');
    expect(readFileSync(sentinel)).toEqual(before);
    expect(statSync(sentinel).mtimeMs).toBe(mtime);
    expect(notices).toEqual([]);
    expect(prompt.systemPrompt).not.toContain('<codeflare_graphify>');
  });

  it('preserves ordinary nearest worktree selection and graph-output-only fallback', async () => {
    const repo = join(root, 'ordinary');
    mkdirSync(join(repo, 'nested'), { recursive: true });
    mkdirSync(join(repo, 'graphify-out'));
    writeFileSync(join(repo, '.git'), 'gitdir: /unused/worktree\n');
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{"nodes":[]}');
    await runtime()(join(repo, 'nested'));
    expect(readFileSync(sentinel, 'utf8')).toBe(`${repo}\n`);
    expect((await query(join(repo, 'nested'))).details.graph).toBe(join(repo, 'graphify-out', 'graph.json'));
    const bare = join(root, 'bare');
    mkdirSync(join(bare, 'graphify-out'), { recursive: true });
    writeFileSync(join(bare, 'graphify-out', 'graph.json'), '{"nodes":[]}');
    writeFileSync(sentinel, '');
    expect((await query(bare)).details.graph).toBe('/home/user/.graphify/global-graph.json');
    expect(existsSync(join(bare, '.git'))).toBe(false);
  });
});
