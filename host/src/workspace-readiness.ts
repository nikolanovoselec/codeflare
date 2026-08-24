import http from 'node:http';
import type { ProxyTarget } from './request-router.js';

export type SessionWorkspace = 'terminal' | 'vscode';

export const EDITOR_WARMING_BUDGET_MS = 120000;
const EDITOR_READINESS_POLL_MS = 250;
const EDITOR_PROBE_PATH = '/healthz';

export function resolveSessionWorkspace(value: string | undefined): SessionWorkspace {
  return value === 'vscode' ? 'vscode' : 'terminal';
}

export function shouldPrewarmTerminal(workspace: SessionWorkspace): boolean {
  return workspace === 'terminal';
}

export async function startWorkspaceServices<T>(
  workspace: SessionWorkspace,
  actions: {
    createTerminalSession(): T;
    insertTerminalSession(session: T): void;
    startTerminalSession(session: T): void;
    beginEditorProbe(): void;
    waitForEditor(): Promise<boolean>;
  },
): Promise<{ kind: 'terminal'; session: T } | { kind: 'vscode'; ready: boolean }> {
  if (workspace === 'vscode') {
    actions.beginEditorProbe();
    return { kind: 'vscode', ready: await actions.waitForEditor() };
  }

  const session = actions.createTerminalSession();
  actions.insertTerminalSession(session);
  actions.startTerminalSession(session);
  return { kind: 'terminal', session };
}

function probeEditor(target: ProxyTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const request = http.request({
      host: target.host,
      port: target.port,
      path: EDITOR_PROBE_PATH,
      method: 'GET',
    }, (response) => {
      response.resume();
      finish(response.statusCode === 200);
    });
    const timer = setTimeout(() => {
      finish(false);
      request.destroy();
    }, timeoutMs);
    request.once('error', () => finish(false));
    request.end();
  });
}

export async function waitForEditorReady(
  target: ProxyTarget,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? EDITOR_WARMING_BUDGET_MS;
  const pollMs = options.pollMs ?? EDITOR_READINESS_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (await probeEditor(target, remainingMs)) return true;

    const delayMs = Math.min(pollMs, deadline - Date.now());
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}
