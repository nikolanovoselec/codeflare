// Real behavioral tests for the browser-shim install (REQ-AGENT-013 AC1/AC2).
//
// The Dockerfile materializes two shim scripts that intercept browser-launch
// attempts so CLIs fall back to printing OAuth URLs as plain text:
//   * /usr/local/bin/open-url        (BROWSER convention; Claude Code checks $BROWSER)
//   * /usr/local/bin/xdg-open-shim   (symlinked to /usr/bin/xdg-open; the XDG entry point)
//
// The existing dockerfile-*.test.js files string-match the Dockerfile source
// (dockerfile.includes(...)) — assertions that pass even if `exit 1` were
// changed to `exit 0`, i.e. theater. These tests instead EXECUTE the real
// shim-creation RUN block (repointed at a temp prefix), then RUN the produced
// shims and assert their OBSERVABLE behavior: a non-zero exit code. If the
// shim were gutted to `exit 0`, the CLI would think the browser opened and
// would NOT fall back to text — so a non-zero exit is the load-bearing
// contract, and these tests fail if it regresses.
//
// Mirrors the extract-the-real-block / run-in-bash-subshell / assert-side-
// effects harness in host/__tests__/entrypoint-vault-boot.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(__dirname, '../../Dockerfile');

// Slice out the multi-line `RUN ... > /usr/local/bin/open-url ...` block
// (header to the last line without a trailing backslash). We never assert on
// the sliced text; we repoint its absolute paths and execute it.
function extractShimRunBlock() {
  const lines = readFileSync(DOCKERFILE, 'utf8').split('\n');
  const start = lines.findIndex((l) =>
    /^RUN printf .* > \/usr\/local\/bin\/open-url/.test(l),
  );
  if (start === -1) {
    throw new Error('Could not locate the browser-shim RUN block (open-url) in Dockerfile');
  }
  let end = start;
  while (end < lines.length && /\\\s*$/.test(lines[end])) end++;
  const block = lines.slice(start, end + 1).join('\n');
  // Strip the `RUN ` prefix so it is a plain shell snippet, and drop the
  // line-continuation backslashes so it runs as one script.
  return block.replace(/^RUN /, '').replace(/\\\n/g, '\n');
}

// Repoint the two absolute install roots the block writes to so the test
// never touches the real container paths.
function repoint(block, { localBin, usrBin }) {
  return block
    .replaceAll('/usr/local/bin', localBin)
    .replaceAll('/usr/bin', usrBin);
}

function runBash(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)', () => {
  it('the installed BROWSER shim (open-url) exists, is executable, and exits non-zero when invoked (AC1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-shim-'));
    const localBin = join(root, 'local-bin');
    const usrBin = join(root, 'usr-bin');
    mkdirSync(localBin, { recursive: true });
    mkdirSync(usrBin, { recursive: true });

    const block = repoint(extractShimRunBlock(), { localBin, usrBin });
    const install = runBash(block);
    assert.equal(install.status, 0, `shim-install block must run cleanly; stderr: ${install.stderr}`);

    const openUrl = join(localBin, 'open-url');
    assert.ok(existsSync(openUrl), 'the open-url BROWSER shim must be installed');

    // Executable bit (the install chmods +x; CLIs spawn it as a child process).
    assert.ok((lstatSync(openUrl).mode & 0o111) !== 0, 'open-url shim must be executable');

    // The load-bearing behavior: running it returns a NON-ZERO exit so the
    // calling CLI treats the browser launch as failed and falls back to text.
    const run = runBash(`'${openUrl}' 'https://example.com/oauth?code=abc'`);
    assert.notEqual(
      run.status,
      0,
      'the BROWSER shim must exit non-zero so the CLI falls back to plain-text URL output',
    );
  });

  it('the XDG entry point (xdg-open) is shimmed and exits non-zero when invoked (AC2)', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-shim-xdg-'));
    const localBin = join(root, 'local-bin');
    const usrBin = join(root, 'usr-bin');
    mkdirSync(localBin, { recursive: true });
    mkdirSync(usrBin, { recursive: true });

    const block = repoint(extractShimRunBlock(), { localBin, usrBin });
    const install = runBash(block);
    assert.equal(install.status, 0, `shim-install block must run cleanly; stderr: ${install.stderr}`);

    // xdg-open is a symlink to the shim, so tools that bypass $BROWSER and call
    // xdg-open directly (OpenCode/Bun) still hit a failing launcher.
    const xdgOpen = join(usrBin, 'xdg-open');
    assert.ok(existsSync(xdgOpen), 'xdg-open must be wired to the shim');
    assert.ok(lstatSync(xdgOpen).isSymbolicLink(), 'xdg-open must be a symlink to the shim');

    const run = runBash(`'${xdgOpen}' 'https://example.com/oauth?code=abc'`);
    assert.notEqual(
      run.status,
      0,
      'the XDG entry-point shim must exit non-zero so xdg-open callers fall back to text',
    );
  });

  it('a CLI that honors $BROWSER inherits the non-zero exit, triggering its text fallback (AC1 end-to-end)', () => {
    // The shim is only effective if $BROWSER names it AND a CLI that runs
    // "$BROWSER <url>" sees the failure. Install the real shim, read the env
    // target the Dockerfile sets, and simulate the CLI launch through it:
    // a faithful CLI runs `$BROWSER url || print_url_as_text`. Assert the
    // shim's non-zero exit drives the fallback branch.
    const root = mkdtempSync(join(tmpdir(), 'browser-shim-env-'));
    const localBin = join(root, 'local-bin');
    const usrBin = join(root, 'usr-bin');
    mkdirSync(localBin, { recursive: true });
    mkdirSync(usrBin, { recursive: true });

    const block = repoint(extractShimRunBlock(), { localBin, usrBin });
    assert.equal(runBash(block).status, 0, 'shim-install block must run cleanly');

    // The Dockerfile names /usr/local/bin/open-url as BROWSER; under our
    // repointed prefix that is localBin/open-url.
    const browser = join(localBin, 'open-url');
    const url = 'https://example.com/oauth?code=abc';
    // Faithful CLI: try to open the browser, else print the URL as text.
    const cli = runBash(`BROWSER='${browser}'; "$BROWSER" '${url}' || echo "FELL_BACK ${url}"`);
    assert.equal(cli.status, 0, 'the CLI || fallback chain itself must succeed');
    assert.match(
      cli.stdout,
      new RegExp(`FELL_BACK ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'a BROWSER-honoring CLI must reach its plain-text fallback when the shim exits non-zero',
    );
  });
});
