// Runs the real embedded Node program from entrypoint.sh that assembles Pi's
// ~/.pi/agent/settings.json `packages` array, against fixture settings files.
// This is the "run the real thing" coverage (per tdd-discipline.md) for:
//   - context-mode being ENABLED by default for Pi (moved out of disabledPackages),
//   - the five tool extensions (rpiv-advisor, rpiv-ask-user-question, rpiv-todo,
//     pi-web-access, pi-mcp-adapter) being present in `required` so they are
//     available WITH AND WITHOUT context-mode — toggling /ctx never removes them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the `node - "$pi_settings" <<'NODE' ... NODE` heredoc body so it can run standalone.
function extractAssembly() {
  const marker = `node - "$pi_settings" <<'NODE'`;
  const start = entrypoint.indexOf(marker);
  if (start === -1) throw new Error('Pi settings packages assembly NODE heredoc not found');
  const bodyStart = entrypoint.indexOf('\n', start) + 1;
  const end = entrypoint.indexOf('\nNODE', bodyStart);
  if (end === -1) throw new Error('Pi settings packages assembly NODE terminator not found');
  return entrypoint.slice(bodyStart, end);
}

function runAssembly(initialSettings) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pkgs-'));
  const scriptPath = join(dir, 'assembly.cjs'); // .cjs: the program uses require()/argv
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(scriptPath, extractAssembly());
  writeFileSync(settingsPath, initialSettings);
  const result = spawnSync('node', [scriptPath, settingsPath], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`assembly exited ${result.status}: ${result.stderr}`);
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry && entry.source);
const REQUIRED = [
  'npm:@gotgenes/pi-subagents@16.2.1',
  'npm:context-mode@1.0.162',
  'npm:@juicesharp/rpiv-advisor@1.19.1',
  'npm:@juicesharp/rpiv-ask-user-question@1.19.1',
  'npm:@juicesharp/rpiv-todo@1.19.1',
  'npm:pi-web-access@0.10.7',
  'npm:pi-mcp-adapter@2.9.0',
];

describe('Pi settings.json packages assembly (entrypoint.sh)', () => {
  it('from empty settings: enables every required package (subagents + context-mode + 5 extensions)', () => {
    const settings = runAssembly('{}');
    const sources = settings.packages.map(sourceOf);
    for (const spec of REQUIRED) {
      assert.ok(sources.includes(spec), `assembled packages must include ${spec}`);
    }
  });

  it('context-mode is ENABLED (bare-string form), not a disabled object entry', () => {
    const settings = runAssembly('{}');
    const cm = settings.packages.find((e) => sourceOf(e) === 'npm:context-mode@1.0.162');
    assert.equal(typeof cm, 'string', 'context-mode must be enabled by default — a bare string, not a {source,extensions,skills} disabled entry');
  });

  it('coexistence: a prior settings that DISABLED context-mode is upgraded to enabled, with the 5 extensions present and unrelated packages preserved', () => {
    const initial = JSON.stringify({
      packages: [
        { source: 'npm:context-mode@1.0.162', extensions: [], skills: [] }, // previously disabled
        'npm:some-user-package@1.0.0', // an unrelated package the user added
      ],
    });
    const settings = runAssembly(initial);
    const sources = settings.packages.map(sourceOf);
    // context-mode is now enabled (string), not the disabled object.
    const cm = settings.packages.find((e) => sourceOf(e) === 'npm:context-mode@1.0.162');
    assert.equal(typeof cm, 'string', 'a previously-disabled context-mode must be re-enabled on assembly');
    // The five tool extensions are present regardless of context-mode's prior state.
    for (const spec of REQUIRED) assert.ok(sources.includes(spec), `must include ${spec}`);
    // The user's unrelated package is preserved (assembly merges, never wipes).
    assert.ok(sources.includes('npm:some-user-package@1.0.0'), 'unrelated existing packages must be preserved');
  });

  it('is idempotent: re-running over its own output yields the same package set (no duplicates)', () => {
    const once = runAssembly('{}');
    const twice = runAssembly(JSON.stringify(once));
    const dedupe = (s) => [...new Set(s.packages.map(sourceOf))].sort();
    assert.deepEqual(dedupe(twice), dedupe(once));
    assert.equal(twice.packages.length, new Set(twice.packages.map(sourceOf)).size, 'no duplicate package identities');
  });
});
