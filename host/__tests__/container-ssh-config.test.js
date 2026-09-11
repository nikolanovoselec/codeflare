// REQ-OPS-058: repository-scoped break-glass SSH is optional, validated,
// and applied only to the deployment copy of Wrangler configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'scripts', 'ci', 'configure-container-ssh.mjs');
const SOURCE_CONFIG = join(ROOT, 'wrangler.toml');

function sshEd25519PublicKey() {
  const algorithm = Buffer.from('ssh-ed25519');
  const key = Buffer.alloc(32, 0x2a);
  const blob = Buffer.alloc(4 + algorithm.length + 4 + key.length);
  blob.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(blob, 4);
  blob.writeUInt32BE(key.length, 4 + algorithm.length);
  key.copy(blob, 8 + algorithm.length);
  return `ssh-ed25519 ${blob.toString('base64')} test-fixture`;
}

function withTemporaryConfig(run) {
  const directory = mkdtempSync(join(tmpdir(), 'codeflare-container-ssh-'));
  const configPath = join(directory, 'wrangler.toml');
  writeFileSync(configPath, readFileSync(SOURCE_CONFIG));
  try {
    return run(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function configure(configPath, publicKey) {
  const env = { ...process.env };
  if (publicKey === undefined) delete env.CONTAINER_SSH_PUBLIC_KEY;
  else env.CONTAINER_SSH_PUBLIC_KEY = publicKey;
  return spawnSync(process.execPath, [SCRIPT, configPath], { encoding: 'utf8', env });
}

describe('REQ-OPS-058: optional repository-scoped container SSH', () => {
  it('keeps SSH disabled when the repository secret is absent', () =>
    withTemporaryConfig((configPath) => {
      const result = configure(configPath, undefined);
      assert.equal(result.status, 0, result.stderr);

      const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
      assert.equal(config.containers?.[0]?.wrangler_ssh?.enabled, false);
      assert.equal(config.containers?.[0]?.authorized_keys, undefined);
    }));

  it('enables SSH with exactly the validated repository public key', () =>
    withTemporaryConfig((configPath) => {
      const publicKey = sshEd25519PublicKey();
      const result = configure(configPath, publicKey);
      assert.equal(result.status, 0, result.stderr);

      const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });
      assert.equal(config.containers?.[0]?.wrangler_ssh?.enabled, true);
      assert.deepEqual(config.containers?.[0]?.authorized_keys, [
        {
          name: 'codeflare-operator',
          public_key: publicKey.split(' ').slice(0, 2).join(' '),
        },
      ]);
    }));

  it('rejects malformed or non-Ed25519 keys without changing the config', () => {
    const validKey = sshEd25519PublicKey();
    for (const invalidKey of [
      ` ${validKey}`,
      `${validKey}\nsecond-line`,
      'ssh-rsa not-an-ed25519-key',
      'ssh-ed25519 bm90LWFuLW9wZW5zc2gta2V5',
    ]) {
      withTemporaryConfig((configPath) => {
        const before = readFileSync(configPath, 'utf8');
        const result = configure(configPath, invalidKey);
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(configPath, 'utf8'), before);
        assert.equal(result.stderr.includes(invalidKey), false);
      });
    }
  });

  it('wires the repository secret into deployment before Worker promotion', () => {
    const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8'));
    const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === 'Configure optional container SSH');
    assert.ok(step, 'deploy workflow must configure optional container SSH');
    assert.equal(step.env.CONTAINER_SSH_PUBLIC_KEY, '${{ secrets.CONTAINER_SSH_PUBLIC_KEY }}');
    assert.equal(step.run, 'node scripts/ci/configure-container-ssh.mjs wrangler.toml');
  });
});
