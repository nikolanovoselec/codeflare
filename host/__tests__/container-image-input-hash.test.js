import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'container-image.yml'), 'utf8');
const startMarker = '      - name: Compute image input hash\n';
const endMarker = '\n      - name: Log in to Docker Hub';
const start = workflow.indexOf(startMarker);
const end = workflow.indexOf(endMarker, start);
assert.notEqual(start, -1, 'compute-image-hash step must exist');
assert.notEqual(end, -1, 'compute-image-hash step boundary must exist');
const step = workflow.slice(start + startMarker.length, end);
const runMarker = '        run: |\n';
const runStart = step.indexOf(runMarker);
assert.notEqual(runStart, -1, 'compute-image-hash step must use a shell body');
const hashScript = step.slice(runStart + runMarker.length)
  .split('\n')
  .map((line) => line.startsWith('          ') ? line.slice(10) : line)
  .join('\n');

const root = mkdtempSync(join(tmpdir(), 'container-image-hash-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(relative, content = `${relative}\n`) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(message) {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'ignore' });
}

const bin = join(root, 'bin');
write('bin/date', `#!/bin/sh
case "$*" in
  *%G-W%V*) printf '%s\\n' '2026-W31' ;;
  *) printf '%s\\n' '2026-07-30' ;;
esac
`);
chmodSync(join(bin, 'date'), 0o755);

function imageHashResult(cwd = root, codingAgents = 'claude-code,codex,copilot,antigravity,opencode,pi') {
  const output = join(root, 'github-output');
  writeFileSync(output, '');
  execFileSync('bash', ['-euo', 'pipefail', '-c', hashScript], {
    cwd,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      RAW_CODING_AGENTS: codingAgents,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
    stdio: 'pipe',
  });
  const values = Object.fromEntries(readFileSync(output, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('=', 2)));
  return { tag: values.tag, noReuse: values.no_reuse };
}

describe('deployment container image input hash', () => {
  it('ignores host test-only changes but changes for host production inputs', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'CI'], { cwd: root });

    write('Dockerfile', [
      'COPY host/package.json host/package-lock.json /app/host/',
      'COPY host/tsconfig.json /app/host/',
      'COPY host/src/ /app/host/src/',
      'COPY entrypoint.sh /entrypoint.sh',
      'COPY transcript-retention.mjs /transcript-retention.mjs',
      '',
    ].join('\n'));
    for (const path of [
      '.github/workflows/container-image.yml',
      '.dockerignore',
      '.trivyignore',
      'entrypoint.sh',
      'transcript-retention.mjs',
      'host/package.json',
      'host/package-lock.json',
      'host/tsconfig.json',
      'host/src/index.ts',
      'openvscode/runtime.txt',
      'preseed/runtime.txt',
      'scripts/browser-ide-ui-state.py',
      'scripts/browser-ide-extensions.py',
      'scripts/materialize-agent-seed.mjs',
      'scripts/patch-context-mode-bundles.mjs',
      'scripts/patch-pi-goal-review-control.mjs',
      'scripts/verify-pi-lockstep.mjs',
      'scripts/ci/coding-agent-selection.mjs',
      'scripts/ci/prune-npm-platform-artifacts.mjs',
      'scripts/ci/smoke-openvscode-sidebar-image.mjs',
      'scripts/ci/validate-trivy-result.mjs',
      'src/lib/agent-seed.generated.ts',
    ]) write(path);
    write(
      'scripts/ci/coding-agent-selection.mjs',
      readFileSync(join(ROOT, 'scripts/ci/coding-agent-selection.mjs'), 'utf8'),
    );
    commit('fixture');
    const baseline = imageHashResult();
    assert.match(baseline.tag ?? '', /^in-[a-f0-9]{16}$/);
    assert.equal(baseline.noReuse, '0');
    assert.equal(imageHashResult(ROOT).noReuse, '0', 'the real Dockerfile must remain fully covered');
    assert.notEqual(
      imageHashResult(root, 'claude-code,codex,pi').tag,
      baseline.tag,
      'different installed-agent sets must never reuse the same image',
    );
    assert.equal(
      imageHashResult(root, 'pi, claude-code,codex').tag,
      imageHashResult(root, 'claude-code,codex,pi').tag,
      'equivalent selections must canonicalize to one image identity',
    );

    write('host/__tests__/container-image-input-hash.test.js', 'test only\n');
    commit('test-only change');
    assert.equal(imageHashResult().tag, baseline.tag);

    write('host/src/index.ts', 'production change\n');
    commit('production change');
    const productionTag = imageHashResult().tag;
    assert.notEqual(productionTag, baseline.tag);

    write('scripts/verify-pi-lockstep.mjs', 'image script change\n');
    commit('image script change');
    const scriptTag = imageHashResult().tag;
    assert.notEqual(scriptTag, productionTag);

    write('scripts/patch-pi-goal-review-control.mjs', 'Goal control patch change\n');
    commit('Goal patch change');
    const goalPatchTag = imageHashResult().tag;
    assert.notEqual(goalPatchTag, scriptTag);

    write('scripts/ci/prune-npm-platform-artifacts.mjs', 'pruning change\n');
    commit('pruning change');
    const pruningTag = imageHashResult().tag;
    assert.notEqual(pruningTag, goalPatchTag);

    write('.github/workflows/container-image.yml', 'deployment smoke change\n');
    commit('deployment workflow change');
    assert.notEqual(imageHashResult().tag, pruningTag);

    write('Dockerfile', `${readFileSync(join(root, 'Dockerfile'), 'utf8')}COPY host/__tests__/ /tmp/tests/\n`);
    commit('uncovered copy source');
    assert.equal(imageHashResult().noReuse, '1');
  });
});
