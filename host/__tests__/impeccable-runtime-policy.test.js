import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyCodeflareImpeccableOverlay,
  replaceImpeccableTargets,
} from '../../scripts/update-impeccable-skill.mjs';
import { managedImpeccableLauncher } from '../../scripts/impeccable-launcher.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repoRoot, 'preseed/agents/claude/skills/impeccable');


function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Impeccable managed runtime policy', () => {
  it('REQ-AGENT-181: native bundle refresh preserves policy without a retired JavaScript server', () => withTempDir((root) => {
    const source = join(root, 'source');
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    applyCodeflareImpeccableOverlay(source);
    const target = join(root, 'target');
    replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), [{
      agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
    }]);
    const skill = readFileSync(join(target, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /Bash\(npx impeccable/);
    applyCodeflareImpeccableOverlay(target, { allowAlreadyApplied: true });
    const launcher = join(target, 'scripts/impeccable');
    const result = spawnSync('sh', [launcher, 'update'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /image-owned/);
  }));

  it('REQ-AGENT-181: current native bundle refresh dispatches through its reviewed image engine without a retired JavaScript server', () => withTempDir((root) => {
    const source = join(root, 'source');
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    const skillPath = join(source, 'SKILL.md');
    assert.equal(existsSync(join(source, 'scripts/serve-question.mjs')), false);
    applyCodeflareImpeccableOverlay(source);

    const target = join(root, 'target');
    replaceImpeccableTargets(source, readFileSync(skillPath, 'utf8'), [{
      agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
    }]);
    assert.equal(existsSync(join(target, 'scripts/serve-question.mjs')), false);

    const engineRoot = join(root, 'engine');
    const engine = join(engineRoot, '0.1.5', 'impeccable');
    mkdirSync(dirname(engine), { recursive: true });
    writeFileSync(engine, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const launcher = join(target, 'scripts/impeccable');
    writeFileSync(launcher, managedImpeccableLauncher(engineRoot), { mode: 0o755 });
    const result = spawnSync(launcher, ['context', '--target', 'file.ts'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.trim().split('\n'), ['context', '--target', 'file.ts']);
  }));

  it('REQ-AGENT-181: unreviewed native engine fails before source mutation', () => withTempDir((source) => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.4\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /engine version/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: native launcher uses only the image engine and refuses runtime updates', () => {
    withTempDir((root) => {
      const scripts = join(root, 'skill', 'scripts');
      const engine = join(root, 'engine', '0.1.5');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(engine, { recursive: true });
      const launcher = join(scripts, 'impeccable');
      writeFileSync(launcher, managedImpeccableLauncher(join(root, 'engine')), { mode: 0o755 });
      writeFileSync(join(scripts, 'VERSION'), '0.1.5\n');
      writeFileSync(join(engine, 'impeccable'), '#!/bin/sh\nprintf "%s\\n" "$IMPECCABLE_SKILL_DIR" "$IMPECCABLE_SELF" "$@"\n', { mode: 0o755 });
      const result = spawnSync(launcher, ['context', '--target', 'a file.ts'], { encoding: 'utf8', env: { ...process.env, IMPECCABLE_BIN: '/does/not/exist' } });
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split('\n'), [join(root, 'skill'), launcher, 'context', '--target', 'a file.ts']);
      for (const args of [['install'], ['update'], ['uninstall'], ['link'], ['skills', 'install'], ['skills', 'update'], ['skills', 'link']]) {
        const denied = spawnSync(launcher, args, { encoding: 'utf8' });
        assert.equal(denied.status, 1, args.join(' '));
        assert.equal(denied.stdout, '');
        assert.match(denied.stderr, /image-owned/);
      }
      rmSync(join(engine, 'impeccable'));
      const missing = spawnSync(launcher, ['context'], { encoding: 'utf8' });
      assert.equal(missing.status, 127);
      assert.match(missing.stderr, /missing from this Codeflare image/);
    });
  });

  it('REQ-AGENT-181: updater overlay fails before mutating a partial source', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'reference/audit.md'), 'incomplete upstream file\n');

    assert.throws(
      () => applyCodeflareImpeccableOverlay(source, { allowAlreadyApplied: true }),
      /audit/i,
    );
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: updater rejects a missing deletion anchor before mutation', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const auditPath = join(source, 'reference/audit.md');
    const before = readFileSync(auditPath, 'utf8');

    assert.throws(() => applyCodeflareImpeccableOverlay(source), /SKILL\.md/);
    assert.equal(readFileSync(auditPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: malformed routing metadata leaves targets unchanged', () => withTempDir((root) => {
    const target = join(root, 'target');
    mkdirSync(target);
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve me\n');

    assert.throws(
      () => replaceImpeccableTargets(join(root, 'source'), 'malformed skill\n', [{
        agent: 'claude',
        root: target,
        runtimePath: '~/.claude/skills/impeccable',
      }]),
      /frontmatter/i,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me\n');
  }));

  it('REQ-AGENT-181: missing mutable package permission leaves targets unchanged', () => withTempDir((root) => {
    const target = join(root, 'target');
    mkdirSync(target);
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve me\n');
    const skill = '---\ndescription: upstream\nallowed-tools:\n  - Bash(node scripts/*)\n---\nbody\n';

    assert.throws(
      () => replaceImpeccableTargets(join(root, 'source'), skill, [{
        agent: 'claude',
        root: target,
        runtimePath: '~/.claude/skills/impeccable',
      }]),
      /mutable package permission/i,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me\n');
  }));
});
