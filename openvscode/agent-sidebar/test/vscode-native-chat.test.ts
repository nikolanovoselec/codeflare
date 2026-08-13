import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  activeTextEditor: undefined as unknown,
  documents: [] as unknown[],
  diagnostics: [] as unknown[],
  ranges: [] as unknown[],
  openedDocuments: [] as unknown[],
}));

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Range: class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
      host.ranges.push(this);
    }
  },
  languages: { getDiagnostics: () => host.diagnostics },
  window: {
    get activeTextEditor() { return host.activeTextEditor; },
  },
  workspace: {
    get textDocuments() { return host.documents; },
    openTextDocument: async (uri: { fsPath: string }) =>
      [...host.documents, ...host.openedDocuments]
        .find((value) => (value as { uri?: { fsPath?: string } }).uri?.fsPath === uri.fsPath),
  },
}));

import { collectNativePiPromptInput } from '../src/pi/vscode-native-chat.ts';

const roots: string[] = [];

afterEach(async () => {
  host.activeTextEditor = undefined;
  host.documents = [];
  host.diagnostics = [];
  host.ranges = [];
  host.openedDocuments = [];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('REQ-IDE-005 AC2: native host collection captures active selection and rejects a symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-chat-context-'));
  roots.push(root);
  const activePath = join(root, 'active.ts');
  const referencePath = join(root, 'reference.ts');
  const escapedPath = join(root, 'escaped.ts');
  const aliasPath = join(root, 'alias.ts');
  await writeFile(activePath, 'const selected = broken;\n');
  await writeFile(referencePath, 'export const reference = true;\n');
  await symlink('/etc/hosts', escapedPath);
  await symlink(referencePath, aliasPath);

  const selection = {
    isEmpty: false,
    start: { line: 0, character: 17 },
    end: { line: 0, character: 23 },
  };
  const document = (path: string, text: string) => ({
    uri: { scheme: 'file', fsPath: path },
    languageId: 'typescript',
    isDirty: true,
    isClosed: false,
    getText: (range?: unknown) => range && path === activePath ? 'broken' : text,
  });
  const activeDocument = document(activePath, 'const selected = broken;\n');
  const referenceDocument = document(referencePath, 'export const reference = true;\n');
  const escapedDocument = document(escapedPath, 'outside-workspace-canary');
  const aliasDocument = document(aliasPath, 'stale-alias-canary');
  host.activeTextEditor = { document: activeDocument, selection };
  host.documents = [activeDocument, referenceDocument, escapedDocument, aliasDocument];
  host.diagnostics = [{
    severity: 0,
    range: { start: { line: 0, character: 17 } },
    message: 'Cannot find name broken.',
  }];

  const input = await collectNativePiPromptInput({
    prompt: 'Fix this file.',
    references: [
      {
        value: {
          uri: referenceDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 29 } },
        },
        modelDescription: 'Attached reference',
      },
      {
        value: {
          uri: aliasDocument.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } },
        },
        modelDescription: 'Aliased reference',
      },
    ],
  } as never, {
    history: [
      { prompt: 'Earlier question' },
      { response: [{ value: { value: 'Earlier answer' } }] },
    ],
  } as never, root);

  assert.equal(input.activeEditor?.path, activePath);
  assert.equal(input.activeEditor?.selection?.text, 'broken');
  assert.deepEqual(input.openFiles, [activePath, referencePath]);
  assert.equal(input.references[0]?.path, referencePath);
  assert.equal(input.references[0]?.text, 'export const reference = true;\n');
  assert.deepEqual(host.ranges.map((range) => (range as { start: unknown; end: unknown })), [{
    start: { line: 0, character: 0 },
    end: { line: 0, character: 29 },
  }]);
  assert.deepEqual(input.history, [
    { role: 'user', text: 'Earlier question' },
    { role: 'assistant', text: 'Earlier answer' },
  ]);
  assert.equal(input.diagnostics[0]?.message, 'Cannot find name broken.');
  assert.doesNotMatch(JSON.stringify(input), /outside-workspace-canary|escaped\.ts|stale-alias-canary|alias\.ts/);
});

test('REQ-IDE-006: queued native requests capture their editor and Chat context at invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-chat-invocation-context-'));
  roots.push(root);
  const invokedPath = join(root, 'invoked.ts');
  const laterPath = join(root, 'later.ts');
  const referencePath = join(root, 'reference.ts');
  await writeFile(invokedPath, 'export const invoked = true;\n');
  await writeFile(laterPath, 'export const later = true;\n');
  await writeFile(referencePath, 'reference text at invocation');
  const document = (path: string, text: string) => ({
    uri: { scheme: 'file', fsPath: path },
    languageId: 'typescript',
    isDirty: true,
    isClosed: false,
    getText: () => text,
  });
  const invokedDocument = document(invokedPath, 'export const invoked = true;\n');
  const laterDocument = document(laterPath, 'export const later = true;\n');
  host.activeTextEditor = {
    document: invokedDocument,
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
  host.documents = [invokedDocument];
  host.diagnostics = [{
    severity: 1,
    range: { start: { line: 0, character: 7 } },
    message: 'invocation diagnostic',
  }];
  const history = [{ prompt: 'invocation history' }];
  const referenceDocument = document(referencePath, 'reference text at invocation');
  host.documents.push(referenceDocument);
  const references: unknown[] = [{ value: referenceDocument.uri, modelDescription: 'attached file' }];

  const collecting = collectNativePiPromptInput({
    prompt: 'invocation prompt',
    references,
  } as never, { history } as never, root);
  host.activeTextEditor = {
    document: laterDocument,
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
  host.documents = [laterDocument];
  invokedDocument.getText = () => 'mutated after invocation';
  referenceDocument.getText = () => 'mutated reference after invocation';
  host.diagnostics = [{
    severity: 0,
    range: { start: { line: 0, character: 0 } },
    message: 'later diagnostic',
  }];
  history[0] = { prompt: 'later history' };
  references.push({ value: laterDocument.uri });

  const input = await collecting;

  assert.equal(input.activeEditor?.path, invokedPath);
  assert.equal(input.activeEditor?.content, 'export const invoked = true;\n');
  assert.deepEqual(input.openFiles, [invokedPath]);
  assert.deepEqual(input.history, [{ role: 'user', text: 'invocation history' }]);
  assert.equal(input.diagnostics[0]?.message, 'invocation diagnostic');
  assert.equal(input.references[0]?.text, 'reference text at invocation');
  assert.equal(input.references[0]?.description, 'attached file');
});

test('REQ-IDE-005 AC7: native Pi context collection ignores the host-selected model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-chat-model-independent-'));
  roots.push(root);
  let modelReads = 0;

  const input = await collectNativePiPromptInput({
    prompt: 'Inspect this workspace.',
    references: [],
    get model() {
      modelReads += 1;
      throw new Error('host-selected model was accessed');
    },
  } as never, { history: [] } as never, root);

  assert.equal(input.prompt, 'Inspect this workspace.');
  assert.equal(modelReads, 0);
});

test('REQ-IDE-006 AC1: open and newly opened reference documents receive native Range instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-chat-native-ranges-'));
  roots.push(root);
  const openPath = join(root, 'open.ts');
  const closedPath = join(root, 'closed.ts');
  await writeFile(openPath, 'open reference');
  await writeFile(closedPath, 'closed reference');
  const seen: unknown[] = [];
  const document = (path: string, text: string) => ({
    uri: { scheme: 'file', fsPath: path },
    languageId: 'typescript',
    isDirty: false,
    isClosed: false,
    getText: (range?: unknown) => {
      seen.push(range);
      return text;
    },
  });
  const openDocument = document(openPath, 'open reference');
  const closedDocument = document(closedPath, 'closed reference');
  host.documents = [openDocument];
  host.openedDocuments = [closedDocument];

  const input = await collectNativePiPromptInput({
    prompt: 'Inspect references.',
    references: [
      { value: { uri: openDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } } },
      { value: { uri: closedDocument.uri, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 7 } } } },
    ],
  } as never, { history: [] } as never, root);

  assert.deepEqual(input.references.map((reference) => reference.text), ['open reference', 'closed reference']);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((range) => range?.constructor?.name === 'Range'));
  assert.deepEqual(host.ranges, seen);
});

test('REQ-IDE-006 AC1: malformed native reference ranges are ignored at the host boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-chat-malformed-reference-'));
  roots.push(root);
  const referencePath = join(root, 'reference.ts');
  await writeFile(referencePath, 'export const reference = true;\n');
  const referenceDocument = {
    uri: { scheme: 'file', fsPath: referencePath },
    languageId: 'typescript',
    isDirty: false,
    isClosed: false,
    getText: () => 'export const reference = true;\n',
  };
  host.documents = [referenceDocument];

  const input = await collectNativePiPromptInput({
    prompt: 'Inspect references.',
    references: [
      { value: { uri: referenceDocument.uri, range: {} } },
      { value: { uri: referenceDocument.uri, range: { start: { line: -1 }, end: null } } },
      { value: 42 },
    ],
  } as never, { history: [] } as never, root);

  assert.deepEqual(input.references, []);
});
