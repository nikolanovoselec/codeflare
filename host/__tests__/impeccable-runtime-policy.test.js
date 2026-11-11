import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyCodeflareImpeccableOverlay,
  replaceImpeccableTargets,
  updateImpeccableSkill,
  verifyReviewedImpeccableBundle,
} from '../../scripts/update-impeccable-skill.mjs';
import { managedImpeccableLauncher } from '../../scripts/impeccable-launcher.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repoRoot, 'preseed/agents/claude/skills/impeccable');

function copyReviewedFixture(skillVersion, destination) {
  if (skillVersion === '4.8.2') {
    // Compatibility fixture, not a complete 4.8.2 artifact: policy references
    // are byte-identical to 4.8.0. Retain its browser command anchors and
    // launcher placeholders (replaced wholesale); reconstruct the actual
    // candidate SKILL.md bytes and engine requirement from the reviewed ZIP.
    copyReviewedFixture('4.8.0', destination);
    const skillPath = join(destination, 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8')
      .replace(/^description:.*$/m, 'description: "Use to design, redesign, critique, audit, polish or animate a frontend: websites, landing pages, dashboards, app UI, components, native iOS/Android screens, or a design system (DESIGN.md)."')
      .replace('version: 4.8.0\n', 'version: 4.8.2\n');
    assert.equal(createHash('sha256').update(skill).digest('hex'), '637b7b727122a273912454e6c7c2d7775186eb0c3c379c2a7c13bec595c61619');
    writeFileSync(skillPath, skill);
    writeFileSync(join(destination, 'scripts/VERSION'), '0.1.21\n');
    return;
  }
  if (skillVersion !== '4.8.0') {
    cpSync(join(repoRoot, `host/__fixtures__/impeccable-${skillVersion}`), destination, { recursive: true });
    return;
  }
  const capture = readFileSync(join(repoRoot, 'host/__fixtures__/impeccable-4.8.0-source.json'));
  // Immutable fixture contract: compact byte deltas retain the real release
  // inputs without duplicating its half-megabyte browser client on disk.
  assert.equal(createHash('sha256').update(capture).digest('hex'), '920d9b5f81c0e7c5e1083c068910e9e80d291018ecd5a9776eb88c2da7d95ff5');
  const fixture = JSON.parse(capture);
  assert.equal(fixture.bundleSha256, '82e6f6ff3a2b18f46f0f2fc388c1ab7abf3ccc52bbfc522456396d13011d6706');
  for (const [name, file] of Object.entries(fixture.files)) {
    const base = join(repoRoot, 'host/__fixtures__', fixture.baseFixture, name);
    let bytes = readFileSync(base);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.baseSha256, name);
    for (const change of [...file.changes].reverse()) {
      assert.ok(Number.isSafeInteger(change.start) && Number.isSafeInteger(change.end)
        && change.start >= 0 && change.end >= change.start && change.end <= bytes.length);
      bytes = Buffer.concat([bytes.subarray(0, change.start), Buffer.from(change.text), bytes.subarray(change.end)]);
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, name);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(base, target);
    writeFileSync(target, bytes);
  }
}



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

  for (const [skillVersion, engineVersion] of [['4.3.1', '0.1.5'], ['4.4.0', '0.1.10'], ['4.5.0', '0.1.11'], ['4.6.0', '0.1.15'], ['4.7.0', '0.1.16'], ['4.8.0', '0.1.18'], ['4.8.2', '0.1.21']]) {
    it(`REQ-AGENT-181: reviewed ${skillVersion} dispatches only to its matching image engine ${engineVersion}`, () => withTempDir(root => {
      const source = join(root, 'source');
      copyReviewedFixture(skillVersion, source);
      applyCodeflareImpeccableOverlay(source);
      applyCodeflareImpeccableOverlay(source, { allowAlreadyApplied: true });
      const targets = ['claude', 'pi'].map(agent => ({ agent, root: join(root, agent),
        runtimePath: agent === 'claude' ? '~/.claude/skills/impeccable' : '~/.pi/agent/skills/impeccable' }));
      replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), targets);
      const engines = join(root, 'engines');
      for (const otherVersion of ['0.1.5', '0.1.10', '0.1.11', '0.1.15', '0.1.16', '0.1.18', '0.1.21'].filter(version => version !== engineVersion)) {
        const other = join(engines, otherVersion, 'impeccable');
        mkdirSync(dirname(other), { recursive: true });
        writeFileSync(other, '#!/bin/sh\necho incorrect-fallback\n', { mode: 0o755 });
      }
      const pinName = skillVersion === '4.8.2' ? 'impeccable-engine.json'
        : skillVersion === '4.3.1' ? 'impeccable-engine-legacy.json' : `impeccable-engine-${skillVersion}.json`;
      const pin = JSON.parse(readFileSync(join(repoRoot, 'image', pinName), 'utf8'));
      // Model the engine provided by the real image pin, not just the expected
      // launcher mapping. A changed/missing compatibility pin must fail dispatch.
      const engine = join(engines, pin.version, 'impeccable');
      mkdirSync(dirname(engine), { recursive: true });
      writeFileSync(engine, `#!/bin/sh\nprintf '%s\\n' '${engineVersion}' "$IMPECCABLE_SKILL_DIR" "$IMPECCABLE_SELF" "$@"\n`, { mode: 0o755 });
      for (const target of targets) {
        const launcher = join(target.root, 'scripts/impeccable');
        writeFileSync(launcher, managedImpeccableLauncher(engines), { mode: 0o755 });
        chmodSync(launcher, 0o755);
        const result = spawnSync(launcher, ['context', '--target', 'a file.ts'], {
          encoding: 'utf8', env: { ...process.env, IMPECCABLE_BIN: '/does/not/exist' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split('\n'), [engineVersion, target.root, launcher, 'context', '--target', 'a file.ts']);
        for (const command of ['install', 'update', 'uninstall', 'link']) {
          for (const args of [[command], ['skills', command]]) {
            const denied = spawnSync(launcher, args, { encoding: 'utf8' });
            assert.equal(denied.status, 1);
            assert.equal(denied.stdout, '');
            assert.match(denied.stderr, /image-owned/);
          }
        }
      }
      rmSync(engine);
      for (const target of targets) {
        const missing = spawnSync(join(target.root, 'scripts/impeccable'), ['context'], { encoding: 'utf8' });
        assert.equal(missing.status, 127);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /missing from this Codeflare image/);
      }
    }));
  }

  it('REQ-AGENT-181: unreviewed native engine fails before source mutation', () => withTempDir((source) => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.4\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /engine version/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.5.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.5.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.10\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.11/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.6.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.6.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.11\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.15/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.7.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.7.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.15\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.16/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.8.0 rejects retained older engines before any overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.8.0', source);
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.16\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.18/);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.8.2 rejects the current image engine before any overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.8.2', source);
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.18\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.21/);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181 / REQ-AGENT-194: 4.8.0 projection retains version and redistribution license/notices', () => withTempDir(root => {
    const source = join(root, 'source');
    copyReviewedFixture('4.8.0', source);
    applyCodeflareImpeccableOverlay(source);
    const target = join(root, 'projected');
    replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), [{
      agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
    }]);
    const skill = readFileSync(join(target, 'SKILL.md'), 'utf8');
    assert.match(skill, /version: 4\.8\.0/);
    for (const name of ['LICENSE', 'NOTICE.md']) {
      assert.equal(readFileSync(join(target, name), 'utf8'), readFileSync(join(repoRoot, 'host/__fixtures__/impeccable-4.7.0', name), 'utf8'),
        'the reviewed redistribution license/notices remain present');
    }
  }));

  it('REQ-OPS-020 / REQ-AGENT-181: an unreviewed bundle identity or substituted bytes fail closed', async () => {
    for (const version of ['4.8.0', '4.8.2']) {
      assert.throws(() => verifyReviewedImpeccableBundle(Buffer.from('substituted release'), version), /differs from the reviewed release/);
    }
    assert.throws(() => verifyReviewedImpeccableBundle(Buffer.from('unreviewed release'), '4.8.1'), /bundle is not reviewed/);
    await assert.rejects(updateImpeccableSkill('4.8.1'), /bundle is not reviewed/);
    await assert.rejects(updateImpeccableSkill('__proto__'), /bundle is not reviewed/);
  });

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
