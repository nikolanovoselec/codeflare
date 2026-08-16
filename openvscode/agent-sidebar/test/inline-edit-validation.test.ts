import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateInlineTextEdits } from '../src/pi/inline-edit-validation.ts';

const document = {
  version: 7,
  lineCount: 3,
  lineLength: (line: number) => ['const value = 1;', 'return value;', ''][line]?.length ?? 0,
};

const boundedEdit = {
  startLine: 0,
  startCharacter: 0,
  endLine: 0,
  endCharacter: 5,
  newText: 'let',
};

test('REQ-IDE-026: native inline edits validate against the captured document version and bounds', () => {
  const edits = validateInlineTextEdits(document, 7, [{
    startLine: 0,
    startCharacter: 6,
    endLine: 0,
    endCharacter: 11,
    newText: 'answer',
  }, {
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 0,
    newText: 'export {};\n',
  }]);

  assert.deepEqual(edits, [{
    startLine: 0,
    startCharacter: 6,
    endLine: 0,
    endCharacter: 11,
    newText: 'answer',
  }, {
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 0,
    newText: 'export {};\n',
  }]);
});

test('REQ-IDE-026: adjacent non-overlapping inline edits are accepted and ordered', () => {
  const edits = validateInlineTextEdits(document, 7, [{
    startLine: 0,
    startCharacter: 5,
    endLine: 0,
    endCharacter: 5,
    newText: ';',
  }, {
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 5,
    newText: 'const',
  }]);

  assert.deepEqual(edits.map((edit) => edit.newText), ['const', ';']);
});

test('REQ-IDE-026: empty inline edit proposals fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, []), /edit count/i);
});

test('REQ-IDE-026: more than 64 inline edits fail closed', () => {
  const insert = {
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 0,
    newText: 'x',
  };

  assert.throws(() => validateInlineTextEdits(
    document,
    7,
    Array.from({ length: 65 }, () => ({ ...insert })),
  ), /edit count/i);
});

test('REQ-IDE-026: stale document versions fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 6, [boundedEdit]), /document changed/i);
});

test('REQ-IDE-026: invalid inline edit coordinates fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...boundedEdit, startCharacter: -1 },
  ]), /range/i);
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...boundedEdit, startCharacter: 6 },
  ]), /range/i);
});

test('REQ-IDE-026: repeated edit starts fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...boundedEdit, endCharacter: 0, newText: 'a' },
    { ...boundedEdit, endCharacter: 0, newText: 'b' },
  ]), /overlap/i);
});

test('REQ-IDE-026: overlapping inline edits fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, [
    boundedEdit,
    { ...boundedEdit, startCharacter: 4, endCharacter: 8 },
  ]), /overlap/i);
});

test('REQ-IDE-026: out-of-bounds inline edits fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...boundedEdit, endLine: 9 },
  ]), /range/i);
});

test('REQ-IDE-026: inline edit payloads above 256 KiB fail closed', () => {
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...boundedEdit, newText: 'x'.repeat(300 * 1024) },
  ]), /size/i);
});
