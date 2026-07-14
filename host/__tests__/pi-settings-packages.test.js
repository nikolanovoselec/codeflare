// Runs the real embedded Node program from entrypoint.sh that assembles Pi's
// ~/.pi/agent/settings.json `packages` array, against fixture settings files.
// This is the "run the real thing" coverage (per tdd-discipline.md) for:
//   - context-mode skills being enabled by default while its extension is attached only by the
//     foreground owner guard (never inherited by in-process subagent ResourceLoaders),
//   - the five tool extensions (rpiv-advisor, rpiv-ask-user-question, rpiv-todo,
//     pi-web-access, pi-mcp-adapter) being present in `required` so they are
//     available WITH AND WITHOUT context-mode — toggling /ctx never removes them,
//   - advisor guidance being user-invoked only while preserving user model config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract a `node - "$var" <<'NODE' ... NODE` heredoc body so it can run standalone.
function extractHeredoc(marker, label) {
  const start = entrypoint.indexOf(marker);
  if (start === -1) throw new Error(`${label} NODE heredoc not found`);
  const bodyStart = entrypoint.indexOf('\n', start) + 1;
  const end = entrypoint.indexOf('\nNODE', bodyStart);
  if (end === -1) throw new Error(`${label} NODE terminator not found`);
  return entrypoint.slice(bodyStart, end);
}

function extractAssembly() {
  return extractHeredoc(`node - "$pi_settings" <<'NODE'`, 'Pi settings packages assembly');
}

function extractAdvisorGuidanceMerge() {
  return extractHeredoc(`node - "$advisor_config" <<'NODE'`, 'advisor guidance merge');
}

function runHeredoc(body, filename, initialJson) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pkgs-'));
  const scriptPath = join(dir, 'script.cjs'); // .cjs: the program uses require()/argv
  const jsonPath = join(dir, filename);
  writeFileSync(scriptPath, body);
  writeFileSync(jsonPath, initialJson);
  const result = spawnSync('node', [scriptPath, jsonPath], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`heredoc exited ${result.status}: ${result.stderr}`);
  return JSON.parse(readFileSync(jsonPath, 'utf-8'));
}

function runAssembly(initialSettings) {
  return runHeredoc(extractAssembly(), 'settings.json', initialSettings);
}

function runAdvisorGuidanceMerge(initialConfig) {
  return runHeredoc(extractAdvisorGuidanceMerge(), 'advisor.json', initialConfig);
}

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry && entry.source);
const REQUIRED = [
  'npm:@gotgenes/pi-subagents@18.0.2',
  'npm:context-mode@1.0.169',
  'npm:@juicesharp/rpiv-advisor@1.20.0',
  'npm:@juicesharp/rpiv-ask-user-question@1.20.0',
  'npm:@juicesharp/rpiv-todo@1.20.0',
  'npm:pi-web-access@0.13.0',
  'npm:pi-mcp-adapter@2.11.0',
];

describe('Pi settings.json packages assembly (entrypoint.sh)', () => {
  it('REQ-AGENT-076 AC1: fresh container enables context-mode skills by default', () => {
    const settings = runAssembly('{}');
    const sources = settings.packages.map(sourceOf);
    for (const spec of REQUIRED) {
      assert.ok(sources.includes(spec), `assembled packages must include ${spec}`);
    }
    const contextMode = settings.packages.find((entry) => sourceOf(entry) === 'npm:context-mode@1.0.169');
    assert.deepEqual(contextMode, { source: 'npm:context-mode@1.0.169', extensions: [] });
  });

  it('coexistence: a prior settings that DISABLED context-mode is upgraded to foreground-only enablement, with the 5 extensions present and unrelated packages preserved', () => {
    const initial = JSON.stringify({
      packages: [
        { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] }, // previously disabled
        'npm:some-user-package@1.0.0', // an unrelated package the user added
      ],
    });
    const settings = runAssembly(initial);
    const sources = settings.packages.map(sourceOf);
    // Skills are re-enabled, while shared extension autoload stays disabled for subagents.
    const cm = settings.packages.find((e) => sourceOf(e) === 'npm:context-mode@1.0.169');
    assert.deepEqual(cm, { source: 'npm:context-mode@1.0.169', extensions: [] });
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

  it('does not inject context-mode runtime defaults through settings.extensions', () => {
    const once = runAssembly(JSON.stringify({ extensions: ['user-ext.ts'] }));
    const twice = runAssembly(JSON.stringify(once));

    assert.deepEqual(once.extensions, ['user-ext.ts']);
    assert.deepEqual(twice.extensions, ['user-ext.ts']);
  });

  it('REQ-AGENT-076: overrides advisor guidance as user-invoked only without clearing the selected model', () => {
    const config = runAdvisorGuidanceMerge(JSON.stringify({ modelKey: 'provider/model', effort: 'medium' }));
    assert.equal(config.modelKey, 'provider/model');
    assert.equal(config.effort, 'medium');
    assert.match(config.guidance.promptSnippet, /user-invoked only/i);
    assert.ok(config.guidance.promptGuidelines.some((line) => line.includes('Never call `advisor`, run `/advisor`, or suggest `/advisor` proactively')));
    assert.ok(config.guidance.promptGuidelines.every((line) => !line.includes('before substantive work')));
  });
});
