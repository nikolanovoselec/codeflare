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
const WORKFLOW = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'container-image.yml'), 'utf8'));
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

describe('retained deployment image provenance', () => {
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

  it('wires retained-image reuse to the behaviorally tested verifier', () => {
    const job = WORKFLOW.jobs.image;
    const reuse = job.steps.find((step) => step.id === 'reuse');
    assert.equal(reuse.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(reuse.run.match(/scripts\/ci\/verify-container-provenance\.sh/g)?.length, 1);
    assert.match(reuse.run, /if scripts\/ci\/verify-container-provenance\.sh/);
    assert.equal(job.outputs.reused, "${{ steps.reuse.outputs.reused || 'false' }}");
  });
});
