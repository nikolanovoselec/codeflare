import type { NativePiTextEdit } from './native-chat.ts';

const MAX_INLINE_EDITS = 64;
const MAX_INLINE_EDIT_BYTES = 256 * 1024;

export interface InlineEditDocumentSnapshot {
  readonly version: number;
  readonly lineCount: number;
  lineLength(line: number): number;
}

export function validateInlineTextEdits(
  document: InlineEditDocumentSnapshot,
  expectedVersion: number,
  edits: readonly NativePiTextEdit[],
): readonly NativePiTextEdit[] {
  if (document.version !== expectedVersion) {
    throw new Error('Inline Chat document changed before the edit proposal completed');
  }
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX_INLINE_EDITS) {
    throw new Error('Invalid Inline Chat edit count');
  }

  let totalBytes = 0;
  const validated = edits.map((edit) => {
    if (!validEdit(edit) || !positionInDocument(document, edit.startLine, edit.startCharacter)
      || !positionInDocument(document, edit.endLine, edit.endCharacter)
      || comparePosition(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter) > 0) {
      throw new Error('Invalid Inline Chat edit range');
    }
    totalBytes += Buffer.byteLength(edit.newText, 'utf8');
    if (totalBytes > MAX_INLINE_EDIT_BYTES) throw new Error('Inline Chat edit size exceeds the bounded limit');
    return { ...edit };
  });

  const ordered = [...validated].sort((left, right) =>
    comparePosition(left.startLine, left.startCharacter, right.startLine, right.startCharacter));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const sameStart = comparePosition(
      previous.startLine,
      previous.startCharacter,
      current.startLine,
      current.startCharacter,
    ) === 0;
    const crosses = comparePosition(
      previous.endLine,
      previous.endCharacter,
      current.startLine,
      current.startCharacter,
    ) > 0;
    if (sameStart || crosses) throw new Error('Inline Chat edit ranges overlap');
  }
  return ordered;
}

function validEdit(value: unknown): value is NativePiTextEdit {
  if (!isRecord(value) || typeof value.newText !== 'string') return false;
  return [value.startLine, value.startCharacter, value.endLine, value.endCharacter]
    .every((part) => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0);
}

function positionInDocument(
  document: InlineEditDocumentSnapshot,
  line: number,
  character: number,
): boolean {
  if (!Number.isSafeInteger(line) || line < 0 || line >= document.lineCount) return false;
  const lineLength = document.lineLength(line);
  return Number.isSafeInteger(lineLength) && lineLength >= 0 && character <= lineLength;
}

function comparePosition(
  leftLine: number,
  leftCharacter: number,
  rightLine: number,
  rightCharacter: number,
): number {
  return leftLine === rightLine ? leftCharacter - rightCharacter : leftLine - rightLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
