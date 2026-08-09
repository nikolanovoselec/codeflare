import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildReviewPacket, changedInputIntersects } from '../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs';
import {
  attributionBlockReason,
  executableShellCommands,
  shellCommandExecutable,
} from '../../preseed/agents/pi/extensions/guard-helpers.ts';
import { monitorCi } from '../../preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs';

const packetScript = fileURLToPath(new URL(
  '../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs',
  import.meta.url,
));

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const target = join(repo, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'pi-review-workset-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@users.noreply.github.com');
  write(repo, 'src/value.ts', 'export const value = 1;\n');
  write(repo, 'src/value.test.ts', "test('first behavior', () => {\n  expect(value).toBe(1);\n});\n\ntest('second behavior', () => {\n  expect(value).toBe(2);\n});\n");
  write(repo, 'sdd/spec/value.md', '# Value\n');
  write(repo, 'documentation/lanes/value.md', '# Value\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/value.ts', 'export const value = 2;\n');
  write(repo, 'src/value.test.ts', "test('first behavior', () => {\n  expect(value).toBe(2);\n});\n\ntest('second behavior', () => {\n  expect(value).toBe(2);\n});\n");
  write(repo, 'sdd/spec/value.md', '# Value\n\nChanged.\n');
  write(repo, 'documentation/lanes/value.md', '# Value\n\nChanged.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'change');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

test('REQ-AGENT-052/REQ-AGENT-063: Pi structurally finds executable Git across shell composition', () => {
  const executable = (command) => executableShellCommands(command).map(shellCommandExecutable).filter(Boolean);
  assert.deepEqual(executable('if git -C /repo status; then echo "gh pr view"; fi'), ['git', 'echo']);
  assert.deepEqual(executable('printf "%s" "$(gh pr view)"'), ['gh', 'printf']);
  assert.deepEqual(executable("printf '%s' '$(git status)'"), ['printf']);
  assert.deepEqual(executable("cat <<'EOF'\ngit status\nEOF"), ['cat']);
  for (const command of [
    "printf '%s\\n' '<<EOF'\ngit status",
    'printf "%s\\n" "<<EOF"\ngit status',
    'printf "%s\\n" \\<\\<EOF\ngit status',
  ]) {
    assert.deepEqual(executable(command), ['printf', 'git'], command);
  }
  assert.ok(attributionBlockReason('git -C /repo commit -m "Generated with Claude"'));
  assert.ok(attributionBlockReason('env GH_HOST=x gh --repo acme/app pr create --body "Co-Authored-By: bot"'));
});

test('REQ-AGENT-059 AC6: diff packets contain only lane-owned changed hunks', () => {
  const { repo, base, head } = fixture();
  try {
    const range = `${base}..${head}`;
    const code = buildReviewPacket({ repo, scope: 'diff', range, lane: 'code-reviewer' });
    const spec = buildReviewPacket({ repo, scope: 'diff', range, lane: 'spec-reviewer' });
    const docs = buildReviewPacket({ repo, scope: 'diff', range, lane: 'doc-updater' });

    assert.deepEqual(code.files, ['src/value.test.ts', 'src/value.ts']);
    assert.match(code.patch, /src\/value\.ts/);
    assert.doesNotMatch(code.patch, /sdd\/|documentation\//);
    assert.deepEqual(spec.files, ['sdd/spec/value.md']);
    assert.deepEqual(docs.files, ['documentation/lanes/value.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REQ-AGENT-085 AC4/AC5: changed inputs expose exact hunk ranges and enforce intersection', () => {
  const { repo, base, head } = fixture();
  try {
    const packet = buildReviewPacket({ repo, scope: 'diff', range: `${base}..${head}`, lane: 'spec-reviewer' });
    const input = packet.changedInputs.find(({ path }) => path === 'src/value.test.ts');

    assert.deepEqual(input, {
      path: 'src/value.test.ts',
      hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }],
    });
    assert.equal(changedInputIntersects(input, { oldStart: 1, oldEnd: 1 }), false);
    assert.equal(changedInputIntersects(input, { oldStart: 2, oldEnd: 2 }), true);
    assert.equal(changedInputIntersects(input, { newStart: 1, newEnd: 3 }), true);
    assert.equal(changedInputIntersects(input, { newStart: 5, newEnd: 7 }), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REQ-AGENT-085: CLI and module produce identical worksets without persistence', () => {
  const { repo, base, head } = fixture();
  const packetTmp = mkdtempSync(join(tmpdir(), 'pi-review-packet-tmp-'));
  try {
    const range = `${base}..${head}`;
    const expected = buildReviewPacket({ repo, scope: 'diff', range, lane: 'spec-reviewer' });
    const actual = JSON.parse(execFileSync(process.execPath, [
      packetScript,
      '--repo', repo,
      '--scope', 'diff',
      '--range', range,
      '--lane', 'spec-reviewer',
    ], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: packetTmp, TMP: packetTmp, TEMP: packetTmp },
    }));

    assert.deepEqual(actual, expected);
    assert.deepEqual(readdirSync(packetTmp), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(packetTmp, { recursive: true, force: true });
  }
});

test('REQ-AGENT-059 AC7: all scope enumerates the lane tree while diff rejects an invalid range', () => {
  const { repo, base } = fixture();
  try {
    const all = buildReviewPacket({ repo, scope: 'all', lane: 'spec-reviewer' });
    assert.equal(all.workSet, 'whole-requested-tree');
    assert.deepEqual(all.files, ['sdd/spec/value.md']);
    assert.equal(all.patch, '');

    assert.throws(
      () => buildReviewPacket({ repo, scope: 'diff', range: `${'f'.repeat(40)}..${base}`, lane: 'code-reviewer' }),
      /valid ancestor range/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A resolver failure used to reach the reviewer as a packet with no `evidence`
// key, indistinguishable from one never requested -- so a lane whose resolver
// exceeded the bound on every run read as "this lane has no evidence" and
// nothing surfaced it. The reviewer can act on a named reason; it cannot act on
// a key that is simply missing.
test('REQ-AGENT-125 AC3: stable malformed provider rows never become CI success', async () => {
  const head = 'a'.repeat(40);
  let now = 0;
  const runner = async (_command, args) => {
    if (args[1] === 'view') {
      return { stdout: JSON.stringify({ headRefOid: head }), stderr: '', exitCode: 0 };
    }
    return {
      stdout: JSON.stringify([{
        bucket: 'pass',
        link: 'not a URL',
        name: 42,
        state: null,
        workflow: {},
      }]),
      stderr: '',
      exitCode: 0,
    };
  };

  const output = await monitorCi({
    repo: 'owner/repo', pr: 42, head, runner,
    clock: { now: () => now },
    sleep: async (milliseconds) => { now += milliseconds; },
  });

  assert.match(output, /^CI_RESULT timeout/m);
  assert.doesNotMatch(output, /^CI_RESULT success/m);
});

test('REQ-AGENT-109: an evidence failure is named in the packet, not dropped', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'packet-no-resolver-'));
  const script = join(isolated, 'build-review-packet.mjs');
  writeFileSync(script, readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    '../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs',
  ), 'utf8'));

  const { repo, base, head } = fixture();
  const out = execFileSync(process.execPath, [
    script, '--repo', repo, '--scope', 'diff', '--range', `${base}..${head}`,
    '--lane', 'doc-updater', '--with-evidence',
  ], { encoding: 'utf8' });
  const packet = JSON.parse(out);

  assert.equal(packet.evidence, undefined, 'the sibling resolver is absent, so there is no evidence to carry');
  assert.ok(typeof packet.evidenceOmitted === 'string' && packet.evidenceOmitted.length > 0,
    'the packet must name why evidence is missing rather than omit the key silently');
  assert.ok(packet.files, 'and the packet itself must still be usable');
  rmSync(isolated, { recursive: true, force: true });
});
