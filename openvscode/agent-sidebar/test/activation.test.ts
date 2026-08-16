import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  activeEditorUri: undefined as { fsPath: string; scheme: string } | undefined,
  activeEditor: undefined as Record<string, unknown> | undefined,
  commandHandler: undefined as ((resource?: unknown) => Promise<void>) | undefined,
  commandId: undefined as string | undefined,
  executedCommand: undefined as { id: string; options: Record<string, unknown> } | undefined,
  contextValues: [] as Array<{ key: string; value: unknown }>,
  participantId: undefined as string | undefined,
  participantHandler: undefined as ((request: unknown, context: unknown, response: unknown, cancellation: unknown) => Promise<unknown>) | undefined,
  modelProviders: new Map<string, Record<string, (...args: unknown[]) => unknown>>(),
  modelChanges: [] as Array<{ vendor: string; contextValues: Array<{ key: string; value: unknown }> }>,
  warnings: [] as string[],
  informationMessages: [] as Array<{ message: string; items: string[] }>,
  informationChoice: undefined as string | undefined,
  informationPromise: undefined as Promise<string | undefined> | undefined,
}));

const nativeChat = vi.hoisted(() => ({
  runNativePiChat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => path.endsWith('/symlink.ts') ? '/etc/hosts' : path,
  };
});

vi.mock('../src/pi/native-chat.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/native-chat.ts')>();
  return {
    ...actual,
    runNativePiChat: nativeChat.runNativePiChat,
  };
});

vi.mock('vscode', () => ({
  EventEmitter: class EventEmitter {
    private readonly listeners: Array<() => void> = [];
    readonly event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
    fire() {
      for (const listener of this.listeners) listener();
    }
    dispose() {
      this.listeners.length = 0;
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  Range: class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  TextEdit: {
    replace: (range: unknown, newText: string) => ({ range, newText }),
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
    createChatParticipant: (
      id: string,
      handler: (request: unknown, context: unknown, response: unknown, cancellation: unknown) => Promise<unknown>,
    ) => {
      host.participantId = id;
      host.participantHandler = handler;
      return { dispose() {} };
    },
  },
  languages: { getDiagnostics: () => [] },
  lm: {
    registerLanguageModelChatProvider: (vendor: string, provider: Record<string, (...args: unknown[]) => unknown>) => {
      host.modelProviders.set(vendor, provider);
      provider.onDidChangeLanguageModelChatInformation?.(() => host.modelChanges.push({
        vendor,
        contextValues: [...host.contextValues],
      }));
      return { dispose() {} };
    },
  },
  window: {
    get activeTextEditor() {
      return host.activeEditor ?? (host.activeEditorUri ? { document: { uri: host.activeEditorUri } } : undefined);
    },
    showWarningMessage: async (message: string) => { host.warnings.push(message); },
    showInformationMessage: async (message: string, ...items: string[]) => {
      host.informationMessages.push({ message, items });
      return host.informationPromise ?? host.informationChoice;
    },
    showTextDocument: async () => undefined,
  },
  workspace: {
    getWorkspaceFolder: (resource: { fsPath: string }) => resource.fsPath.startsWith('/home/user/workspace/') ? {} : undefined,
    textDocuments: [],
    openTextDocument: async () => ({}),
  },
}));

import { activate, deactivate } from '../src/extension.ts';

function installActiveEditor(content = 'const oldValue = 1;\nreturn oldValue;\n'): {
  uri: { scheme: string; fsPath: string };
  version: number;
} {
  const uri = { scheme: 'file', fsPath: '/home/user/workspace/src/inline.ts' };
  const lines = content.split('\n');
  const document = {
    uri,
    version: 7,
    lineCount: lines.length,
    languageId: 'typescript',
    isDirty: true,
    isClosed: false,
    getText: () => content,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  };
  host.activeEditor = {
    document,
    selection: {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: lines[0]?.length ?? 0 },
    },
  };
  return { uri, version: document.version };
}

afterEach(async () => {
  await deactivate();
  host.activeEditorUri = undefined;
  host.activeEditor = undefined;
  host.commandHandler = undefined;
  host.commandId = undefined;
  host.executedCommand = undefined;
  host.contextValues = [];
  host.participantId = undefined;
  host.participantHandler = undefined;
  host.modelProviders.clear();
  host.modelChanges = [];
  nativeChat.runNativePiChat.mockReset();
  host.warnings = [];
  host.informationMessages = [];
  host.informationChoice = undefined;
  host.informationPromise = undefined;
});

test('REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5: native Pi registers account-free panel and editor Chat', async () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions,
  } as never);

  assert.equal(host.participantId, 'codeflare.pi');
  assert.deepEqual(host.contextValues, [
    { key: 'chatSetupHidden', value: true },
    { key: 'chatSetupCompleted', value: true },
  ]);
  assert.deepEqual([...host.modelProviders.keys()], ['copilot', 'codeflare']);
  assert.deepEqual(host.modelChanges, [
    { vendor: 'copilot', contextValues: host.contextValues },
    { vendor: 'codeflare', contextValues: host.contextValues },
  ]);
  const fallbackProvider = host.modelProviders.get('copilot');
  const visibleProvider = host.modelProviders.get('codeflare');
  assert.ok(fallbackProvider);
  assert.ok(visibleProvider);

  const fallbackModels = await fallbackProvider.provideLanguageModelChatInformation() as Array<Record<string, unknown>>;
  assert.equal(fallbackModels.length, 1);
  assert.equal(fallbackModels[0]?.id, 'host-compatibility');
  assert.equal(fallbackModels[0]?.name, 'Codeflare');
  assert.deepEqual(fallbackModels[0]?.isDefault, { 1: true });
  assert.equal(fallbackModels[0]?.isUserSelectable, false);
  assert.deepEqual(fallbackModels[0]?.capabilities, {});
  assert.equal(fallbackModels[0]?.requiresAuthorization, undefined);

  const visibleModels = await visibleProvider.provideLanguageModelChatInformation() as Array<Record<string, unknown>>;
  assert.equal(visibleModels.length, 1);
  assert.equal(visibleModels[0]?.id, 'host-visible');
  assert.equal(visibleModels[0]?.name, 'Codeflare');
  assert.deepEqual(visibleModels[0]?.isDefault, { 1: true, 4: true });
  assert.equal(visibleModels[0]?.isUserSelectable, true);
  assert.deepEqual(visibleModels[0]?.capabilities, { toolCalling: true });
  assert.equal(visibleModels[0]?.requiresAuthorization, undefined);

  for (const provider of [fallbackProvider, visibleProvider]) {
    await assert.rejects(
      provider.provideLanguageModelChatResponse() as Promise<void>,
      /compatibility.*cannot generate/i,
    );
    assert.equal(await provider.provideTokenCount(), 0);
  }
  assert.equal(subscriptions.length, 6);
});

test('REQ-IDE-025 AC1: participant requests run the local Pi backend without provider generation', async () => {
  nativeChat.runNativePiChat.mockImplementationOnce(async (options: { backend: unknown }) => {
    assert.equal((options.backend as { constructor: { name: string } }).constructor.name, 'PiRpcBackend');
    return 'completed';
  });
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.participantHandler);
  await host.participantHandler(
    { location: 1, prompt: 'Refactor this selection', references: [] },
    { history: [] },
    { markdown() {}, progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
  );

  assert.equal(nativeChat.runNativePiChat.mock.calls.length, 1);
});

test('REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029: inline-first renders one host-owned edit with native feedback', async () => {
  const target = installActiveEditor();
  host.informationChoice = 'Keep';
  const rendered: Array<{ uri: unknown; edits: unknown }> = [];
  const progress: string[] = [];
  const reasoning: unknown[] = [];
  nativeChat.runNativePiChat.mockImplementation(async (options: {
    mode: string;
    input: { prompt: string };
    response: { progress(value: string): void; thinking?(value: string): void; textEdit(edits: unknown[]): void };
  }) => {
    assert.equal(options.mode, 'inline-edit');
    assert.equal(options.input.prompt, 'inline first');
    options.response.progress('Preparing native editor changes…');
    options.response.thinking?.('Preparing a bounded change.');
    options.response.textEdit([{
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 19,
      newText: 'const generated = 42;',
    }]);
    return 'completed';
  });
  await activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as never);

  assert.ok(host.participantHandler);
  const response = {
    markdown: () => assert.fail('native inline edit emitted hidden markdown'),
    progress: (value: string) => progress.push(value),
    thinkingProgress: (value: unknown) => reasoning.push(value),
    textEdit: (uri: unknown, edits: unknown) => rendered.push({ uri, edits }),
  };
  const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const invoke = () => host.participantHandler?.(
    { location: 4, prompt: 'inline first', references: [] },
    { history: [] },
    response,
    cancellation,
  );
  const result = await invoke();

  assert.equal(nativeChat.runNativePiChat.mock.calls.length, 1);
  assert.equal(progress.length, 2);
  assert.ok(progress[0]);
  assert.deepEqual(reasoning, [{ id: 'codeflare-pi-inline-reasoning', text: 'Preparing a bounded change.' }]);
  assert.deepEqual(result, {
    details: 'Codeflare prepared 1 proposed edit. Use Keep or Undo to review it.',
    metadata: {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(host.informationMessages, [{
    message: 'Codeflare prepared 1 proposed edit. Use Keep or Undo to review it.',
    items: ['Keep', 'Undo'],
  }]);
  assert.deepEqual(host.executedCommand, { id: 'chatEditing.acceptFile', options: target.uri });
  assert.equal(rendered.length, 2);
  assert.equal(rendered[0]?.uri, target.uri);
  const renderedEdits = rendered[0]?.edits as Array<{
    range: { start: unknown; end: unknown };
    newText: string;
  }>;
  assert.deepEqual(renderedEdits.map((edit) => ({
    start: edit.range.start,
    end: edit.range.end,
    newText: edit.newText,
  })), [{
    start: { line: 0, character: 0 },
    end: { line: 0, character: 19 },
    newText: 'const generated = 42;',
  }]);
  assert.deepEqual(rendered[1], { uri: target.uri, edits: true });

  host.executedCommand = undefined;
  host.informationChoice = 'Undo';
  await invoke();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(host.executedCommand, { id: 'chatEditing.discardFile', options: target.uri });

  host.executedCommand = undefined;
  host.informationChoice = undefined;
  host.informationPromise = new Promise<string | undefined>(() => undefined);
  const nonBlockingResult = await invoke();
  assert.deepEqual(nonBlockingResult, {
    details: 'Codeflare prepared 1 proposed edit. Use Keep or Undo to review it.',
    metadata: {},
  });
  assert.equal(host.executedCommand, undefined);

  host.informationPromise = undefined;
  const dismissedResult = await invoke();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(dismissedResult, nonBlockingResult);
  assert.equal(host.executedCommand, undefined);
});

test('REQ-IDE-025: panel-first then native inline edit reuses one unrestricted IDE Pi conversation', async () => {
  installActiveEditor();
  const backends: unknown[] = [];
  const modes: string[] = [];
  const answers: string[] = [];
  const reasoning: unknown[] = [];
  const inlineEdits: unknown[] = [];
  nativeChat.runNativePiChat.mockImplementation(async (options: {
    mode: string;
    input: { prompt: string };
    response: { markdown(value: string): void; thinking?(value: string): void; textEdit?(edits: unknown[]): void };
    backend: unknown;
  }) => {
    backends.push(options.backend);
    modes.push(options.mode);
    if (options.mode === 'inline-edit') {
      options.response.textEdit?.([{
        startLine: 1,
        startCharacter: 0,
        endLine: 1,
        endCharacter: 16,
        newText: 'return generated;',
      }]);
    } else {
      options.response.thinking?.('Checking the selected architecture.');
      options.response.markdown(`answer:${options.input.prompt}`);
    }
    return 'completed';
  });
  await activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as never);

  assert.ok(host.participantHandler);
  const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  await host.participantHandler(
    { location: 1, prompt: 'panel first', references: [] },
    { history: [] },
    {
      markdown: (value: string) => answers.push(value),
      progress() {},
      thinkingProgress: (value: unknown) => reasoning.push(value),
    },
    cancellation,
  );
  await host.participantHandler(
    { location: 4, prompt: 'inline follow-up', references: [] },
    { history: [] },
    {
      markdown: () => assert.fail('native inline edit emitted hidden markdown'),
      progress() {},
      textEdit: (_uri: unknown, edits: unknown) => inlineEdits.push(edits),
    },
    cancellation,
  );

  assert.deepEqual(modes, ['chat', 'inline-edit']);
  assert.deepEqual(answers, ['answer:panel first']);
  assert.deepEqual(reasoning, [{ id: 'codeflare-pi-reasoning', text: 'Checking the selected architecture.' }]);
  assert.equal(inlineEdits.length, 2);
  assert.equal(inlineEdits[1], true);
  assert.equal(backends.length, 2);
  assert.equal(backends[0], backends[1]);
});

test('REQ-IDE-011 AC2+AC3: explorer review attaches one file and submits Codeflare ask mode', async () => {
  await activate({
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
  await activate({
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
  await activate({
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
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.commandHandler);
  await host.commandHandler({ fsPath: '/tmp/outside.ts', scheme: 'file' });

  assert.equal(host.executedCommand, undefined);
  assert.equal(host.warnings.length, 1);
});

test('REQ-IDE-011 AC5: explorer review rejects a symlink alias before opening native Chat', async () => {
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.commandHandler);
  await host.commandHandler({ fsPath: '/home/user/workspace/symlink.ts', scheme: 'file' });

  assert.equal(host.executedCommand, undefined);
  assert.equal(host.warnings.length, 1);
});
