import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const script = resolve(root, 'scripts/ci/sign-release.sh');
const workflow = parseYaml(readFileSync(resolve(root, '.github/workflows/sign-release.yml'), 'utf8'));
const job = workflow.jobs.sign;
const steps = Object.fromEntries(job.steps.map((step) => [step.name, step]));
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-signing-'));
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  fixtures.push(cwd);
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$1" in
  rev-parse) printf '%040d\\n' 1 ;;
  fetch) exit 0 ;;
  merge-base) [ "\${FAKE_REACHABLE:-true}" = true ] ;;
  archive) printf 'archive:%s\\n' "$*" ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
if [ "$1 $2" = 'release view' ]; then
  printf '{"tagName":"%s","isDraft":%s}\\n' "$RELEASE_TAG" "\${FAKE_DRAFT:-false}"
  exit 0
fi
if [ "$1 $2" = 'release upload' ]; then
  printf '%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
  exit 0
fi
exit 2
`);
  writeFileSync(join(bin, 'cosign'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--bundle' ]; then shift; printf 'bundle\\n' > "$1"; exit 0; fi
  shift
done
exit 2
`);
  writeFileSync(join(bin, 'jq'), `#!/bin/sh
node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const value = JSON.parse(input); process.exit(value.tagName === process.env.RELEASE_TAG && value.isDraft === false ? 0 : 1); });'
`);
  for (const command of ['git', 'gh', 'cosign', 'jq']) chmodSync(join(bin, command), 0o755);
  return { cwd, bin, commandLog: join(cwd, 'commands.log'), githubEnv: join(cwd, 'github.env') };
}

function execute(cwd, bin, command, env = {}) {
  return spawnSync('bash', [script, command], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
  });
}

describe('REQ-OPS-034/REQ-OPS-035: keyless GitHub release signing', () => {
  it('wires immutable actions and the executable release boundary', () => {
    assert.deepEqual(workflow.on.release.types, ['published']);
    assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
    assert.equal(workflow.on.workflow_dispatch.inputs.tag.type, 'string');
    assert.equal(workflow.permissions.contents, 'read');
    assert.deepEqual(job.permissions, {
      contents: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    assert.equal(steps['Check out release tag'].with['persist-credentials'], false);
    assert.equal(steps['Check out release tag'].with.ref, '${{ env.RELEASE_TAG }}');
    assert.equal(steps['Validate release source'].run, 'scripts/ci/sign-release.sh validate');
    assert.equal(steps['Build deterministic release archive'].run, 'scripts/ci/sign-release.sh build');
    assert.equal(steps['Sign release assets'].run, 'scripts/ci/sign-release.sh sign');
    assert.equal(steps['Upload signed release assets'].run, 'scripts/ci/sign-release.sh upload');
    assert.equal(
      steps['Install Cosign'].uses,
      'sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6',
    );
    assert.equal(steps['Install Cosign'].with['cosign-release'], 'v3.1.2');
    assert.equal(
      steps['Attest release assets'].uses,
      'actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373',
    );
    assert.equal(
      steps['Attest release assets'].with['subject-path'],
      'release-assets/codeflare-v*.tar.gz\nrelease-assets/SHA256SUMS\n',
    );
    const serializedWorkflow = JSON.stringify(workflow);
    assert.doesNotMatch(serializedWorkflow, /\$\{\{\s*secrets\./);
    assert.doesNotMatch(serializedWorkflow, /COSIGN_PASSWORD|PRIVATE_KEY|SIGNING_KEY/);

    const stepNames = job.steps.map((step) => step.name);
    assert.ok(stepNames.indexOf('Sign release assets') < stepNames.indexOf('Attest release assets'));
    assert.ok(stepNames.indexOf('Attest release assets') < stepNames.indexOf('Upload signed release assets'));
    assert.equal(steps['Upload signed release assets'].if, undefined);
  });

  it('accepts only an existing semantic release reachable from main', () => {
    const { cwd, bin, githubEnv } = fixture();
    const base = {
      RELEASE_TAG: 'v1.2.3',
      EVENT_NAME: 'release',
      SOURCE_REF: 'refs/tags/v1.2.3',
      GITHUB_ENV: githubEnv,
    };
    const accepted = execute(cwd, bin, 'validate', base);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(githubEnv, 'utf8'), `RELEASE_COMMIT=${'0'.repeat(39)}1\n`);

    assert.equal(execute(cwd, bin, 'validate', { ...base, RELEASE_TAG: 'latest' }).status, 1);
    assert.equal(execute(cwd, bin, 'validate', {
      ...base,
      EVENT_NAME: 'workflow_dispatch',
      SOURCE_REF: 'refs/heads/develop',
    }).status, 1);
    assert.equal(execute(cwd, bin, 'validate', { ...base, FAKE_DRAFT: 'true' }).status, 1);
    assert.equal(execute(cwd, bin, 'validate', { ...base, FAKE_REACHABLE: 'false' }).status, 1);
  });

  it('builds deterministic assets, signs both, and uploads the owned set', () => {
    const { cwd, bin, commandLog } = fixture();
    const env = {
      RELEASE_TAG: 'v1.2.3',
      RELEASE_COMMIT: '1'.repeat(40),
      FAKE_COMMAND_LOG: commandLog,
    };
    const built = execute(cwd, bin, 'build', env);
    assert.equal(built.status, 0, built.stderr);
    const archivePath = join(cwd, 'release-assets/codeflare-v1.2.3.tar.gz');
    const archive = readFileSync(archivePath);
    const rebuilt = execute(cwd, bin, 'build', env);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.deepEqual(readFileSync(archivePath), archive);
    const checksum = createHash('sha256').update(archive).digest('hex');
    assert.equal(
      readFileSync(join(cwd, 'release-assets/SHA256SUMS'), 'utf8'),
      `${checksum}  codeflare-v1.2.3.tar.gz\n`,
    );

    const signed = execute(cwd, bin, 'sign', env);
    assert.equal(signed.status, 0, signed.stderr);
    assert.equal(readFileSync(join(cwd, 'release-assets/codeflare-v1.2.3.tar.gz.sigstore.json'), 'utf8'), 'bundle\n');
    assert.equal(readFileSync(join(cwd, 'release-assets/SHA256SUMS.sigstore.json'), 'utf8'), 'bundle\n');

    const uploaded = execute(cwd, bin, 'upload', env);
    assert.equal(uploaded.status, 0, uploaded.stderr);
    const commands = readFileSync(commandLog, 'utf8').trim().split('\n');
    assert.equal(commands.filter((line) => line.startsWith('sign-blob ')).length, 2);
    assert.equal(commands.at(-1), [
      'release upload v1.2.3',
      'release-assets/SHA256SUMS',
      'release-assets/SHA256SUMS.sigstore.json',
      'release-assets/codeflare-v1.2.3.tar.gz',
      'release-assets/codeflare-v1.2.3.tar.gz.sigstore.json',
      '--clobber',
    ].join(' '));
  });
});
