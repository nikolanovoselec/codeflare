import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('installs the supported override and fails closed before writing to an unsupported version', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpiv-todo-patch-'));
    roots.push(root);
    const packageRoot = join(root, 'node_modules/@juicesharp/rpiv-todo');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"version":"1.20.0"}\n', 'utf8');
    const payloadRoot = join(root, 'payload');
    const payloadFiles = ['index.ts', 'todo.ts', 'todo-overlay.ts', 'state/store.ts'];
    for (const relativePath of payloadFiles) {
      const payloadPath = join(payloadRoot, relativePath);
      mkdirSync(dirname(payloadPath), { recursive: true });
      writeFileSync(payloadPath, `payload:${relativePath}\n`, 'utf8');
    }

    installRpivTodoSessionIsolation(root, payloadRoot);

    for (const relativePath of payloadFiles) {
      expect(readFileSync(join(packageRoot, relativePath), 'utf8')).toBe(`payload:${relativePath}\n`);
    }

    const unsupportedRoot = mkdtempSync(join(tmpdir(), 'rpiv-todo-unsupported-'));
    roots.push(unsupportedRoot);
    const unsupportedPackage = join(unsupportedRoot, 'node_modules/@juicesharp/rpiv-todo');
    mkdirSync(unsupportedPackage, { recursive: true });
    writeFileSync(join(unsupportedPackage, 'package.json'), '{"version":"2.0.0"}\n', 'utf8');

    expect(() => installRpivTodoSessionIsolation(unsupportedRoot, payloadRoot)).toThrow(
      /expected @juicesharp\/rpiv-todo 1\.20\.0/,
    );
    expect(existsSync(join(unsupportedPackage, 'index.ts'))).toBe(false);
  });
});
