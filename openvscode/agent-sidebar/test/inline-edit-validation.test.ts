import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateInlineTextEdits } from '../src/pi/inline-edit-validation.ts';

const document = {
  version: 7,
  lineCount: 3,
  lineLength: (line: number) => ['const value = 1;', 'return value;', ''][line]?.length ?? 0,
};

test('REQ-IDE-020: native inline edits validate against the captured document version and bounds', () => {
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

test('REQ-IDE-020: adjacent non-overlapping inline edits are accepted and ordered', () => {
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

test('REQ-IDE-020: stale, overlapping, and out-of-bounds inline edits fail closed', () => {
  const edit = {
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 5,
    newText: 'let',
  };

  assert.throws(() => validateInlineTextEdits(document, 6, [edit]), /document changed/i);
  assert.throws(() => validateInlineTextEdits(document, 7, [
    edit,
    { ...edit, startCharacter: 4, endCharacter: 8 },
  ]), /overlap/i);
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...edit, endLine: 9 },
  ]), /range/i);
  assert.throws(() => validateInlineTextEdits(document, 7, [
    { ...edit, newText: 'x'.repeat(300 * 1024) },
  ]), /size/i);
});
