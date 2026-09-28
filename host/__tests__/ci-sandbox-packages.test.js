import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const installer = join(root, 'scripts/ci/install-approved-packet-packages.sh');

function withPackages(options, verify) {
  const temp = mkdtempSync(join(tmpdir(), 'codeflare-apt-'));
  const source = join(temp, 'ubuntu.sources');
  const marker = join(temp, 'installed');
  try {
    if (!options.sourceMissing) writeFileSync(source, 'Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main universe\n');
    const sudo = join(temp, 'sudo');
    writeFileSync(sudo, '#!/bin/sh\nexec "$@"\n');
    chmodSync(sudo, 0o755);
    const apt = join(temp, 'apt-get');
    writeFileSync(apt, `#!/bin/bash
set -eu
source_seen=false
parts_disabled=false
command=''
for arg in "$@"; do
  if [[ "$arg" == "Dir::Etc::sourcelist=$EXPECTED_SOURCE" ]]; then source_seen=true; fi
  if [[ "$arg" == 'Dir::Etc::sourceparts=-' ]]; then parts_disabled=true; fi
  if [[ "$arg" == 'update' || "$arg" == 'install' ]]; then command="$arg"; fi
done
if [[ ( "$source_seen" != true || "$parts_disabled" != true ) && "$THIRD_PARTY_BROKEN" == 1 ]]; then
  echo 'unrelated repository returned 403' >&2; exit 100
fi
if [[ "$command" == update ]]; then
  if [[ "$UBUNTU_BROKEN" == 1 ]]; then echo 'Ubuntu source unavailable' >&2; exit 100; fi
  touch "$UPDATED_MARKER"
fi
if [[ "$command" == install ]]; then
  if [[ ! -f "$UPDATED_MARKER" ]]; then echo 'missing successful update' >&2; exit 100; fi
  if [[ "$INSTALL_BROKEN" == 1 ]]; then echo 'bubblewrap unavailable' >&2; exit 100; fi
  [[ " $* " == *' bubblewrap apparmor '* ]] || exit 99
  printf 'bubblewrap apparmor' > "$INSTALLED_MARKER"
fi
`);
    chmodSync(apt, 0o755);
    const result = spawnSync('bash', [installer, source], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, EXPECTED_SOURCE: source,
        INSTALLED_MARKER: marker, UPDATED_MARKER: join(temp, 'updated'), RUNNER_ENVIRONMENT: options.runner ?? 'github-hosted',
        THIRD_PARTY_BROKEN: options.thirdPartyBroken ? '1' : '0',
        UBUNTU_BROKEN: options.ubuntuBroken ? '1' : '0', INSTALL_BROKEN: options.installBroken ? '1' : '0' },
    });
    verify({ result, installed: existsSync(marker) ? readFileSync(marker, 'utf8') : null });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('approved-packet sandbox package prerequisites', () => {
  it('installs from official Ubuntu sources when an unrelated GitHub-hosted repository is forbidden', () => {
    withPackages({ thirdPartyBroken: true }, ({ result, installed }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(installed, 'bubblewrap apparmor');
    });
  });

  it('fails closed when the official Ubuntu source configuration is missing', () => {
    withPackages({ sourceMissing: true }, ({ result, installed }) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /official Ubuntu apt source unavailable/);
      assert.equal(installed, null);
    });
  });

  it('fails closed when the required Ubuntu source is unavailable', () => {
    withPackages({ ubuntuBroken: true }, ({ result, installed }) => {
      assert.equal(result.status, 100);
      assert.match(result.stderr, /Ubuntu source unavailable/);
      assert.equal(installed, null);
    });
  });

  it('fails closed when the sandbox packages cannot be installed', () => {
    withPackages({ installBroken: true }, ({ result, installed }) => {
      assert.equal(result.status, 100);
      assert.match(result.stderr, /bubblewrap unavailable/);
      assert.equal(installed, null);
    });
  });

  it('preserves the custom runner package-source policy', () => {
    withPackages({ runner: 'self-hosted' }, ({ result, installed }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(installed, 'bubblewrap apparmor');
    });
    withPackages({ runner: 'self-hosted', thirdPartyBroken: true }, ({ result, installed }) => {
      assert.equal(result.status, 100);
      assert.match(result.stderr, /unrelated repository returned 403/);
      assert.equal(installed, null);
    });
  });
});
