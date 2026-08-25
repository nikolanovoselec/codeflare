import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'scripts', 'ci', 'verify-container-provenance.sh');
const SELECTOR = join(ROOT, 'scripts', 'ci', 'select-container-reuse.sh');
const WORKFLOW = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'container-image.yml'), 'utf8'));
const DEPLOY = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8'));
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function verify({ ghStatus = 0, uri = `registry.example.com/account/image@sha256:${'a'.repeat(64)}` } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'container-provenance-'));
  fixtures.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const log = join(cwd, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" > "$FAKE_GH_LOG"\nexit "$FAKE_GH_STATUS"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('bash', [SCRIPT, uri, 'owner/repo', 'owner/repo/.github/workflows/container-image.yml'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_LOG: log, FAKE_GH_STATUS: String(ghStatus) },
  });
  return { result, command: existsSync(log) ? readFileSync(log, 'utf8').trim() : '' };
}

function selectReuse(ghStatus, digest = `sha256:${'a'.repeat(64)}`) {
  const cwd = mkdtempSync(join(tmpdir(), 'container-reuse-'));
  fixtures.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const log = join(cwd, 'gh.log');
  const output = join(cwd, 'github-output');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" > "$FAKE_GH_LOG"\nexit "$FAKE_GH_STATUS"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('bash', [SELECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_GH_LOG: log,
      FAKE_GH_STATUS: String(ghStatus),
      GITHUB_OUTPUT: output,
      REGISTRY: 'dockerhub',
      DIGEST: digest,
      DOCKERHUB_USER: 'account',
      IMAGE_NAME: 'image',
      REPOSITORY: 'owner/repo',
      SIGNER_WORKFLOW: 'owner/repo/.github/workflows/container-image.yml',
    },
  });
  return { result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

function bindImage({ reused, digest = '' }) {
  const cwd = mkdtempSync(join(tmpdir(), 'container-binding-'));
  fixtures.push(cwd);
  const config = join(cwd, 'wrangler.toml');
  writeFileSync(config, 'image = "./Dockerfile"\n');
  const binding = DEPLOY.jobs.deploy.steps.find((step) => step.name === 'Point wrangler.toml to pre-pushed image');
  const result = spawnSync('bash', ['-c', binding.run], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGE_TAG: 'in-0123456789abcdef',
      VERIFIED_DIGEST: digest,
      REUSED: reused,
      REGISTRY_KIND: 'dockerhub',
      DOCKERHUB_USER: 'account',
      WORKER_NAME: 'worker',
    },
  });
  return { result, config: readFileSync(config, 'utf8') };
}

describe('REQ-OPS-042: retained deployment image provenance', () => {
  it('cryptographically verifies the digest against the owned reusable workflow', () => {
    const { result, command } = verify();
    assert.equal(result.status, 0, result.stderr);
    assert.match(command, /^attestation verify oci:\/\/registry\.example\.com\/account\/image@sha256:[a-f0-9]{64} /);
    assert.match(command, /--repo owner\/repo/);
    assert.match(command, /--signer-workflow owner\/repo\/\.github\/workflows\/container-image\.yml/);
    assert.match(command, /--predicate-type https:\/\/slsa\.dev\/provenance\/v1/);
  });

  it('fails closed on missing provenance or malformed identities', () => {
    assert.notEqual(verify({ ghStatus: 1 }).result.status, 0);
    for (const uri of ['registry.example.com/image:tag', 'registry.example.com/image@sha256:bad', 'registry.example.com/image@sha256:' + 'a'.repeat(64) + '\nPATH=/tmp']) {
      assert.notEqual(verify({ uri }).result.status, 0, uri);
    }
  });

  it('publishes reuse only when provenance verification succeeds', () => {
    const accepted = selectReuse(0);
    assert.equal(accepted.result.status, 0, accepted.result.stderr);
    assert.equal(accepted.output, `reused=true\ndigest=sha256:${'a'.repeat(64)}\n`);

    const rejected = selectReuse(1);
    assert.equal(rejected.result.status, 0, rejected.result.stderr);
    assert.equal(rejected.output, '');
    assert.match(rejected.result.stdout, /building fresh/);

    const malformed = selectReuse(0, 'sha256:bad');
    assert.equal(malformed.result.status, 0, malformed.result.stderr);
    assert.equal(malformed.output, '');
    assert.match(malformed.result.stdout, /building fresh/);
  });

  it('wires retained-image reuse to the behaviorally tested selector', () => {
    const job = WORKFLOW.jobs.image;
    const reuse = job.steps.find((step) => step.id === 'reuse');
    assert.equal(reuse.run, 'scripts/ci/select-container-reuse.sh');
    assert.deepEqual(reuse.env, {
      REGISTRY: '${{ inputs.registry }}',
      DIGEST: '${{ steps.candidate.outputs.digest }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      DOCKERHUB_USER: '${{ secrets.DOCKERHUB_USERNAME }}',
      GH_TOKEN: '${{ github.token }}',
      REPOSITORY: '${{ github.repository }}',
      SIGNER_WORKFLOW: '${{ github.repository }}/.github/workflows/container-image.yml',
    });
    assert.equal(job.outputs.reused, "${{ steps.reuse.outputs.reused || 'false' }}");
    assert.equal(job.outputs.verified_digest, '${{ steps.reuse.outputs.digest }}');
    assert.equal(WORKFLOW.on.workflow_call.outputs.verified_digest.value, '${{ jobs.image.outputs.verified_digest }}');
  });

  it('binds retained deployments to the verified digest instead of the mutable tag', () => {
    const binding = DEPLOY.jobs.deploy.steps.find((step) => step.name === 'Point wrangler.toml to pre-pushed image');
    assert.equal(binding.env.VERIFIED_DIGEST, '${{ needs.container.outputs.verified_digest }}');
    assert.equal(binding.env.REUSED, '${{ needs.container.outputs.reused }}');

    const digest = `sha256:${'b'.repeat(64)}`;
    const retained = bindImage({ reused: 'true', digest });
    assert.equal(retained.result.status, 0, retained.result.stderr);
    assert.equal(retained.config, `image = "docker.io/account/worker-container@${digest}"\n`);

    for (const invalid of ['', 'sha256:bad', `sha256:${'b'.repeat(64)}\nEXTRA=value`]) {
      assert.notEqual(bindImage({ reused: 'true', digest: invalid }).result.status, 0, invalid);
    }

    const fresh = bindImage({ reused: 'false' });
    assert.equal(fresh.result.status, 0, fresh.result.stderr);
    assert.equal(fresh.config, 'image = "docker.io/account/worker-container:in-0123456789abcdef"\n');
  });

  it('gates required fresh-image stages on no reuse', () => {
    const freshSteps = [
      'Build container image',
      'Verify packaged native Pi Chat and official Claude',
      'Scan image, generate SBOM, and prepare push tooling',
      'Push image',
    ];
    for (const name of freshSteps) {
      const candidate = WORKFLOW.jobs.image.steps.find((step) => step.name === name);
      assert.equal(candidate.if, "steps.reuse.outputs.reused != 'true'", name);
    }
  });
});
