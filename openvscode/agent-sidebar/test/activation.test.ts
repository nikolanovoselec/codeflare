import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  commandHandler: undefined as ((resource?: { fsPath: string; scheme: string }) => Promise<void>) | undefined,
  commandId: undefined as string | undefined,
  executedCommand: undefined as { id: string; options: Record<string, unknown> } | undefined,
  participantId: undefined as string | undefined,
  modelVendor: undefined as string | undefined,
  modelProvider: undefined as Record<string, (...args: never[]) => unknown> | undefined,
  warnings: [] as string[],
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  commands: {
    executeCommand: async (id: string, options: Record<string, unknown>) => {
      host.executedCommand = { id, options };
    },
    registerCommand: (id: string, handler: (resource?: { fsPath: string; scheme: string }) => Promise<void>) => {
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
    activeTextEditor: undefined,
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
  host.commandHandler = undefined;
  host.commandId = undefined;
  host.executedCommand = undefined;
  host.participantId = undefined;
  host.modelVendor = undefined;
  host.modelProvider = undefined;
  host.warnings = [];
});

test('REQ-IDE-005 AC5: native Pi registers an account-free panel model that rejects generation', async () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions,
  } as never);

  assert.equal(host.participantId, 'codeflare.pi');
  assert.equal(host.modelVendor, 'copilot');
  const provider = host.modelProvider;
  assert.ok(provider);
  const models = await provider.provideLanguageModelChatInformation() as Array<Record<string, unknown>>;
  assert.equal(models.length, 1);
  assert.deepEqual(models[0]?.isDefault, { 1: true });
  assert.equal(models[0]?.isUserSelectable, false);
  assert.equal(models[0]?.requiresAuthorization, undefined);
  await assert.rejects(
    provider.provideLanguageModelChatResponse() as Promise<void>,
    /compatibility.*cannot generate/i,
  );
  assert.equal(await provider.provideTokenCount(), 0);
  assert.equal(subscriptions.length, 4);
});

test('REQ-IDE-005 AC8: explorer review attaches one workspace file to Codeflare Pi native Chat', async () => {
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
  assert.equal(host.executedCommand?.options.isPartialQuery, undefined);
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-005 AC8: explorer review rejects resources outside the workspace', async () => {
  activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.commandHandler);
  await host.commandHandler({ fsPath: '/tmp/outside.ts', scheme: 'file' });

  assert.equal(host.executedCommand, undefined);
  assert.equal(host.warnings.length, 1);
});
