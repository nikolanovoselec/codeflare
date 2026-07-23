import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  activeTextEditor: undefined as unknown,
  documents: [] as unknown[],
  diagnostics: [] as unknown[],
}));

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  languages: { getDiagnostics: () => host.diagnostics },
  window: {
    get activeTextEditor() { return host.activeTextEditor; },
  },
  workspace: {
    get textDocuments() { return host.documents; },
    openTextDocument: async (uri: { fsPath: string }) =>
      host.documents.find((value) => (value as { uri?: { fsPath?: string } }).uri?.fsPath === uri.fsPath),
  },
}));

import { collectNativePiPromptInput } from '../src/pi/vscode-native-chat.ts';

const roots: string[] = [];

afterEach(async () => {
  host.activeTextEditor = undefined;
  host.documents = [];
  host.diagnostics = [];
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
  assert.deepEqual(input.history, [
    { role: 'user', text: 'Earlier question' },
    { role: 'assistant', text: 'Earlier answer' },
  ]);
  assert.equal(input.diagnostics[0]?.message, 'Cannot find name broken.');
  assert.doesNotMatch(JSON.stringify(input), /outside-workspace-canary|escaped\.ts|stale-alias-canary|alias\.ts/);
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
