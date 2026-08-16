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
  confirmations: [] as Array<{ title: string; message: string; data: unknown; buttons: string[] }>,
  openedDocuments: [] as unknown[],
  shownDocuments: [] as unknown[],
  reviewEvents: [] as string[],
  diagnosticChannel: undefined as string | undefined,
  diagnosticLines: [] as string[],
  diagnosticDisposed: false,
  tabChangeListener: undefined as ((event: unknown) => void) | undefined,
  tabGroups: [{ isActive: true, tabs: [] as unknown[] }],
  settings: new Map<string, unknown>([
    ['accessibility.openChatEditedFiles', false],
    ['chat.disableAIFeatures', true],
  ]),
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
  MarkdownString: class MarkdownString {
    value = '';
    appendText(value: string) {
      this.value += value;
      return this;
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
      if (id === 'chatEditing.acceptFile' || id === 'chatEditing.discardFile') {
        host.reviewEvents.push(`command:${id}`);
      }
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
    createOutputChannel: (name: string) => {
      host.diagnosticChannel = name;
      return {
        appendLine: (line: string) => host.diagnosticLines.push(line),
        dispose() { host.diagnosticDisposed = true; },
      };
    },
    tabGroups: {
      get all() { return host.tabGroups; },
      onDidChangeTabs: (listener: (event: unknown) => void) => {
        host.tabChangeListener = listener;
        return { dispose() { host.tabChangeListener = undefined; } };
      },
    },
    get activeTextEditor() {
      return host.activeEditor ?? (host.activeEditorUri ? { document: { uri: host.activeEditorUri } } : undefined);
    },
    showWarningMessage: async (message: string) => { host.warnings.push(message); },
    showInformationMessage: async (message: string, ...items: string[]) => {
      host.informationMessages.push({ message, items });
      return host.informationPromise ?? host.informationChoice;
    },
    showTextDocument: async (document: unknown) => {
      host.shownDocuments.push(document);
      host.reviewEvents.push('showTextDocument');
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => host.settings.get(key) }),
    getWorkspaceFolder: (resource: { fsPath: string }) => resource.fsPath.startsWith('/home/user/workspace/') ? {} : undefined,
    textDocuments: [],
    openTextDocument: async (uri: unknown) => {
      const document = { uri };
      host.openedDocuments.push(document);
      host.reviewEvents.push('openTextDocument');
      return document;
    },
  },
}));

import { activate, deactivate } from '../src/extension.ts';

function installActiveEditor(
  content = 'const oldValue = 1;\nreturn oldValue;\n',
  fsPath = '/home/user/workspace/src/inline.ts',
): {
  uri: { scheme: string; fsPath: string };
  version: number;
  document: Record<string, unknown>;
  selection: Record<string, unknown>;
} {
  const uri = { scheme: 'file', fsPath };
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
  const selection = {
    isEmpty: false,
    start: { line: 0, character: 0 },
    end: { line: 0, character: lines[0]?.length ?? 0 },
  };
  host.activeEditor = { document, selection };
  return { uri, version: document.version, document, selection };
}

async function runInlineDiagnosticRequest(): Promise<void> {
  const target = installActiveEditor();
  nativeChat.runNativePiChat.mockImplementationOnce(async (options: {
    response: {
      textEdit(edits: unknown[], proposal: { requestId: string; summary: string }): void;
    };
  }) => {
    options.response.textEdit([{
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 5,
      newText: 'generated',
    }], {
      requestId: 'diagnostic-request',
      summary: 'Generated diagnostic test edit.',
    });
    return 'completed';
  });
  await activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as never);
  assert.ok(host.participantHandler);
  await host.participantHandler(
    {
      location: 4,
      location2: {
        document: target.document,
        selection: target.selection,
        wholeRange: target.selection,
      },
      prompt: 'generate diagnostic edit',
      references: [],
    },
    { history: [] },
    {
      markdown: () => assert.fail('diagnostic request emitted hidden markdown'),
      progress() {},
      thinkingProgress() {},
      textEdit() {},
      confirmation: () => assert.fail('diagnostic request emitted review confirmation'),
    },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
  );
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
  host.confirmations = [];
  host.openedDocuments = [];
  host.shownDocuments = [];
  host.reviewEvents = [];
  host.diagnosticChannel = undefined;
  host.diagnosticLines = [];
  host.diagnosticDisposed = false;
  host.tabChangeListener = undefined;
  host.tabGroups = [{ isActive: true, tabs: [] }];
  host.settings = new Map([
    ['accessibility.openChatEditedFiles', false],
    ['chat.disableAIFeatures', true],
  ]);
});

test('REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat', async () => {
  const subscriptions: Array<{ dispose(): void }> = [];
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions,
  } as never);

  assert.equal(host.participantId, 'codeflare.pi');
  assert.equal(host.diagnosticChannel, 'Codeflare Inline Chat');
  assert.match(host.diagnosticLines[0] ?? '', /revision=uri-authority-probe-v2/);
  assert.match(host.diagnosticLines[0] ?? '', /openChatEditedFiles=false/);
  assert.match(host.diagnosticLines[0] ?? '', /disableAIFeatures=true/);
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
  assert.equal(subscriptions.length, 7);
  assert.ok(host.tabChangeListener);
  await deactivate();
  assert.equal(host.diagnosticDisposed, true);
  assert.equal(host.tabChangeListener, undefined);
});

test('REQ-IDE-025 AC1 + REQ-IDE-034: panel requests run Pi without Inline diagnostics or provider generation', async () => {
  nativeChat.runNativePiChat.mockImplementationOnce(async (options: { backend: unknown }) => {
    assert.equal((options.backend as { constructor: { name: string } }).constructor.name, 'PiRpcBackend');
    return 'completed';
  });
  await activate({
    extensionUri: { fsPath: '/extension' },
    subscriptions: [],
  } as never);

  assert.ok(host.participantHandler);
  const diagnosticLineCount = host.diagnosticLines.length;
  await host.participantHandler(
    { location: 1, prompt: 'Refactor this selection', references: [] },
    { history: [] },
    { markdown() {}, progress() {} },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
  );

  assert.equal(nativeChat.runNativePiChat.mock.calls.length, 1);
  assert.equal(host.diagnosticLines.length, diagnosticLineCount);
});

test('REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document', async () => {
  const target = installActiveEditor('const targetValue = 1;\nreturn targetValue;\n', '/home/user/workspace/src/target.ts');
  const decoy = installActiveEditor('const decoyValue = 2;\n', '/home/user/workspace/src/decoy.ts');
  const rendered: Array<{ uri: unknown; edits: unknown }> = [];
  const progress: string[] = [];
  const reasoning: unknown[] = [];
  nativeChat.runNativePiChat.mockImplementation(async (options: {
    mode: string;
    input: {
      prompt: string;
      activeEditor?: {
        path: string;
        content: string;
        wholeRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
      };
    };
    response: {
      progress(value: string): void;
      thinking?(value: string): void;
      textEdit(edits: unknown[], proposal: { requestId: string; summary: string }): void;
    };
  }) => {
    assert.equal(options.mode, 'inline-edit');
    assert.equal(options.input.prompt, 'replace target');
    assert.equal(options.input.activeEditor?.path, target.uri.fsPath);
    assert.match(options.input.activeEditor?.content ?? '', /targetValue/);
    assert.doesNotMatch(options.input.activeEditor?.content ?? '', /decoyValue/);
    const requestDiagnostic = host.diagnosticLines.find((line) => line.includes('request=')) ?? '';
    assert.match(requestDiagnostic, /target\.ts/);
    assert.doesNotMatch(requestDiagnostic, /decoy\.ts|home\/user\/workspace/);
    assert.deepEqual(options.input.activeEditor?.wholeRange, {
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 20,
    });
    options.response.progress('Preparing native editor changes…');
    options.response.thinking?.('Preparing a bounded change.');
    options.response.textEdit([{
      startLine: 0,
      startCharacter: 6,
      endLine: 0,
      endCharacter: 17,
      newText: 'generated',
    }], {
      requestId: 'inline-request-1',
      summary: 'Replaced the selected target value.',
    });
    return 'completed';
  });
  await activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as never);

  host.activeEditor = { document: decoy.document, selection: decoy.selection };
  assert.ok(host.participantHandler);
  const result = await host.participantHandler(
    {
      location: 4,
      location2: {
        document: target.document,
        selection: target.selection,
        wholeRange: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 19 },
        },
      },
      prompt: 'replace target',
      references: [],
    },
    { history: [] },
    {
      markdown: () => assert.fail('native inline edit emitted hidden markdown'),
      progress: (value: string) => progress.push(value),
      thinkingProgress: (value: unknown) => reasoning.push(value),
      textEdit: (uri: unknown, edits: unknown) => rendered.push({ uri, edits }),
      confirmation: () => assert.fail('Codeflare took ownership of native review confirmation'),
    },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
  );

  assert.equal(nativeChat.runNativePiChat.mock.calls.length, 1);
  assert.equal(progress.length, 2);
  assert.deepEqual(reasoning, [{ id: 'codeflare-pi-inline-reasoning', text: 'Preparing a bounded change.' }]);
  assert.deepEqual(result, {
    details: 'Replaced the selected target value. 1 proposed edit.',
    metadata: {},
  });
  assert.equal(rendered.length, 3);
  assert.deepEqual(rendered[0], { uri: target.uri, edits: [] });
  assert.equal(rendered[1]?.uri, target.uri);
  assert.ok(Array.isArray(rendered[1]?.edits));
  assert.equal((rendered[1]?.edits as unknown[]).length, 1);
  assert.deepEqual(rendered[2], { uri: target.uri, edits: true });
  assert.deepEqual(host.confirmations, []);
  assert.deepEqual(host.informationMessages, []);
  assert.equal(host.executedCommand, undefined);
  assert.deepEqual(host.openedDocuments, []);
  assert.deepEqual(host.shownDocuments, []);
  assert.deepEqual(host.reviewEvents, []);
  assert.match(host.diagnosticLines.find((line) => line.includes('stream=')) ?? '', /target\.ts/);
  assert.match(host.diagnosticLines.find((line) => line.includes('snapshot=immediate')) ?? '', /groups=1/);

  const remoteUri = {
    scheme: 'vscode-remote',
    authority: 'operator:authority-secret@integration-proxy.example',
    path: '/home/user/workspace/private/target.ts',
    fsPath: '/home/user/workspace/private/target.ts',
    query: 'token=query-secret',
    fragment: 'fragment-secret',
    toString: () => 'vscode-remote://operator:authority-secret@integration-proxy.example/home/user/workspace/private/target.ts?token=query-secret#fragment-secret',
  };
  const openedTab = {
    label: 'credential-bearing-label-secret',
    isActive: true,
    input: { uri: remoteUri },
  };
  host.tabGroups = [{ isActive: true, tabs: [openedTab] }];
  host.tabChangeListener?.({ opened: [openedTab], closed: [], changed: [] });
  const tabEvent = host.diagnosticLines.find((line) => line.includes('tabsChanged')) ?? '';
  assert.match(tabEvent, /integration-proxy\.example/);
  assert.match(tabEvent, /target\.ts/);
  assert.doesNotMatch(tabEvent, /operator|authority-secret|query-secret|fragment-secret|credential-bearing-label-secret/);
  assert.doesNotMatch(tabEvent, /home\/user\/workspace|private/);
});

test('REQ-IDE-034 AC3: delayed Inline diagnostics record three-second and eight-second snapshots', async () => {
  vi.useFakeTimers();
  try {
    await runInlineDiagnosticRequest();
    assert.equal(host.diagnosticLines.filter((line) => line.includes('snapshot=3s')).length, 0);
    assert.equal(host.diagnosticLines.filter((line) => line.includes('snapshot=8s')).length, 0);

    await vi.advanceTimersByTimeAsync(3_000);
    assert.equal(host.diagnosticLines.filter((line) => line.includes('snapshot=3s')).length, 1);
    assert.equal(host.diagnosticLines.filter((line) => line.includes('snapshot=8s')).length, 0);

    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(host.diagnosticLines.filter((line) => line.includes('snapshot=8s')).length, 1);
  } finally {
    await deactivate();
    vi.useRealTimers();
  }
});

test('REQ-IDE-034 AC5: Inline diagnostics cap tab events and line length', async () => {
  vi.useFakeTimers();
  try {
    await runInlineDiagnosticRequest();
    const longName = `${'x'.repeat(13_000)}.ts`;
    const tab = {
      label: 'not-logged',
      isActive: true,
      input: {
        uri: {
          scheme: 'vscode-remote',
          authority: 'integration-proxy.example',
          path: `/workspace/${longName}`,
        },
      },
    };
    host.tabGroups = [{ isActive: true, tabs: [tab] }];
    for (let index = 0; index < 17; index += 1) {
      host.tabChangeListener?.({ opened: [tab], closed: [], changed: [] });
    }

    const tabEvents = host.diagnosticLines.filter((line) => line.includes('tabsChanged'));
    assert.equal(tabEvents.length, 16);
    const timestampedMessage = tabEvents[0]?.match(/^\S+ (.*)$/);
    assert.ok(timestampedMessage);
    const message = timestampedMessage[1];
    assert.ok(message.endsWith('…'));
    assert.equal(message.slice(0, -1).length, 12_000);
  } finally {
    await deactivate();
    vi.useRealTimers();
  }
});

test('REQ-IDE-034 AC7: deactivation cancels delayed diagnostics and the tab listener', async () => {
  vi.useFakeTimers();
  try {
    await runInlineDiagnosticRequest();
    const lineCount = host.diagnosticLines.length;

    await deactivate();
    assert.equal(host.diagnosticDisposed, true);
    assert.equal(host.tabChangeListener, undefined);
    await vi.advanceTimersByTimeAsync(8_000);
    assert.equal(host.diagnosticLines.length, lineCount);
  } finally {
    await deactivate();
    vi.useRealTimers();
  }
});

test('REQ-IDE-033: missing or malformed host editor location fails before Pi or edit emission', async () => {
  installActiveEditor();
  await activate({ extensionUri: { fsPath: '/extension' }, subscriptions: [] } as never);
  assert.ok(host.participantHandler);
  const rendered: unknown[] = [];
  const response = {
    markdown() {},
    progress() {},
    textEdit: (...args: unknown[]) => rendered.push(args),
    confirmation: () => assert.fail('invalid editor location opened review confirmation'),
  };
  const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

  await host.participantHandler(
    { location: 4, prompt: 'missing location', references: [] },
    { history: [] },
    response,
    cancellation,
  );
  await host.participantHandler(
    {
      location: 4,
      location2: { document: { uri: { scheme: 'untitled', fsPath: '' }, isClosed: false } },
      prompt: 'malformed location',
      references: [],
    },
    { history: [] },
    response,
    cancellation,
  );

  assert.equal(nativeChat.runNativePiChat.mock.calls.length, 0);
  assert.deepEqual(rendered, []);
  assert.equal(host.warnings.length, 2);
  assert.ok(host.warnings.every((message) => /active workspace file/i.test(message)));
});

test('REQ-IDE-025: panel-first then native inline edit reuses one unrestricted IDE Pi conversation', async () => {
  const target = installActiveEditor();
  const backends: unknown[] = [];
  const modes: string[] = [];
  const answers: string[] = [];
  const reasoning: unknown[] = [];
  const inlineEdits: unknown[] = [];
  nativeChat.runNativePiChat.mockImplementation(async (options: {
    mode: string;
    input: { prompt: string };
    response: {
      markdown(value: string): void;
      thinking?(value: string): void;
      textEdit?(edits: unknown[], proposal: { requestId: string; summary: string }): void;
    };
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
      }], {
        requestId: 'inline-request-2',
        summary: 'Returned the generated value because the prior name was stale.',
      });
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
    {
      location: 4,
      location2: {
        document: target.document,
        selection: target.selection,
        wholeRange: target.selection,
      },
      prompt: 'inline follow-up',
      references: [],
    },
    { history: [] },
    {
      markdown: () => assert.fail('native inline edit emitted hidden markdown'),
      progress() {},
      textEdit: (_uri: unknown, edits: unknown) => inlineEdits.push(edits),
      confirmation: () => assert.fail('shared Pi inline turn emitted review confirmation'),
    },
    cancellation,
  );

  assert.deepEqual(modes, ['chat', 'inline-edit']);
  assert.deepEqual(answers, ['answer:panel first']);
  assert.deepEqual(reasoning, [{ id: 'codeflare-pi-reasoning', text: 'Checking the selected architecture.' }]);
  assert.equal(inlineEdits.length, 3);
  assert.deepEqual(inlineEdits[0], []);
  assert.equal(inlineEdits[2], true);
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
