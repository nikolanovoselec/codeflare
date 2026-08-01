import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  DiagnosticSeverity,
  languages,
  window,
  workspace,
  type ChatContext,
  type ChatPromptReference,
  type ChatRequest,
  type ChatResponseMarkdownPart,
  type ChatResponseTurn,
  type Location,
  type Range,
  type TextDocument,
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
  const canonicalRoot = await realpath(workspaceRoot);
  const activeEditor = await collectActiveEditor(canonicalRoot);
  const openFiles = await collectOpenFiles(canonicalRoot);
  const references = await collectReferences(request.references, canonicalRoot);
  const diagnosticPaths = new Map<string, Uri>();
  const activeUri = window.activeTextEditor?.document.uri;
  if (activeEditor && activeUri) diagnosticPaths.set(activeEditor.path, activeUri);
  for (const reference of request.references) {
    const uri = referenceUri(reference);
    if (!uri) continue;
    const path = await canonicalWorkspacePath(uri, canonicalRoot);
    if (path) diagnosticPaths.set(path, uri);
  }

  return {
    prompt: request.prompt,
    history: collectHistory(context),
    activeEditor,
    openFiles,
    diagnostics: await collectDiagnostics(diagnosticPaths, canonicalRoot),
    references,
  };
}

async function collectActiveEditor(canonicalRoot: string): Promise<NativePiActiveEditor | undefined> {
  const editor = window.activeTextEditor;
  if (!editor) return undefined;
  const path = await canonicalWorkspacePath(editor.document.uri, canonicalRoot);
  if (!path) return undefined;
  const selection = editor.selection;
  return {
    path,
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

async function collectOpenFiles(canonicalRoot: string): Promise<string[]> {
  const paths: string[] = [];
  for (const document of workspace.textDocuments) {
    if (paths.length >= MAX_COLLECTED_DOCUMENTS) break;
    if (document.isClosed) continue;
    const path = await canonicalWorkspacePath(document.uri, canonicalRoot);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

async function collectReferences(
  values: readonly ChatPromptReference[],
  canonicalRoot: string,
): Promise<NativePiReference[]> {
  const references: NativePiReference[] = [];
  for (const reference of values.slice(0, MAX_COLLECTED_DOCUMENTS)) {
    if (typeof reference.value === 'string') {
      references.push({
        text: reference.value,
        description: reference.modelDescription,
      });
      continue;
    }
    const uri = referenceUri(reference);
    if (!uri) continue;
    const path = await canonicalWorkspacePath(uri, canonicalRoot);
    if (!path) continue;
    const range = referenceRange(reference);
    const document = await openDocument(uri);
    if (!document || await canonicalWorkspacePath(document.uri, canonicalRoot) !== path) continue;
    references.push({
      path,
      startLine: range ? range.start.line + 1 : undefined,
      endLine: range ? range.end.line + 1 : undefined,
      text: document.getText(range),
      description: reference.modelDescription,
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

async function collectDiagnostics(
  paths: ReadonlyMap<string, Uri>,
  canonicalRoot: string,
): Promise<NativePiDiagnostic[]> {
  const diagnostics: NativePiDiagnostic[] = [];
  for (const [path, uri] of paths) {
    if (diagnostics.length >= MAX_COLLECTED_DIAGNOSTICS) break;
    if (!await canonicalWorkspacePath(uri, canonicalRoot)) continue;
    for (const diagnostic of languages.getDiagnostics(uri)) {
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
