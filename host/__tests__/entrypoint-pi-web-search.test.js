// REQ-AGENT-076 AC5: Pi's web_search workflow defaults to auto-summary so it
// never reaches pi-web-access's interactive browser-curator fallback, which
// cannot function in this headless container.
//
// "Run the real thing" per tdd-discipline.md: extract the real web-search
// block from entrypoint.sh and execute it against a fixture $USER_HOME,
// asserting on the actual written JSON content -- not on entrypoint.sh's
// source text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, symlinkSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Pull the standalone web-search block (assignment through its closing `fi`)
// -- it is inline MAIN EXECUTION code, not a function, so it is sliced by
// anchor text rather than extracted as a named function body.
function extractWebSearchBlock() {
  const marker = 'PI_WEB_SEARCH_JSON="$USER_HOME/.pi/web-search.json"';
  const ifStart = entrypoint.indexOf(marker);
  if (ifStart === -1) {
    throw new Error('web-search block PI_WEB_SEARCH_JSON marker not found in entrypoint.sh');
  }
  const end = entrypoint.indexOf('\nfi\n', ifStart);
  if (end === -1) {
    throw new Error('web-search block closing fi not found in entrypoint.sh');
  }
  return entrypoint.slice(ifStart, end + '\nfi'.length);
}

function runBlock(userHome) {
  const script = `
set -euo pipefail
USER_HOME="${userHome}"
${extractWebSearchBlock()}
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness bash exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  }
  return result;
}

describe('entrypoint.sh Pi web-search workflow default', () => {
  it('writes auto-summary when absent', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'web-search-'));
    runBlock(userHome);
    const written = JSON.parse(readFileSync(join(userHome, '.pi', 'web-search.json'), 'utf8'));
    assert.deepEqual(written, { workflow: 'auto-summary' });
  });

  it('does not overwrite an existing file', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'web-search-'));
    mkdirSync(join(userHome, '.pi'), { recursive: true });
    const configPath = join(userHome, '.pi', 'web-search.json');
    const userChoice = JSON.stringify({ workflow: 'summary-review' });
    writeFileSync(configPath, userChoice);
    runBlock(userHome);
    assert.equal(readFileSync(configPath, 'utf8'), userChoice);
  });
});

// REQ-AGENT-076 AC8 mapping: execute the existing final startup gate, with
// fixture-only update/PTY boundaries. The receipt observes state at PTY release.
// No installed extension is loaded and no running agent state is touched.
const releaseStart = entrypoint.indexOf('release_agent_pty_after_fast_start_updates() {');
const releaseEnd = entrypoint.indexOf('\n# Warm Pi extension npm dependencies', releaseStart);
const releaseBlock = entrypoint.slice(releaseStart, releaseEnd);

function noticeFixture(t, { agentDir, packagePresent = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'web-notice-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = agentDir ? join(home, 'custom-agent') : join(home, '.pi/agent');
  const npm = join(home, 'installed-npm');
  const manifest = join(npm, 'node_modules/pi-web-access/package.json');
  const state = join(agent, 'pi-web-access');
  const marker = join(state, 'last-seen-version.json');
  if (packagePresent) {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name: 'pi-web-access', version: '9.8.7' }));
  }
  function seed(raw) {
    mkdirSync(state, { recursive: true });
    writeFileSync(marker, raw);
  }
  function run(extra = {}) {
    const result = spawnSync('bash', ['-c', `set -euo pipefail
${releaseBlock}
update_pi_and_codex_when_fast_start_disabled() {
  if [ -n "\${UPDATE_MANIFEST:-}" ]; then cp "$UPDATE_MANIFEST" "$PACKAGE_JSON"; fi
}
release_agent_pty_after_cleanup() {
  if [ -f "$EXPECTED_MARKER" ]; then cp "$EXPECTED_MARKER" "$HOME/released-marker"; fi
  printf 'PTY released\\n'
}
release_agent_pty_after_fast_start_updates
`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USER_HOME: home, PI_CODING_AGENT_DIR: agentDir === 'tilde' ? '~/custom-agent' : agentDir ? agent : '',
        XDG_CONFIG_HOME: join(home, 'unrelated-xdg'), PI_NPM_DIR: npm,
        PACKAGE_JSON: manifest, EXPECTED_MARKER: marker, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PTY released/);
    return result;
  }
  return { home, agent, manifest, state, marker, seed, run };
}

describe('REQ-AGENT-076 AC8: quiet managed pi-web-access startup', () => {
  for (const agentDir of [undefined, 'absolute', 'tilde']) {
    it(`records the installed version before PTY release (${agentDir ?? 'default agent dir'})`, (t) => {
      const f = noticeFixture(t, { agentDir });
      f.run();
      assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { version: '9.8.7' });
      assert.equal(readFileSync(join(f.home, 'released-marker'), 'utf8'), readFileSync(f.marker, 'utf8'));
      assert.equal(existsSync(join(f.home, 'unrelated-xdg')), false);
    });
  }

  it('updates restored versions, preserves metadata/preferences, and is byte/idempotent on repeat startup', (t) => {
    const f = noticeFixture(t);
    f.seed(JSON.stringify({ version: '1.0.0', custom: { retained: true } }));
    const prefs = join(f.agent, 'settings.json');
    const webPrefs = join(f.home, '.pi/web-search.json');
    writeFileSync(prefs, '{ "theme": "mine", "packages": ["npm:custom"] }\n');
    writeFileSync(webPrefs, '{ "workflow": "summary-review" }\n');
    const before = [prefs, webPrefs, f.manifest].map((p) => readFileSync(p, 'utf8'));
    f.run();
    assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { version: '9.8.7', custom: { retained: true } });
    const bytes = readFileSync(f.marker, 'utf8');
    const modified = statSync(f.marker).mtimeMs;
    f.run();
    assert.equal(readFileSync(f.marker, 'utf8'), bytes);
    assert.equal(statSync(f.marker).mtimeMs, modified);
    assert.deepEqual([prefs, webPrefs, f.manifest].map((p) => readFileSync(p, 'utf8')), before);
  });

  it('uses the version installed by the final update, including a later downgrade', (t) => {
    const f = noticeFixture(t);
    f.seed('{"version":"1.0.0"}');
    const update = join(f.home, 'update.json');
    for (const version of ['12.34.56', '2.0.0']) {
      writeFileSync(update, JSON.stringify({ name: 'pi-web-access', version }));
      f.run({ UPDATE_MANIFEST: update });
      assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { version });
      assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'released-marker'), 'utf8')), { version });
    }
  });

  it('preserves an already-current marker byte for byte', (t) => {
    const f = noticeFixture(t);
    const raw = '{ "version": "9.8.7", "other": 42 }\n';
    f.seed(raw);
    f.run();
    assert.equal(readFileSync(f.marker, 'utf8'), raw);
  });

  it('skips an absent package without creating state or installing anything', (t) => {
    const f = noticeFixture(t, { packagePresent: false });
    const result = f.run();
    assert.equal(existsSync(f.agent), false);
    assert.equal(existsSync(f.manifest), false);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'PTY released\n');
  });

  for (const raw of ['private broken json', '[]', 'null', '"private"', '{"version":12}', '{"version":"private"}']) {
    it(`preserves malformed state (${raw}) and reports only a content-free warning`, (t) => {
      const f = noticeFixture(t);
      f.seed(raw);
      const result = f.run();
      assert.equal(readFileSync(f.marker, 'utf8'), raw);
      assert.match(result.stdout + result.stderr, /WARNING: Pi web-access upgrade notice state could not be prepared; continuing startup/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|SyntaxError|ENOENT/);
      assert.deepEqual(readdirSync(f.state), ['last-seen-version.json']);
    });
  }

  for (const conflict of ['marker-link', 'dangling-marker-link', 'marker-directory', 'state-link', 'state-file', 'agent-link']) {
    it(`refuses ${conflict} without replacing it or writing through it`, (t) => {
      const f = noticeFixture(t);
      const outside = join(f.home, 'untouched');
      mkdirSync(outside);
      const target = join(outside, 'last-seen-version.json');
      writeFileSync(target, '{"version":"1.0.0","private":true}');
      let conflictPath;
      if (conflict === 'agent-link') {
        mkdirSync(dirname(f.agent), { recursive: true });
        symlinkSync(outside, f.agent);
        conflictPath = f.agent;
      } else if (conflict.startsWith('state-')) {
        mkdirSync(f.agent, { recursive: true });
        if (conflict === 'state-link') symlinkSync(outside, f.state);
        else writeFileSync(f.state, 'private');
        conflictPath = f.state;
      } else {
        mkdirSync(f.state, { recursive: true });
        if (conflict === 'marker-directory') mkdirSync(f.marker);
        else symlinkSync(conflict === 'marker-link' ? target : join(outside, 'missing'), f.marker);
        conflictPath = f.marker;
      }
      const before = lstatSync(conflictPath);
      const result = f.run();
      assert.equal(lstatSync(conflictPath).ino, before.ino);
      assert.equal(readFileSync(target, 'utf8'), '{"version":"1.0.0","private":true}');
      assert.deepEqual(readdirSync(outside), ['last-seen-version.json']);
      assert.match(result.stdout + result.stderr, /WARNING: Pi web-access upgrade notice state could not be prepared; continuing startup/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|untouched/);
    });
  }

  for (const raw of ['private broken json', '{}', '{"version":"invalid-private"}']) {
    it(`does not invent a version from an invalid installed manifest (${raw})`, (t) => {
      const f = noticeFixture(t);
      writeFileSync(f.manifest, raw);
      const result = f.run();
      assert.equal(existsSync(f.state), false);
      assert.equal(readFileSync(f.manifest, 'utf8'), raw);
      assert.match(result.stdout + result.stderr, /WARNING: Pi web-access upgrade notice state could not be prepared; continuing startup/);
      assert.doesNotMatch(result.stdout + result.stderr, /private|SyntaxError/);
    });
  }
});
