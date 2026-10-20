import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(ROOT, '.github/workflows/bump-shadow-pins.yml'), 'utf8');
const job = workflow.slice(workflow.indexOf('\n  pi-extensions:\n'));
const apply = job.slice(job.indexOf('      - name: Apply bump'), job.indexOf('      - name: Open PR'));
const body = apply.slice(apply.indexOf('        run: |\n') + '        run: |\n'.length)
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const names = ['rpiv-advisor', 'rpiv-ask-user-question', 'rpiv-todo'];

function runBump(failure, packageName = '@juicesharp/rpiv-advisor') {
  const questionnaireLane = packageName === '@juicesharp/rpiv-ask-user-question';
  const current = questionnaireLane ? '2.12.0' : '1.0.0';
  const candidate = questionnaireLane ? '2.13.8' : '1.0.1';
  const questionnaireVersion = questionnaireLane ? candidate : '2.12.0';
  const home = mkdtempSync(join(tmpdir(), 'rpiv-bump-gate-'));
  const repo = join(home, 'repo'); const remote = join(home, 'remote.git');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    git('remote', 'add', 'origin', remote);
    git('config', `url.file://${remote}.insteadOf`, 'https://x-access-token:fixture@github.com/fixture/repo.git');
    for (const file of ['scripts/patch-rpiv-host-peers.mjs', 'scripts/verify-rpiv-host-peers.mjs',
      'scripts/patch-rpiv-question-timeout.mjs', 'scripts/rpiv-question-timeout.mjs',
      'scripts/ci/smoke-openvscode-sidebar-image.mjs']) {
      mkdirSync(dirname(join(repo, file)), { recursive: true }); cpSync(join(ROOT, file), join(repo, file));
    }
    write(join(repo, 'scripts/regenerate-npm-package-lock.mjs'), '// Registry/install boundary is fixture-owned.\n');
    write(join(repo, 'entrypoint.sh'), 'fixture\n');
    write(join(repo, 'host/__tests__/pi-settings-packages.test.js'), 'fixture\n');
    for (const tree of ['preseed/agents/pi', 'preseed/npm-tools']) {
      write(join(repo, tree, 'package.json'), JSON.stringify({ dependencies: { ...(tree === 'preseed/agents/pi' ? { [packageName]: current } : {}), 'unrelated-agent': '3.0.0' } }, null, tree === 'preseed/npm-tools' ? undefined : 2));
      for (const name of tree === 'preseed/agents/pi' ? names : []) write(join(repo, tree, 'node_modules/@juicesharp', name, 'package.json'),
        JSON.stringify({ name: `@juicesharp/${name}`, dependencies: { typebox: '^1.1.24' } }));
      const sdk = join(repo, tree, 'node_modules/@earendil-works/pi-coding-agent');
      write(join(sdk, 'package.json'), '{"type":"module"}');
      const broken = tree === 'preseed/npm-tools' ? failure : null;
      write(join(sdk, 'dist/index.js'), `export class DefaultResourceLoader {
        async reload() {}
        getExtensions() { return {
          errors: ${JSON.stringify(broken === 'api' ? [{ error: 'changed upstream API' }] : [])},
          warnings: ${JSON.stringify(broken === 'warning' ? [{ warning: 'duplicate host module' }] : [])},
          extensions: [{ tools: new Map(${JSON.stringify((broken === 'tool' ? ['advisor', 'todo'] : ['advisor', 'ask_user_question', 'todo']).map(name => [name, {}]))}) }]
        }; }
      }`);
    }
    // Authentic transforms plus a mocked SDK prove publication gating, not real-SDK compatibility.
    const archive = join(ROOT, `host/__fixtures__/rpiv-ask-user-question-${questionnaireVersion}.tgz`);
    const archiveSha256 = questionnaireLane
      ? '1c27ed656cf56b0af7eb45d1e4240fc3c9e3e064a05880f15acc380893159cd5'
      : 'f407893638f1893a3730444f467b4edc1924cf2d206ae584f7525e1e8ae860f6';
    assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),
      archiveSha256, 'reviewed npm archive integrity contract');
    const questionnaire = join(repo, 'preseed/agents/pi/node_modules/@juicesharp/rpiv-ask-user-question');
    execFileSync('tar', ['-xzf', archive, '-C', questionnaire, '--strip-components=1', '--no-same-owner']);
    if (failure === 'questionnaire') {
      const path = join(questionnaire, 'package.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), version: '2.13.0' }));
    } else if (failure === 'questionnaire-source') {
      const path = join(questionnaire, 'state/questionnaire-session.ts');
      writeFileSync(path, readFileSync(path, 'utf8') + '\n// unreviewed source drift\n');
    }
    git('add', '.'); git('commit', '-m', 'fixture');
    // Exercise the real workflow shell; only registry/install effects are replaced.
    const result = spawnSync('bash', ['-c', `npm() { return 0; }\n${body}`], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PKG: packageName, CUR: current, LAT: candidate,
        BRANCH: 'bump/fixture-rpiv', GH_TOKEN: 'fixture', GITHUB_REPOSITORY: 'fixture/repo' },
    });
    const published = git('ls-remote', 'origin', 'refs/heads/bump/fixture-rpiv').trim();
    const manifests = published ? ['preseed/agents/pi', 'preseed/npm-tools'].map(tree =>
      JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', `refs/heads/bump/fixture-rpiv:${tree}/package.json`], { encoding: 'utf8' }))) : [];
    return { result, published, manifests };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const packageName of names.map(name => `@juicesharp/${name}`)) {
  it(`RPIV bump publishes only after both installation trees pass patched startup (${packageName})`, () => {
    const { result, published, manifests } = runBump(null, packageName);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(published, '');
    assert.deepEqual(manifests.map(manifest => manifest.dependencies), [
      { [packageName]: packageName === '@juicesharp/rpiv-ask-user-question' ? '2.13.8' : '1.0.1', 'unrelated-agent': '3.0.0' },
      { 'unrelated-agent': '3.0.0' },
    ], 'the published candidate belongs to the extension tree; shared SDK startup must not require a duplicate installation');
  });

  for (const failure of ['api', 'warning', 'tool', 'questionnaire', 'questionnaire-source']) {
    it(`RPIV bump leaves the remote branch absent when shared startup fails: ${failure} (${packageName})`, () => {
      const { result, published } = runBump(failure, packageName);
      assert.notEqual(result.status, 0);
      assert.equal(published, '', 'an incompatible candidate must never reach the remote');
    });
  }
}
