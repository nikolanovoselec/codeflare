import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  participantId: undefined as string | undefined,
  modelVendor: undefined as string | undefined,
  modelProvider: undefined as Record<string, (...args: never[]) => unknown> | undefined,
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
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
    showWarningMessage: async () => undefined,
    showTextDocument: async () => undefined,
  },
  workspace: { textDocuments: [], openTextDocument: async () => ({}) },
}));

import { activate, deactivate } from '../src/extension.ts';

afterEach(async () => {
  await deactivate();
  host.participantId = undefined;
  host.modelVendor = undefined;
  host.modelProvider = undefined;
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
  assert.equal(subscriptions.length, 3);
});
