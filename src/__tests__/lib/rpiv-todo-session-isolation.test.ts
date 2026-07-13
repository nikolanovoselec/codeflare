import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installRpivTodoSessionIsolation } from '../../../preseed/agents/pi/npm/rpiv-todo-session-isolation/install.mjs';
import {
  __resetState,
  commitState,
  evictSession,
  getRenderState,
  getState,
  replaceState,
  setActiveRenderSession,
} from '../../../preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store';

const roots: string[] = [];

function taskState(subject: string) {
  return {
    nextId: 2,
    tasks: [{ id: 1, subject, description: subject, status: 'pending', blockedBy: [], owner: '', metadata: {} }],
  } as never;
}

afterEach(() => {
  __resetState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('REQ-AGENT-081: rpiv-todo session isolation patch', () => {
  it('keeps foreground tasks intact when a child session replays, mutates, and shuts down', () => {
    replaceState('foreground', taskState('foreground task'));
    setActiveRenderSession('foreground');

    replaceState('child', taskState('child task'));
    commitState('child', { tasks: [], nextId: 2 });
    evictSession('child');

    expect(getState('foreground').tasks.map((task) => task.subject)).toEqual(['foreground task']);
    expect(getRenderState().tasks.map((task) => task.subject)).toEqual(['foreground task']);
  });

  it('installs the pinned override files and refuses an unknown package version', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpiv-todo-patch-'));
    roots.push(root);
    const packageRoot = join(root, 'node_modules/@juicesharp/rpiv-todo');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"version":"1.20.0"}\n', 'utf8');

    installRpivTodoSessionIsolation(root);

    for (const relativePath of ['index.ts', 'todo.ts', 'todo-overlay.ts', 'state/store.ts']) {
      const installed = readFileSync(join(packageRoot, relativePath), 'utf8');
      const payload = readFileSync(
        join(process.cwd(), 'preseed/agents/pi/npm/rpiv-todo-session-isolation', relativePath),
        'utf8',
      );
      expect(installed).toBe(payload);
    }

    writeFileSync(join(packageRoot, 'package.json'), '{"version":"2.0.0"}\n', 'utf8');
    expect(() => installRpivTodoSessionIsolation(root)).toThrow(/expected @juicesharp\/rpiv-todo 1\.20\.0/);
  });
});
