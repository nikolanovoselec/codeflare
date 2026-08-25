import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CHANGED_COVERAGE_LIMITS, evaluateChangedLineCoverage } from '../../scripts/ci/check-coverage-result.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const load = (name) => parseYaml(readFileSync(join(WORKFLOWS, name), 'utf8'));
const deploy = load('deploy.yml');
const stress = load('stress-test.yml');
const fuzz = load('fuzz.yml');
const pentest = load('pentest.yml');
const promotion = load('promotion-source.yml');
const release = load('sign-release.yml');
const prChecks = load('test.yml');
const coverageAction = parseYaml(readFileSync(join(ROOT, '.github', 'actions', 'merge-coverage', 'action.yml'), 'utf8'));

const step = (job, name) => job.steps.find((candidate) => candidate.name === name);

describe('deployment workflow safety', () => {
  it('queues same-environment deployments instead of cancelling a mutating run', () => {
    assert.match(deploy.concurrency.group, /deploy-/);
    assert.equal(deploy.concurrency['cancel-in-progress'], false);
  });

  it('wires deployment to the behaviorally tested service-user seed boundary', () => {
    const seed = step(deploy.jobs.deploy, 'Seed service user in KV (stress-test identity, optional)');
    assert.equal(seed.run, 'scripts/ci/seed-service-user.sh');
    assert.deepEqual(Object.keys(seed.env).sort(), [
      'CF_ACCESS_CLIENT_SECRET',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'OAUTH_E2E_TEST_SECRET',
    ]);
  });

  it('limits stress setup to probe credentials and validated target steps', () => {
    const setup = stress.jobs.setup;
    assert.deepEqual(Object.keys(setup.env).sort(), [
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'OAUTH_E2E_TEST_SECRET',
    ]);
    assert.deepEqual(setup.steps.map((candidate) => candidate.name ?? candidate.uses), [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'Resolve target',
      'Smoke test',
    ]);
    const resolve = step(setup, 'Resolve target');
    assert.equal(resolve.run, 'node scripts/ci/normalize-https-origin.mjs "$RAW_BASE" base_url');
    assert.equal(setup.outputs.base_url, '${{ steps.target.outputs.base_url }}');
    assert.equal(step(setup, 'Smoke test').env.E2E_BASE_URL, '${{ steps.target.outputs.base_url }}');
  });
});

describe('PR lane selection', () => {
  it('REQ-OPS-045 AC4: runs landing verification when the shared design-ready gate changes', () => {
    const filterStep = prChecks.jobs.changes.steps.find((candidate) => candidate.id === 'filter');
    const filters = parseYaml(filterStep.with.filters);
    const source = 'src/lib/design-ready.ts';
    const matchesSource = (pattern) => pattern === source
      || (pattern.endsWith('/**') && source.startsWith(pattern.slice(0, -2)));
    assert.ok(filters.backend.flat(Infinity).some(matchesSource));
    assert.ok(filters.landing.flat(Infinity).some(matchesSource));
  });
});

describe('REQ-OPS-045 AC5 + AC6: immutable PR Checks tool cache', () => {
  const cacheAction = 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
  const fixture = 'verified archive fixture';
  const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
  const cases = [
    {
      name: 'zizmor',
      job: 'workflow-audit',
      cache: 'Cache zizmor archive',
      install: 'Run zizmor (checksum-pinned binary)',
      key: '${{ runner.os }}-${{ runner.arch }}-zizmor-${{ steps.zizmor-pin.outputs.version }}-${{ steps.zizmor-pin.outputs.sha256 }}',
      env: (archive) => ({
        ZIZMOR_VERSION: 'test',
        ZIZMOR_SHA256: fixtureSha256,
        ZIZMOR_ARCHIVE: archive,
        GH_TOKEN: 'test',
      }),
    },
    {
      name: 'actionlint',
      job: 'workflow-audit',
      cache: 'Cache actionlint archive',
      install: 'Run actionlint (checksum-pinned binary)',
      key: '${{ runner.os }}-${{ runner.arch }}-actionlint-${{ steps.actionlint-pin.outputs.version }}-${{ steps.actionlint-pin.outputs.sha256 }}',
      env: (archive) => ({
        ACTIONLINT_VERSION: 'test',
        ACTIONLINT_SHA256: fixtureSha256,
        ACTIONLINT_ARCHIVE: archive,
        SHELLCHECK_OPTS: '--severity=error',
      }),
    },
    {
      name: 'rclone',
      job: 'host-tests',
      cache: 'Cache rclone archive',
      install: 'Install rclone for sync-filter behavioral tests',
      key: '${{ runner.os }}-${{ runner.arch }}-rclone-v1.73.5-932cf4b7484de74d82b4875488e0009469fd21f9904673385184520fe11a1bf0',
      env: (archive) => ({
        RCLONE_RELEASE_VERSION: 'test',
        RCLONE_SHA256: fixtureSha256,
        RCLONE_ARCHIVE: archive,
      }),
    },
  ];

  const writeCommand = (directory, name, body) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };

  const prepareCommands = (root) => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeCommand(bin, 'curl', `
      printf 'download\\n' >> "$EVENT_LOG"
      output=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '-o' ]; then shift; output="$1"; fi
        shift
      done
      printf '%s' "$FIXTURE" > "$output"
    `);
    writeCommand(bin, 'gh', 'printf \'attest\\n\' >> "$EVENT_LOG"');
    writeCommand(bin, 'tar', `
      printf 'extract\\n' >> "$EVENT_LOG"
      for argument in "$@"; do target="$argument"; done
      printf '#!/bin/sh\\nprintf "execute\\\\n" >> "$EVENT_LOG"\\n' > "/tmp/$target"
      chmod 0755 "/tmp/$target"
    `);
    writeCommand(bin, 'unzip', `
      printf 'extract\\n' >> "$EVENT_LOG"
      destination=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '-d' ]; then shift; destination="$1"; fi
        shift
      done
      binary="$destination/rclone-v\${RCLONE_RELEASE_VERSION}-linux-amd64/rclone"
      mkdir -p "$(dirname "$binary")"
      cat > "$binary" <<'RCLONE_FIXTURE'
#!/bin/sh
set -eu
if [ "\${RCLONE_VERSION+x}" = x ]; then exit 91; fi
printf 'execute\\n' >> "$EVENT_LOG"
RCLONE_FIXTURE
      chmod 0755 "$binary"
    `);
    writeCommand(bin, 'sudo', `
      printf 'install\\n' >> "$EVENT_LOG"
      if [ "$#" -ne 5 ] || [ "$1" != install ] || [ "$2" != -m ] \\
        || [ "$3" != 0755 ] || [ "$5" != /usr/local/bin/rclone ]; then
        exit 64
      fi
      cp "$4" "$INSTALLED_RCLONE"
      chmod "$3" "$INSTALLED_RCLONE"
    `);
    writeCommand(bin, 'rclone', 'exec "$INSTALLED_RCLONE" "$@"');
    writeCommand(bin, 'apt-get', 'printf \'apt-get\\n\' >> "$EVENT_LOG"; exit 99');
    return bin;
  };

  const runInstaller = ({ tool, archive, root, bin }) => {
    const install = step(prChecks.jobs[tool.job], tool.install);
    const workflowEnv = Object.fromEntries(
      Object.entries(install.env ?? {}).map(([key, value]) => [key, String(value)]),
    );
    const env = {
      ...process.env,
      ...workflowEnv,
      ...tool.env(archive),
      PATH: `${bin}:${process.env.PATH}`,
      EVENT_LOG: join(root, 'events.log'),
      FIXTURE: fixture,
      INSTALLED_RCLONE: join(root, 'installed-rclone'),
      RUNNER_TEMP: join(root, 'runner-temp'),
    };
    if (!Object.hasOwn(workflowEnv, 'RCLONE_VERSION')) delete env.RCLONE_VERSION;

    return spawnSync('bash', ['-c', install.run], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
  };

  it('uses exact platform and integrity cache identities without rclone environment collisions', () => {
    for (const tool of cases) {
      const cache = step(prChecks.jobs[tool.job], tool.cache);
      assert.equal(cache.uses, cacheAction, tool.name);
      assert.equal(cache.with.key, tool.key, tool.name);
      assert.match(cache.with.path, /\$\{\{ runner\.tool_cache \}\}/, tool.name);
    }

    const rclone = step(prChecks.jobs['host-tests'], 'Install rclone for sync-filter behavioral tests');
    assert.equal(rclone.env.RCLONE_VERSION, undefined);
    assert.equal(rclone.env.RCLONE_RELEASE_VERSION, '1.73.5');
  });

  it('REQ-OPS-045 AC5: downloads a missing archive once and reuses the valid archive', () => {
    for (const tool of cases) {
      const root = mkdtempSync(join(tmpdir(), `codeflare-${tool.name}-cache-`));
      try {
        mkdirSync(join(root, 'runner-temp'));
        const bin = prepareCommands(root);
        const archive = join(root, `${tool.name}.archive`);
        const events = join(root, 'events.log');

        const miss = runInstaller({ tool, archive, root, bin });
        assert.equal(miss.status, 0, `${tool.name} miss: ${miss.stderr}`);
        assert.match(readFileSync(events, 'utf8'), /^download\n(?:attest\n)?extract\n(?:install\n)?execute\n$/);

        writeFileSync(events, '');
        const hit = runInstaller({ tool, archive, root, bin });
        assert.equal(hit.status, 0, `${tool.name} hit: ${hit.stderr}`);
        assert.match(readFileSync(events, 'utf8'), /^(?:attest\n)?extract\n(?:install\n)?execute\n$/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(`/tmp/${tool.name}`, { force: true });
      }
    }
  });

  it('REQ-OPS-045 AC6: rejects a corrupted restored archive before extraction or execution', () => {
    for (const tool of cases) {
      const root = mkdtempSync(join(tmpdir(), `codeflare-${tool.name}-corrupt-`));
      try {
        mkdirSync(join(root, 'runner-temp'));
        const bin = prepareCommands(root);
        const archive = join(root, `${tool.name}.archive`);
        const events = join(root, 'events.log');
        writeFileSync(archive, 'corrupted');
        writeFileSync(events, '');

        const result = runInstaller({ tool, archive, root, bin });
        assert.notEqual(result.status, 0, tool.name);
        assert.equal(readFileSync(events, 'utf8'), '', tool.name);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(`/tmp/${tool.name}`, { force: true });
      }
    }
  });
});

describe('least-privilege workflow boundaries', () => {
  it('grants no repository permission to the source-policy check', () => {
    assert.deepEqual(promotion.permissions, {});
  });

  it('grants pentest source access only to jobs that check out scripts', () => {
    assert.deepEqual(pentest.permissions, {});
    assert.deepEqual(pentest.jobs.target.permissions, { contents: 'read' });
    assert.deepEqual(pentest.jobs.tls.permissions, { contents: 'read' });
    for (const name of ['security-headers', 'auth-gate', 'info-disclosure', 'injection', 'http-methods']) {
      assert.equal(pentest.jobs[name].permissions, undefined, name);
    }
  });

  it('exposes the release token only to steps that invoke GitHub release APIs', () => {
    const job = release.jobs.sign;
    assert.equal(job.env?.GH_TOKEN, undefined);
    assert.equal(step(job, 'Validate release source').env.GH_TOKEN, '${{ github.token }}');
    assert.equal(step(job, 'Upload signed release assets').env.GH_TOKEN, '${{ github.token }}');
    for (const name of ['Build deterministic release archive', 'Install Cosign', 'Sign release assets', 'Attest release assets']) {
      assert.equal(step(job, name).env?.GH_TOKEN, undefined, name);
    }
  });
});

describe('REQ-OPS-022 AC6: bounded changed-production-line LCOV gate', () => {
  const productionDiff = (path, range = '1,5') => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${range} @@`,
    '+changed',
  ].join('\n');
  const lcov = (path, hits) => [
    'TN:',
    `SF:${path}`,
    ...hits.map(([line, count]) => `DA:${line},${count}`),
    'end_of_record',
  ].join('\n');

  it('REQ-OPS-022 AC6: accepts a practical 80% changed-line floor without requiring 100%', () => {
    const result = evaluateChangedLineCoverage({
      diff: productionDiff('src/example.ts'),
      lcov: lcov('src/example.ts', [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0]]),
      packageRoot: '.',
      threshold: 80,
    });

    assert.equal(result.ok, true);
    assert.equal(result.covered, 4);
    assert.equal(result.total, 5);
    assert.equal(result.percentage, 80);
  });

  it('REQ-OPS-022 AC6: fails when changed executable production lines fall below the package floor', () => {
    const result = evaluateChangedLineCoverage({
      diff: productionDiff('web-ui/src/example.tsx', '10,2'),
      lcov: lcov('web-ui/src/example.tsx', [[10, 1], [11, 0]]),
      packageRoot: 'web-ui',
      threshold: 70,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /50%.*70%/);
  });

  it('REQ-OPS-022 AC6: uses the destination path and changed destination lines for a rename', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -4 +4 @@',
      '-old()',
      '+updated()',
    ].join('\n');
    const result = evaluateChangedLineCoverage({
      diff,
      lcov: lcov('src/new.ts', [[4, 1]]),
      packageRoot: '.',
      threshold: 80,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ['src/new.ts']);
  });

  it('REQ-OPS-022 AC6: treats deletions and test-only changes as having no changed production evidence', () => {
    const deletion = [
      'diff --git a/src/retired.ts b/src/retired.ts',
      'deleted file mode 100644',
      '--- a/src/retired.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-retired()',
    ].join('\n');
    const testOnly = productionDiff('src/__tests__/example.test.ts');

    assert.equal(evaluateChangedLineCoverage({ diff: deletion, lcov: null, packageRoot: '.', threshold: 80 }).ok, true);
    assert.equal(evaluateChangedLineCoverage({ diff: testOnly, lcov: null, packageRoot: '.', threshold: 80 }).ok, true);
  });

  it('REQ-OPS-022 AC6: fails closed on missing, malformed, or file-incomplete LCOV required by a production change', () => {
    const diff = productionDiff('src/example.ts');
    const cases = [
      null,
      'SF:src/example.ts\nDA:not-a-line\nend_of_record',
      lcov('src/different.ts', [[1, 1]]),
    ];

    for (const evidence of cases) {
      const result = evaluateChangedLineCoverage({ diff, lcov: evidence, packageRoot: '.', threshold: 80 });
      assert.equal(result.ok, false);
    }
  });

  it('REQ-OPS-022 AC6: fails closed when the bounded diff or LCOV input limit is exceeded', () => {
    const diff = `${productionDiff('src/example.ts')}\n${'x'.repeat(300)}`;
    const report = `${lcov('src/example.ts', [[1, 1]])}\n${'x'.repeat(300)}`;

    assert.equal(evaluateChangedLineCoverage({ diff, lcov: report, packageRoot: '.', threshold: 80, maxDiffBytes: 100 }).ok, false);
    assert.equal(evaluateChangedLineCoverage({ diff: productionDiff('src/example.ts'), lcov: report, packageRoot: '.', threshold: 80, maxLcovBytes: 100 }).ok, false);
  });

  it('REQ-OPS-022 AC6: checks the exact base tree in a shallow checkout without a merge base', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'coverage-shallow-'));
    const source = join(fixture, 'source');
    const origin = join(fixture, 'origin.git');
    const checkout = join(fixture, 'checkout');
    const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

    try {
      mkdirSync(join(source, 'src'), { recursive: true });
      assert.equal(git(source, ['init', '--initial-branch=review']).status, 0);
      assert.equal(git(source, ['config', 'user.name', 'Coverage Test']).status, 0);
      assert.equal(git(source, ['config', 'user.email', 'coverage@example.invalid']).status, 0);
      writeFileSync(join(source, 'src/example.ts'), 'export const value = 1;\n');
      assert.equal(git(source, ['add', 'src/example.ts']).status, 0);
      assert.equal(git(source, ['commit', '-m', 'base']).status, 0);
      const base = git(source, ['rev-parse', 'HEAD']).stdout.trim();

      writeFileSync(join(source, 'src/example.ts'), 'export const value = 2;\n');
      assert.equal(git(source, ['commit', '-am', 'head']).status, 0);
      assert.equal(git(fixture, ['init', '--bare', origin]).status, 0);
      assert.equal(git(source, ['remote', 'add', 'origin', origin]).status, 0);
      assert.equal(git(source, ['push', 'origin', 'HEAD:refs/heads/review']).status, 0);
      assert.equal(git(fixture, ['clone', '--depth=1', '--branch=review', `file://${origin}`, checkout]).status, 0);
      assert.notEqual(git(checkout, ['cat-file', '-e', `${base}^{commit}`]).status, 0);

      const fetchBase = coverageAction.runs.steps.find((candidate) => candidate.name === 'Fetch changed-line base commit');
      const fetched = spawnSync('bash', ['-c', fetchBase.run], {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...process.env, CHANGED_BASE: base },
      });
      assert.equal(fetched.status, 0, fetched.stderr);
      assert.equal(git(checkout, ['cat-file', '-e', `${base}^{commit}`]).status, 0);
      assert.notEqual(git(checkout, ['merge-base', base, 'HEAD']).status, 0);

      const log = join(checkout, 'coverage.log');
      const report = join(checkout, 'lcov.info');
      writeFileSync(log, 'All files | 100 | 100 | 100 | 100 |\n');
      writeFileSync(report, 'SF:src/example.ts\nDA:1,1\nend_of_record\n');
      const checked = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/ci/check-coverage-result.mjs'), log, '0', 'false', report, base, '.', '80'],
        { cwd: checkout, encoding: 'utf8' },
      );

      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stdout, /changed production line coverage 100%/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-022 AC6: excludes generated TypeScript before buffering the package source diff', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'coverage-artifact-'));
    const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

    try {
      mkdirSync(join(fixture, 'src'), { recursive: true });
      assert.equal(git(fixture, ['init', '--initial-branch=review']).status, 0);
      assert.equal(git(fixture, ['config', 'user.name', 'Coverage Test']).status, 0);
      assert.equal(git(fixture, ['config', 'user.email', 'coverage@example.invalid']).status, 0);
      writeFileSync(join(fixture, 'src/example.ts'), 'export const value = 1;\n');
      assert.equal(git(fixture, ['add', '.']).status, 0);
      assert.equal(git(fixture, ['commit', '-m', 'base']).status, 0);
      const base = git(fixture, ['rev-parse', 'HEAD']).stdout.trim();

      // One changed production line beside a regenerated artifact whose own diff is larger
      // than the checker's entire diff bound. The evaluator can never consult that file, so
      // buffering it only cost the job its budget: the whole-repository request died with
      // ENOBUFS and reported it as an unreadable pull-request diff.
      writeFileSync(join(fixture, 'src/example.ts'), 'export const value = 2;\n');
      mkdirSync(join(fixture, 'src/lib'), { recursive: true });
      const artifact = 'export const generated = "payload";\n'.repeat(400_000);
      writeFileSync(join(fixture, 'src/lib/agent-seed.generated.ts'), artifact);
      assert.equal(git(fixture, ['add', '.']).status, 0);
      assert.equal(git(fixture, ['commit', '-m', 'head']).status, 0);
      // Measured from what was written rather than from a second `git diff`: reading a diff
      // this size back through spawnSync is the exact failure under test, so the guard would
      // truncate at ENOBUFS and trip on itself before reaching the assertion it exists for.
      assert.ok(
        artifact.length > CHANGED_COVERAGE_LIMITS.maxDiffBytes,
        `fixture artifact must exceed the ${CHANGED_COVERAGE_LIMITS.maxDiffBytes}-byte bound, got ${artifact.length}`,
      );

      const log = join(fixture, 'coverage.log');
      const report = join(fixture, 'lcov.info');
      writeFileSync(log, 'All files | 100 | 100 | 100 | 100 |\n');
      writeFileSync(report, 'SF:src/example.ts\nDA:1,1\nend_of_record\n');
      const checked = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/ci/check-coverage-result.mjs'), log, '0', 'false', report, base, '.', '80'],
        { cwd: fixture, encoding: 'utf8' },
      );

      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stdout, /changed production line coverage 100%/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-022 AC6: enforces the floor for a package rooted below the repository root', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'coverage-package-root-'));
    const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

    try {
      mkdirSync(join(fixture, 'web-ui/src'), { recursive: true });
      assert.equal(git(fixture, ['init', '--initial-branch=review']).status, 0);
      assert.equal(git(fixture, ['config', 'user.name', 'Coverage Test']).status, 0);
      assert.equal(git(fixture, ['config', 'user.email', 'coverage@example.invalid']).status, 0);
      writeFileSync(join(fixture, 'web-ui/src/example.ts'), 'export const first = 1;\nexport const second = 1;\n');
      assert.equal(git(fixture, ['add', '.']).status, 0);
      assert.equal(git(fixture, ['commit', '-m', 'base']).status, 0);
      const base = git(fixture, ['rev-parse', 'HEAD']).stdout.trim();

      writeFileSync(join(fixture, 'web-ui/src/example.ts'), 'export const first = 2;\nexport const second = 2;\n');
      assert.equal(git(fixture, ['commit', '-am', 'head']).status, 0);

      const log = join(fixture, 'web-ui/coverage.log');
      const report = join(fixture, 'web-ui/lcov.info');
      writeFileSync(log, 'All files | 100 | 100 | 100 | 100 |\n');
      // Both changed lines are production lines; only the first is covered.
      writeFileSync(report, 'SF:web-ui/src/example.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
      // Run from the package directory, which is where the composite action puts the
      // checker. A package-relative pathspec would resolve under web-ui/web-ui here, match
      // nothing, and report a clean 100% instead of the miss below.
      const checked = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/ci/check-coverage-result.mjs'), log, '0', 'false', report, base, 'web-ui', '80'],
        { cwd: join(fixture, 'web-ui'), encoding: 'utf8' },
      );

      assert.equal(checked.status, 1);
      assert.match(checked.stderr, /changed production line coverage 50% is below the 80% package floor \(1\/2\)/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-022 AC6: fails when fetch succeeds without resolving the exact base commit', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'coverage-unresolved-base-'));
    const fakeBin = join(fixture, 'bin');
    const gitLog = join(fixture, 'git.log');
    const base = '0123456789abcdef0123456789abcdef01234567';

    try {
      mkdirSync(fakeBin);
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$FAKE_GIT_LOG"',
        '[ "$1" = "fetch" ] && exit 0',
        '[ "$1" = "cat-file" ] && exit 1',
        'exit 99',
        '',
      ].join('\n'));
      chmodSync(fakeGit, 0o755);

      const fetchBase = coverageAction.runs.steps.find((candidate) => candidate.name === 'Fetch changed-line base commit');
      const fetched = spawnSync('/bin/bash', ['-c', fetchBase.run], {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          CHANGED_BASE: base,
          FAKE_GIT_LOG: gitLog,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      });

      assert.equal(fetched.status, 1);
      assert.equal(fetched.stdout, '::error::unable to resolve the exact changed-base commit\n');
      assert.equal(fetched.stderr, '');
      assert.deepEqual(readFileSync(gitLog, 'utf8').trim().split('\n'), [
        `cat-file -e ${base}^{commit}`,
        `fetch --no-tags --depth=1 origin ${base}`,
        `cat-file -e ${base}^{commit}`,
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-022 AC5/AC6: merges affected package matrix coverage with package-specific changed-line floors', () => {
    for (const [jobName, matrixJob, inputs] of [
      ['coverage-backend', 'backend-tests', {
        'artifact-pattern': 'backend-shard-*',
        'artifact-prefix': 'backend-shard',
        'expected-shards': '3',
        slug: 'backend',
        'package-root': '.',
        'changed-base': '${{ github.event.pull_request.base.sha }}',
        'changed-line-threshold': '80',
        'statements-threshold': '88',
        'branches-threshold': '80',
        'functions-threshold': '89',
        'lines-threshold': '89',
      }],
      ['coverage-frontend', 'frontend-tests', {
        'artifact-pattern': 'frontend-shard-*',
        'artifact-prefix': 'frontend-shard',
        'expected-shards': '3',
        slug: 'frontend',
        'package-root': 'web-ui',
        'changed-base': '${{ github.event.pull_request.base.sha }}',
        'changed-line-threshold': '70',
        'statements-threshold': '75',
        'branches-threshold': '63',
        'functions-threshold': '75',
        'lines-threshold': '77',
      }],
    ]) {
      const job = prChecks.jobs[jobName];
      assert.deepEqual(job.needs, ['changes', matrixJob]);
      assert.deepEqual(
        job.steps.filter((candidate) => candidate.uses === './.github/actions/merge-coverage'),
        [{ uses: './.github/actions/merge-coverage', with: inputs }],
      );
    }
  });
});

describe('shared CI components', () => {
  it('installs every fuzz package tree before its corresponding suite', () => {
    const steps = fuzz.jobs.fuzz.steps;
    const installs = steps.filter((candidate) => candidate.uses === './.github/actions/install-deps');
    assert.deepEqual(installs.map((candidate) => candidate.with), [
      { directory: '.', 'key-prefix': 'fuzz-root' },
      { directory: 'web-ui', 'key-prefix': 'fuzz-web-ui' },
      { directory: 'host', 'key-prefix': 'fuzz-host' },
    ]);
    for (const [directory, suite] of [
      ['.', 'Run backend fuzz tests (extended iterations)'],
      ['web-ui', 'Run frontend fuzz tests'],
      ['host', 'Run host fuzz tests'],
    ]) {
      const installIndex = steps.findIndex((candidate) => candidate.with?.directory === directory);
      const suiteIndex = steps.findIndex((candidate) => candidate.name === suite);
      assert.ok(installIndex >= 0 && installIndex < suiteIndex, `${directory} dependencies must precede ${suite}`);
    }
    assert.doesNotMatch(JSON.stringify(steps), /npm ci/);
  });

  it('normalizes the pentest target once and fans six probes out from that output', () => {
    const target = pentest.jobs.target;
    assert.equal(target.outputs.target, '${{ steps.normalize.outputs.target }}');
    assert.equal(
      step(target, 'Normalize target URL').run,
      'node scripts/ci/normalize-https-origin.mjs "$RAW_TARGET" target',
    );
    const probes = ['security-headers', 'tls', 'auth-gate', 'info-disclosure', 'injection', 'http-methods'];
    for (const name of probes) {
      const job = pentest.jobs[name];
      assert.equal(job.needs, 'target', name);
      assert.equal(job.env.TARGET, '${{ needs.target.outputs.target }}', name);
      assert.equal(step(job, 'Normalize target URL'), undefined, name);
    }
  });
});
