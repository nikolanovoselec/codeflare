import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  commandHandler: undefined as (() => void) | undefined,
  messageHandler: undefined as ((message: unknown) => Promise<void>) | undefined,
  disposeHandler: undefined as (() => void) | undefined,
  created: 0,
  revealed: 0,
  executed: [] as Array<{ command: string; arguments: unknown[] }>,
  html: '',
}));

vi.mock('node:crypto', () => ({
  randomBytes: () => ({ toString: () => 'fixed-nonce-value' }),
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
    }),
  },
  commands: {
    registerCommand: (_id: string, handler: () => void) => {
      host.commandHandler = handler;
      return { dispose() {} };
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
      host.executed.push({ command, arguments: args });
    },
  },
  window: {
    createWebviewPanel: () => {
      host.created += 1;
      const webview = {
        cspSource: 'vscode-webview://codeflare',
        get html() { return host.html; },
        set html(value: string) { host.html = value; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          host.messageHandler = handler;
          return { dispose() { host.messageHandler = undefined; } };
        },
      };
      return {
        webview,
        reveal: () => { host.revealed += 1; },
        dispose: () => host.disposeHandler?.(),
        onDidDispose: (handler: () => void) => {
          host.disposeHandler = handler;
          return { dispose() {} };
        },
      };
    },
  },
}));

import { activate } from '../src/welcome-extension.ts';

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CODEFLARE_SIDEBAR_AGENT;
  host.commandHandler = undefined;
  host.messageHandler = undefined;
  host.disposeHandler = undefined;
  host.created = 0;
  host.revealed = 0;
  host.executed = [];
  host.html = '';
});

test('REQ-IDE-024 AC1+AC4: every inventory opens one welcome editor with its fixed primary action', async () => {
  vi.useFakeTimers();
  const cases = [
    {
      kind: 'pi',
      command: 'workbench.action.chat.open',
      arguments: [{ query: '@codeflare ', isPartialQuery: true }],
    },
    { kind: 'claude', command: 'claude-vscode.sidebar.open', arguments: [] },
    { kind: 'none', command: 'workbench.view.explorer', arguments: [] },
  ];

  for (const expected of cases) {
    process.env.CODEFLARE_SIDEBAR_AGENT = expected.kind;
    const subscriptions: Array<{ dispose(): void }> = [];
    activate({ extensionUri: { fsPath: '/extension' }, subscriptions } as never);

    assert.equal(host.created, 0);
    await vi.runOnlyPendingTimersAsync();
    assert.equal(host.created, 1);
    assert.match(host.html, /Codeflare/);
    const handleMessage = host.messageHandler;
    assert.ok(handleMessage);

    await handleMessage({ type: 'ignored' });
    assert.deepEqual(host.executed, []);
    await handleMessage({ type: 'primary' });
    assert.deepEqual(host.executed, [{
      command: expected.command,
      arguments: expected.arguments,
    }]);

    host.commandHandler?.();
    assert.equal(host.created, 1);
    assert.equal(host.revealed, 1);
    for (const subscription of subscriptions) subscription.dispose();
    host.commandHandler = undefined;
    host.messageHandler = undefined;
    host.disposeHandler = undefined;
    host.created = 0;
    host.revealed = 0;
    host.executed = [];
    host.html = '';
  }
});
