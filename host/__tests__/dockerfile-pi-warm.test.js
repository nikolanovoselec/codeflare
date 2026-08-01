// Structural audit of the Pi startup warm-up (REQ-SESSION-015 startup-latency
// hardening): the image must bake a warmed jiti transpile cache for the Pi
// extension set, and the entrypoint must expose the baked cache at jiti's
// tmpdir fallback path.
//
// Why this exists: the 6-package preseed bundle made every fresh container
// cold-transpile ~9s of extension graph before Pi's first PTY output, pushing
// the host pre-warm past its 20s hard cap (session startup 15s -> 30-35s).
// The warm-up layer + boot symlink make the first launch warm (~4s, measured).
//
// Gut-check: removing the warm-up layer or dropping the entrypoint symlink
// each fails a test below. (pi deliberately stays @latest — user policy is
// that coding agents auto-update at deploy; the warm-up is self-consistent
// because it runs with the pi installed in the same build.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

describe('Pi startup warm-up: baked jiti cache', () => {
  it('warm-up layer transpiles the extension set with TMPDIR redirected and bakes /opt/codeflare/jiti-cache', () => {
    assert.ok(
      /TMPDIR=\/opt\/codeflare\/jiti-warm-tmp[^\n]*pi -p/.test(dockerfile),
      'Dockerfile must run a throwaway `pi -p` warm-up with TMPDIR redirected (jiti caches under $TMPDIR/jiti)'
    );
    assert.ok(
      dockerfile.includes('mv /opt/codeflare/jiti-warm-tmp/jiti /opt/codeflare/jiti-cache'),
      'Dockerfile must move the warmed jiti cache to /opt/codeflare/jiti-cache'
    );
  });

  it('warm-up derives the package list from the preseed package.json (single source of truth, no duplicated version list)', () => {
    assert.ok(
      /require\("\/opt\/codeflare\/pi-agent\/npm\/package\.json"\)\.dependencies/.test(dockerfile),
      'the warm-up settings.json must be generated from the preseed package.json dependencies'
    );
  });

  it('build fails loudly if the warm-up produced an empty cache (a pi CLI change must not silently regress startup)', () => {
    assert.ok(
      /test -n "\$\(ls -A \/opt\/codeflare\/jiti-cache\)"/.test(dockerfile),
      'Dockerfile must assert the baked jiti cache is non-empty'
    );
  });

  it('entrypoint symlinks /tmp/jiti to the baked cache (jiti tmpdir fallback path), guarded on existence', () => {
    assert.ok(
      entrypoint.includes('ln -s /opt/codeflare/jiti-cache /tmp/jiti'),
      'entrypoint.sh must symlink /tmp/jiti -> /opt/codeflare/jiti-cache'
    );
    assert.ok(
      /\[ -d \/opt\/codeflare\/jiti-cache \] && \[ ! -e \/tmp\/jiti \]/.test(entrypoint),
      'the symlink must be guarded: only when the baked cache exists and /tmp/jiti does not'
    );
  });

  it('local Pi extensions are copied into the image for the warm-up (content-addressed cache entries hit the verbatim-seeded runtime copies)', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/agents/pi/extensions/ /opt/codeflare/pi-agent/extensions/'),
      'Dockerfile must COPY the preseed Pi extensions for the warm-up layer'
    );
  });
});
