import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('../../preseed/agents/claude/skills/turnstile-spin/scripts/persist-skill.sh', import.meta.url));
const skillBody = '# Canonical skill fixture\n';
const target = '.claude/skills/turnstile-spin/SKILL.md';

function persistenceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'turnstile-persistence-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const canonical = join(root, 'canonical');
  const temporary = join(root, 'temporary');
  const globalConfig = join(root, 'gitconfig');
  for (const directory of [project, temporary, join(canonical, 'skills/turnstile-spin/scripts')]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(canonical, 'skills/turnstile-spin/SKILL.md'), skillBody);
  writeFileSync(join(canonical, 'skills/turnstile-spin/scripts/fixture.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: temporary,
  };
  const git = (args) => execFileSync('git', args, { cwd: project, env, stdio: 'pipe', timeout: 10_000 });
  git(['init', '--quiet', canonical]);
  git(['-C', canonical, 'add', '.']);
  git(['-C', canonical, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Canonical fixture']);
  git(['config', '--file', globalConfig, `url.${pathToFileURL(canonical).href}.insteadOf`,
    'https://github.com/cloudflare/skills.git']);
  return {
    project,
    temporary,
    run: () => spawnSync('bash', [script, '--path', target], {
      cwd: project, env, encoding: 'utf8', timeout: 10_000,
    }),
  };
}

it('REQ-AGENT-138 AC3/AC4: skill persistence reports copy errors and cleans its temporary clone', (t) => {
  const fixture = persistenceFixture(t);
  // A file where the destination parent must be a directory makes the real copy fail, including as root.
  writeFileSync(join(fixture.project, '.claude'), 'Existing project file must remain unchanged.\n');
  const result = fixture.run();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'A failed bundle copy must not report successful persistence');
  // Intentional public error wire contract; do not assert Python diagnostics or implementation calls.
  assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'error', reason: 'copy_failed' });
  assert.equal(readFileSync(join(fixture.project, '.claude'), 'utf8'), 'Existing project file must remain unchanged.\n');
  assert.deepEqual(readdirSync(fixture.temporary), [], 'The temporary clone must be removed after copy failure');
});

it('REQ-AGENT-138 AC3: successful skill persistence installs the bundle and cleans its temporary clone', (t) => {
  const fixture = persistenceFixture(t);
  const result = fixture.run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.path, target);
  assert.deepEqual(receipt.scripts, ['fixture.sh']);
  assert.equal(readFileSync(join(fixture.project, target), 'utf8'), skillBody);
  assert.notEqual(statSync(join(fixture.project, '.claude/skills/turnstile-spin/scripts/fixture.sh')).mode & 0o111, 0);
  assert.deepEqual(readdirSync(fixture.temporary), [], 'The temporary clone must be removed after success');
});
