import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ activations: 0, deactivations: 0 }));

const host = vi.hoisted(() => ({
  commandHandler: undefined as (() => void) | undefined,
  messageHandler: undefined as ((message: unknown) => Promise<void>) | undefined,
  disposeHandler: undefined as (() => void) | undefined,
  created: 0,
  revealed: 0,
  executed: [] as Array<{ command: string; arguments: unknown[] }>,
  html: '',
  panel: undefined as { iconPath?: { fsPath: string } } | undefined,
}));

vi.mock('node:crypto', () => ({
  randomBytes: () => ({ toString: () => 'fixed-nonce-value' }),
}));

vi.mock('../src/extension-persistence.ts', () => ({
  activateExtensionPersistence: async () => {
    persistence.activations += 1;
    return async () => { persistence.deactivations += 1; };
  },
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
        // Built-in web extensions can receive the extension CDN source and the
        // generic webview source as one CSP source-list. The welcome owns no
        // external resources, so that host value must never leave the panel blank.
        cspSource: 'https://codeflare.example/extensions/codeflare-welcome/ vscode-webview://codeflare',
        get html() { return host.html; },
        set html(value: string) { host.html = value; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          host.messageHandler = handler;
          return { dispose() { host.messageHandler = undefined; } };
        },
      };
      const panel = {
        webview,
        iconPath: undefined as { fsPath: string } | undefined,
        reveal: () => { host.revealed += 1; },
        dispose: () => host.disposeHandler?.(),
        onDidDispose: (handler: () => void) => {
          host.disposeHandler = handler;
          return { dispose() {} };
        },
      };
      host.panel = panel;
      return panel;
    },
  },
}));

import { activate, deactivate } from '../src/welcome-extension.ts';

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
  host.panel = undefined;
  persistence.activations = 0;
  persistence.deactivations = 0;
});

test('REQ-IDE-016 AC3: welcome activation starts lazy extension persistence', () => {
  vi.useFakeTimers();
  const subscriptions: Array<{ dispose(): void }> = [];

  activate({ extensionUri: { fsPath: '/extension' }, subscriptions } as never);

  assert.equal(persistence.activations, 1);
  for (const subscription of subscriptions) subscription.dispose();
});

test('REQ-IDE-036 AC5: welcome deactivation flushes extension persistence', async () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ extensionUri: { fsPath: '/extension' }, subscriptions } as never);
  await deactivate();

  assert.equal(persistence.deactivations, 1);
  for (const subscription of subscriptions) subscription.dispose();
});

test('REQ-IDE-039 AC3: welcome panel uses the Codeflare brand icon', async () => {
  vi.useFakeTimers();
  process.env.CODEFLARE_SIDEBAR_AGENT = 'pi';
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ extensionUri: { fsPath: '/extension' }, subscriptions } as never);

  await vi.runOnlyPendingTimersAsync();
  assert.deepEqual(host.panel?.iconPath, { fsPath: '/extension/media/agent.svg' });
  for (const subscription of subscriptions) subscription.dispose();
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
