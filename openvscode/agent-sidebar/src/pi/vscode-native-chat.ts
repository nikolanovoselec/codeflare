import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  DiagnosticSeverity,
  Range,
  languages,
  window,
  workspace,
  type ChatContext,
  type ChatPromptReference,
  type ChatRequest,
  type ChatResponseMarkdownPart,
  type ChatResponseTurn,
  type Diagnostic,
  type Location,
  type TextDocument,
  type TextEditor,
  type Uri,
} from 'vscode';

import type {
  NativePiActiveEditor,
  NativePiDiagnostic,
  NativePiHistoryEntry,
  NativePiPromptInput,
  NativePiReference,
} from './native-chat.ts';

const WORKSPACE_ROOT = '/home/user/workspace';
const MAX_COLLECTED_DOCUMENTS = 32;
const MAX_COLLECTED_DIAGNOSTICS = 256;

interface ActiveEditorSnapshot {
  readonly uri: Uri;
  readonly languageId: string;
  readonly dirty: boolean;
  readonly content: string;
  readonly selection?: NonNullable<NativePiActiveEditor['selection']>;
}

interface ReferenceSnapshot {
  readonly uri?: Uri;
  readonly range?: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly description?: string;
  readonly text: string | Promise<string | undefined>;
}

export async function canonicalWorkspaceFilePath(
  uri: Uri,
  workspaceRoot: string = WORKSPACE_ROOT,
): Promise<string | undefined> {
  try {
    return await canonicalWorkspacePath(uri, await realpath(workspaceRoot));
  } catch {
    return undefined;
  }
}

export async function collectNativePiPromptInput(
  request: ChatRequest,
  context: ChatContext,
  workspaceRoot: string = WORKSPACE_ROOT,
): Promise<NativePiPromptInput> {
  // Snapshot host-owned request state before the first await. The persistent
  // runtime may queue this turn behind another, and a later editor focus change
  // must not rewrite which context the user invoked it with.
  const prompt = request.prompt;
  const requestReferences = [...request.references];
  const documentSnapshots = workspace.textDocuments.filter((document) => !document.isClosed);
  const referenceSnapshots = snapshotReferences(requestReferences, documentSnapshots);
  const history = collectHistory(context);
  const activeEditorSnapshot = snapshotActiveEditor(window.activeTextEditor);
  const diagnosticSnapshots = snapshotDiagnostics(activeEditorSnapshot?.uri, requestReferences);
  const canonicalRoot = await realpath(workspaceRoot);
  const activeEditor = await collectActiveEditor(activeEditorSnapshot, canonicalRoot);
  const openFiles = await collectOpenFiles(documentSnapshots, canonicalRoot);
  const references = await collectReferences(referenceSnapshots, canonicalRoot);
  const diagnosticPaths = new Map<string, Uri>();
  const activeUri = activeEditorSnapshot?.uri;
  if (activeEditor && activeUri) diagnosticPaths.set(activeEditor.path, activeUri);
  for (const reference of requestReferences) {
    const uri = referenceUri(reference);
    if (!uri) continue;
    const path = await canonicalWorkspacePath(uri, canonicalRoot);
    if (path) diagnosticPaths.set(path, uri);
  }

  return {
    prompt,
    history,
    activeEditor,
    openFiles,
    diagnostics: await collectDiagnostics(diagnosticPaths, diagnosticSnapshots, canonicalRoot),
    references,
  };
}

function snapshotActiveEditor(editor: TextEditor | undefined): ActiveEditorSnapshot | undefined {
  if (!editor) return undefined;
  const selection = editor.selection;
  return {
    uri: editor.document.uri,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    content: editor.document.getText(),
    selection: selection.isEmpty ? undefined : {
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
      text: editor.document.getText(selection),
    },
  };
}

async function collectActiveEditor(
  editor: ActiveEditorSnapshot | undefined,
  canonicalRoot: string,
): Promise<NativePiActiveEditor | undefined> {
  if (!editor) return undefined;
  const path = await canonicalWorkspacePath(editor.uri, canonicalRoot);
  if (!path) return undefined;
  return {
    path,
    languageId: editor.languageId,
    dirty: editor.dirty,
    content: editor.content,
    selection: editor.selection,
  };
}

async function collectOpenFiles(
  documents: readonly TextDocument[],
  canonicalRoot: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const document of documents) {
    if (paths.length >= MAX_COLLECTED_DOCUMENTS) break;
    const path = await canonicalWorkspacePath(document.uri, canonicalRoot);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function snapshotReferences(
  values: readonly ChatPromptReference[],
  documents: readonly TextDocument[],
): readonly ReferenceSnapshot[] {
  return values.slice(0, MAX_COLLECTED_DOCUMENTS).map((reference) => {
    if (typeof reference.value === 'string') {
      return { text: reference.value, description: reference.modelDescription };
    }
    const uri = referenceUri(reference);
    const liveRange = referenceRange(reference);
    const range = liveRange ? {
      start: { line: liveRange.start.line, character: liveRange.start.character },
      end: { line: liveRange.end.line, character: liveRange.end.character },
    } : undefined;
    if (!uri) return { text: '', description: reference.modelDescription };
    const open = documents.find((document) => document.uri.fsPath === uri.fsPath);
    return {
      uri,
      range,
      description: reference.modelDescription,
      text: open ? open.getText(toRange(range)) : readReferenceText(uri, range),
    };
  });
}

function toRange(range: ReferenceSnapshot['range']): Range | undefined {
  return range ? new Range(range.start.line, range.start.character, range.end.line, range.end.character) : undefined;
}

async function readReferenceText(uri: Uri, range: ReferenceSnapshot['range']): Promise<string | undefined> {
  const document = await openDocument(uri);
  return document?.getText(toRange(range));
}

async function collectReferences(
  values: readonly ReferenceSnapshot[],
  canonicalRoot: string,
): Promise<NativePiReference[]> {
  const references: NativePiReference[] = [];
  for (const reference of values) {
    if (!reference.uri) {
      if (typeof reference.text === 'string' && reference.text) {
        references.push({ text: reference.text, description: reference.description });
      }
      continue;
    }
    const path = await canonicalWorkspacePath(reference.uri, canonicalRoot);
    if (!path) continue;
    const text = await reference.text;
    if (text === undefined) continue;
    references.push({
      path,
      startLine: reference.range ? reference.range.start.line + 1 : undefined,
      endLine: reference.range ? reference.range.end.line + 1 : undefined,
      text,
      description: reference.description,
    });
  }
  return references;
}

function collectHistory(context: ChatContext): NativePiHistoryEntry[] {
  const history: NativePiHistoryEntry[] = [];
  for (const turn of context.history) {
    if ('prompt' in turn && typeof turn.prompt === 'string') {
      history.push({ role: 'user', text: turn.prompt });
      continue;
    }
    if ('response' in turn && Array.isArray(turn.response)) {
      const text = (turn as ChatResponseTurn).response.map(textFromResponsePart).filter(isString).join('');
      if (text) history.push({ role: 'assistant', text });
    }
  }
  return history;
}

function snapshotDiagnostics(
  activeUri: Uri | undefined,
  references: readonly ChatPromptReference[],
): ReadonlyMap<Uri, readonly Diagnostic[]> {
  const snapshots = new Map<Uri, readonly Diagnostic[]>();
  const uris = [activeUri, ...references.map(referenceUri)].filter((uri): uri is Uri => uri !== undefined);
  for (const uri of uris) {
    if (![...snapshots.keys()].some((existing) => existing.fsPath === uri.fsPath)) {
      snapshots.set(uri, [...languages.getDiagnostics(uri)]);
    }
  }
  return snapshots;
}

async function collectDiagnostics(
  paths: ReadonlyMap<string, Uri>,
  snapshots: ReadonlyMap<Uri, readonly Diagnostic[]>,
  canonicalRoot: string,
): Promise<NativePiDiagnostic[]> {
  const diagnostics: NativePiDiagnostic[] = [];
  for (const [path, uri] of paths) {
    if (diagnostics.length >= MAX_COLLECTED_DIAGNOSTICS) break;
    if (!await canonicalWorkspacePath(uri, canonicalRoot)) continue;
    const snapshot = [...snapshots].find(([candidate]) => candidate.fsPath === uri.fsPath)?.[1] ?? [];
    for (const diagnostic of snapshot) {
      diagnostics.push({
        path,
        severity: diagnosticSeverity(diagnostic.severity),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        message: diagnostic.message,
      });
      if (diagnostics.length >= MAX_COLLECTED_DIAGNOSTICS) break;
    }
  }
  return diagnostics;
}

async function canonicalWorkspacePath(uri: Uri, canonicalRoot: string): Promise<string | undefined> {
  if (!isUri(uri) || uri.scheme !== 'file' || !isAbsolute(uri.fsPath) || uri.fsPath.includes('\0')) return undefined;
  const requested = resolve(uri.fsPath);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) return undefined;
    try {
      canonical = join(await realpath(dirname(requested)), basename(requested));
    } catch {
      return undefined;
    }
  }
  if (canonical !== requested) return undefined;
  const rel = relative(canonicalRoot, canonical);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
  return canonical;
}

async function openDocument(uri: Uri): Promise<TextDocument | undefined> {
  try {
    return await workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

function referenceUri(reference: ChatPromptReference): Uri | undefined {
  const value = reference.value;
  if (isUri(value)) return value;
  if (isLocation(value)) return value.uri;
  return undefined;
}

function referenceRange(reference: ChatPromptReference): Range | undefined {
  return isLocation(reference.value) ? reference.value.range : undefined;
}

function textFromResponsePart(part: ChatResponseMarkdownPart | unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const value = part.value;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.value === 'string') return value.value;
  return undefined;
}

function diagnosticSeverity(value: DiagnosticSeverity): NativePiDiagnostic['severity'] {
  if (value === DiagnosticSeverity.Error) return 'error';
  if (value === DiagnosticSeverity.Warning) return 'warning';
  if (value === DiagnosticSeverity.Information) return 'information';
  return 'hint';
}

function isUri(value: unknown): value is Uri {
  return isRecord(value) && typeof value.scheme === 'string' && typeof value.fsPath === 'string';
}

function isLocation(value: unknown): value is Location {
  return isRecord(value) && isUri(value.uri) && isRange(value.range);
}

function isRange(value: unknown): value is Range {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) return false;
  return value.start.line < value.end.line ||
    (value.start.line === value.end.line && value.start.character <= value.end.character);
}

function isPosition(value: unknown): value is { readonly line: number; readonly character: number } {
  return isRecord(value) &&
    typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line >= 0 &&
    typeof value.character === 'number' && Number.isSafeInteger(value.character) && value.character >= 0;
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
