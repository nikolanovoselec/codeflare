import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  activeEditorUri: undefined as { fsPath: string; scheme: string } | undefined,
  commandHandler: undefined as ((resource?: unknown) => Promise<void>) | undefined,
  commandId: undefined as string | undefined,
  executedCommand: undefined as { id: string; options: Record<string, unknown> } | undefined,
  contextValues: [] as Array<{ key: string; value: unknown }>,
  participantId: undefined as string | undefined,
  modelVendor: undefined as string | undefined,
  modelProvider: undefined as Record<string, (...args: never[]) => unknown> | undefined,
  warnings: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => path.endsWith('/symlink.ts') ? '/etc/hosts' : path,
  };
});

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  commands: {
    executeCommand: async (id: string, ...args: unknown[]) => {
      if (id === 'setContext') {
        host.contextValues.push({ key: String(args[0]), value: args[1] });
        return;
      }
      host.executedCommand = { id, options: args[0] as Record<string, unknown> };
    },
    registerCommand: (id: string, handler: (resource?: unknown) => Promise<void>) => {
      host.commandId = id;
      host.commandHandler = handler;
      return { dispose() {} };
    },
  },
  chat: {
    createChatParticipant: (id: string) => {
      host.participantId = id;
      return { dispose() {} };
    },
  },
  languages: { getDiagnostics: () => [] },
  lm: {
    registerLanguageModelChatProvider: (vendor: string, provider: Record<string, (...args: never[]) => unknown>) => {
      host.modelVendor = vendor;
      host.modelProvider = provider;
      return { dispose() {} };
    },
  },
  window: {
    get activeTextEditor() {
      return host.activeEditorUri ? { document: { uri: host.activeEditorUri } } : undefined;
    },
    showWarningMessage: async (message: string) => { host.warnings.push(message); },
    showTextDocument: async () => undefined,
  },
  workspace: {
    getWorkspaceFolder: (resource: { fsPath: string }) => resource.fsPath.startsWith('/home/user/workspace/') ? {} : undefined,
    textDocuments: [],
    openTextDocument: async () => ({}),
  },
}));

import { activate, deactivate } from '../src/extension.ts';

afterEach(async () => {
  await deactivate();
  host.activeEditorUri = undefined;
  host.commandHandler = undefined;
  host.commandId = undefined;
  host.executedCommand = undefined;
  host.contextValues = [];
  host.participantId = undefined;
  host.modelVendor = undefined;
  host.modelProvider = undefined;
  host.warnings = [];
});

test('REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC3: native Pi registers account-free panel and editor Chat', async () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions,
  } as never);

  assert.equal(host.participantId, 'codeflare.pi');
  assert.deepEqual(host.contextValues, [{ key: 'chatSetupCompleted', value: true }]);
  assert.equal(host.modelVendor, 'copilot');
  const provider = host.modelProvider;
  assert.ok(provider);
  const models = await provider.provideLanguageModelChatInformation() as Array<Record<string, unknown>>;
  assert.equal(models.length, 1);
  assert.equal(models[0]?.name, 'Codeflare');
  assert.deepEqual(models[0]?.isDefault, { 1: true, 4: true });
  assert.equal(models[0]?.isUserSelectable, true);
  assert.deepEqual(models[0]?.capabilities, { toolCalling: true });
  assert.equal(models[0]?.requiresAuthorization, undefined);
  await assert.rejects(
    provider.provideLanguageModelChatResponse() as Promise<void>,
    /compatibility.*cannot generate/i,
  );
  assert.equal(await provider.provideTokenCount(), 0);
  assert.equal(subscriptions.length, 4);
});

test('REQ-IDE-011 AC2+AC3: explorer review attaches one file and submits Codeflare ask mode', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  const resource = { fsPath: '/home/user/workspace/src/app.ts', scheme: 'file' };
  assert.equal(host.commandId, 'codeflare.pi.reviewFile');
  assert.ok(host.commandHandler);
  await host.commandHandler(resource);

  assert.equal(host.executedCommand?.id, 'workbench.action.chat.open');
  assert.deepEqual(host.executedCommand?.options.attachFiles, [resource]);
  assert.match(String(host.executedCommand?.options.query), /^@codeflare\b/);
  assert.equal(host.executedCommand?.options.mode, 'ask');
  assert.equal(host.executedCommand?.options.isPartialQuery, undefined);
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-014 AC3+AC4: editor review attaches the active file and submits Codeflare ask mode', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  host.activeEditorUri = { fsPath: '/home/user/workspace/src/editor.ts', scheme: 'file' };
  assert.ok(host.commandHandler);
  await host.commandHandler();

  assert.equal(host.executedCommand?.id, 'workbench.action.chat.open');
  assert.deepEqual(host.executedCommand?.options.attachFiles, [host.activeEditorUri]);
  assert.match(String(host.executedCommand?.options.query), /^@codeflare\b/);
  assert.equal(host.executedCommand?.options.mode, 'ask');
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-014 AC2: editor review ignores a malformed command argument and uses the active file', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  host.activeEditorUri = { fsPath: '/home/user/workspace/src/editor.ts', scheme: 'file' };
  assert.ok(host.commandHandler);
  await host.commandHandler({ unexpected: true });

  assert.deepEqual(host.executedCommand?.options.attachFiles, [host.activeEditorUri]);
  assert.equal(host.executedCommand?.options.mode, 'ask');
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-011 AC4: explorer review rejects resources outside the workspace', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.commandHandler);
  await host.commandHandler({ fsPath: '/tmp/outside.ts', scheme: 'file' });

  assert.equal(host.executedCommand, undefined);
  assert.equal(host.warnings.length, 1);
});

test('REQ-IDE-011 AC5: explorer review rejects a symlink alias before opening native Chat', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.commandHandler);
  await host.commandHandler({ fsPath: '/home/user/workspace/symlink.ts', scheme: 'file' });

  assert.equal(host.executedCommand, undefined);
  assert.equal(host.warnings.length, 1);
});
