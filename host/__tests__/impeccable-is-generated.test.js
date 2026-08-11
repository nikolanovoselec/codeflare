import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../..');
const implementations = [
  'preseed/agents/claude/skills/impeccable/scripts/lib/is-generated.mjs',
  'preseed/agents/pi/skills/impeccable/scripts/lib/is-generated.mjs',
];
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function createRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'impeccable-generated-'));
  temporaryDirectories.push(cwd);
  execFileSync('git', ['init', '--quiet'], { cwd });
  writeFileSync(join(cwd, '.gitignore'), 'ignored.js\n-ignored.js\n');
  return cwd;
}

for (const implementation of implementations) {
  describe(implementation, () => {
    it('checks hostile filenames without executing shell syntax', async () => {
      const cwd = createRepository();
      const { isGeneratedFile } = await import(pathToFileURL(join(repoRoot, implementation)));
      const cases = [
        ['$(touch${IFS}command-substitution-ran).js', 'command-substitution-ran'],
        ['`touch${IFS}backtick-ran`.js', 'backtick-ran'],
        ['quoted " source.js', null],
        ['source with spaces.js', null],
      ];

      for (const [filename, payload] of cases) {
        writeFileSync(join(cwd, filename), 'export {};\n');
        assert.equal(isGeneratedFile(filename, { cwd }), false);
        if (payload) assert.throws(() => execFileSync('test', ['-e', payload], { cwd }));
      }
    });

    it('preserves ignored-file and generated-header behavior', async () => {
      const cwd = createRepository();
      const { isGeneratedFile } = await import(pathToFileURL(join(repoRoot, implementation)));
      writeFileSync(join(cwd, 'ignored.js'), 'export {};\n');
      writeFileSync(join(cwd, '-ignored.js'), 'export {};\n');
      writeFileSync(join(cwd, 'generated.js'), '// DO NOT EDIT\nexport {};\n');
      writeFileSync(join(cwd, 'source.js'), 'export {};\n');

      assert.equal(isGeneratedFile('ignored.js', { cwd }), true);
      assert.equal(isGeneratedFile('-ignored.js', { cwd }), true);
      assert.equal(isGeneratedFile('generated.js', { cwd }), true);
      assert.equal(isGeneratedFile('source.js', { cwd }), false);
    });
  });
}
