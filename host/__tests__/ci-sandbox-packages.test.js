import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const installer = join(root, 'scripts/ci/install-approved-packet-packages.sh');
const mirroredSource = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';

function withPackages(options, verify) {
  const temp = mkdtempSync(join(tmpdir(), 'codeflare-apt-'));
  const source = join(temp, options.legacy ? 'ubuntu.list' : 'ubuntu.sources');
  const marker = join(temp, 'installed');
  try {
    if (!options.sourceMissing) writeFileSync(source, options.source ?? mirroredSource);
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
  if [[ "$arg" == Dir::Etc::sourcelist=* ]]; then
    source_seen=true
    source_file="\${arg#Dir::Etc::sourcelist=}"
  fi
  if [[ "$arg" == 'Dir::Etc::sourceparts=-' ]]; then parts_disabled=true; fi
  if [[ "$arg" == 'update' || "$arg" == 'install' ]]; then command="$arg"; fi
done
if [[ ( "$source_seen" != true || "$parts_disabled" != true ) && "$THIRD_PARTY_BROKEN" == 1 ]]; then
  echo 'unrelated repository returned 403' >&2; exit 100
fi
if [[ "$source_seen" == true ]]; then
  cat "$source_file" > "$SOURCE_CAPTURE.$command"
  printf '%s' "$source_file" > "$SOURCE_CAPTURE.path"
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
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, SOURCE_CAPTURE: join(temp, 'captured'),
        INSTALLED_MARKER: marker, UPDATED_MARKER: join(temp, 'updated'), RUNNER_ENVIRONMENT: options.runner ?? 'github-hosted',
        THIRD_PARTY_BROKEN: options.thirdPartyBroken ? '1' : '0',
        UBUNTU_BROKEN: options.ubuntuBroken ? '1' : '0', INSTALL_BROKEN: options.installBroken ? '1' : '0' },
    });
    const captured = (command) => existsSync(join(temp, `captured.${command}`))
      ? readFileSync(join(temp, `captured.${command}`), 'utf8') : null;
    verify({ result, installed: existsSync(marker) ? readFileSync(marker, 'utf8') : null,
      updateSource: captured('update'), installSource: captured('install'),
      originalSource: existsSync(source) ? readFileSync(source, 'utf8') : null,
      routedPath: captured('path') });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('approved-packet sandbox package prerequisites', () => {
  it('installs from official Ubuntu sources when an unrelated GitHub-hosted repository is forbidden', () => {
    withPackages({ thirdPartyBroken: true }, ({ result, installed, updateSource, installSource, originalSource, routedPath }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(installed, 'bubblewrap apparmor');
      // Apt source format is a contract: retain suites, components and Signed-By.
      const expected = mirroredSource.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://archive.ubuntu.com/ubuntu/');
      assert.equal(updateSource, expected);
      assert.equal(installSource, expected);
      assert.equal(originalSource, mirroredSource);
      assert.ok(routedPath.endsWith('.sources'));
      assert.equal(existsSync(routedPath), false, 'temporary source is removed');
    });
  });

  it('routes legacy runner sources directly while preserving signed-by and security sources', () => {
    for (const uri of ['mirror+file:/etc/apt/apt-mirrors.txt', 'http://azure.archive.ubuntu.com/ubuntu/']) {
      const source = `deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${uri} jammy main universe\ndeb https://security.ubuntu.com/ubuntu/ jammy-security main universe\n`;
      withPackages({ legacy: true, source }, ({ result, installed, updateSource, installSource, originalSource, routedPath }) => {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(installed, 'bubblewrap apparmor');
        assert.equal(updateSource, source.replace(uri, 'https://archive.ubuntu.com/ubuntu/'));
        assert.equal(installSource, updateSource);
        assert.equal(originalSource, source);
        assert.ok(routedPath.endsWith('.list'));
        assert.equal(existsSync(routedPath), false);
      });
    }
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
    withPackages({ runner: 'self-hosted' }, ({ result, installed, updateSource, installSource, originalSource }) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(installed, 'bubblewrap apparmor');
      assert.equal(updateSource, null);
      assert.equal(installSource, null);
      assert.equal(originalSource, mirroredSource);
    });
    withPackages({ runner: 'self-hosted', thirdPartyBroken: true }, ({ result, installed }) => {
      assert.equal(result.status, 100);
      assert.match(result.stderr, /unrelated repository returned 403/);
      assert.equal(installed, null);
    });
  });
});
