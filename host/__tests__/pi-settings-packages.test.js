// Runs the real embedded Node program from entrypoint.sh that assembles Pi's
// ~/.pi/agent/settings.json `packages` array, against fixture settings files.
// This is the "run the real thing" coverage (per tdd-discipline.md) for:
//   - context-mode being disabled by default while remaining available through explicit /ctx on,
//   - the managed extension packages, including Goal, being present in
//     `required` so they are
//     available WITH AND WITHOUT context-mode — toggling /ctx never removes them,
//   - advisor guidance being user-invoked only while preserving user model config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
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
  'npm:@gotgenes/pi-subagents@19.2.1',
  'npm:context-mode@1.0.169',
  'npm:@juicesharp/rpiv-advisor@2.2.0',
  'npm:@juicesharp/rpiv-ask-user-question@2.1.0',
  'npm:@juicesharp/rpiv-todo@2.1.0',
  'npm:pi-web-access@0.15.0',
  'npm:pi-mcp-adapter@2.15.0',
  'npm:@narumitw/pi-goal@0.43.0',
];

describe('Goal package preseed (REQ-AGENT-111)', () => {
  it('replaces glla with the exact reviewed Goal package and integrity-locked release', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    assert.equal(pkg.dependencies['@narumitw/pi-goal'], '0.43.0');
    assert.equal(pkg.dependencies['pi-goal-list-loop-audit'], undefined);
    const goal = lock.packages['node_modules/@narumitw/pi-goal'];
    assert.equal(goal.version, '0.43.0');
    assert.equal(goal.integrity, 'sha512-+HUjcd9u9Pr1YVqmPfDib09QTybZZKziEEgpiB0WfW/J38FWeH0+IfJy120TV3U9TolFLOKdhrdpUFFzly6CSA==');
    assert.equal(lock.packages['node_modules/pi-goal-list-loop-audit'], undefined);
  });

});

describe('rpiv-todo upstream session isolation (REQ-AGENT-081)', () => {
  it('pins the reviewed upstream release and retains no source-override machinery', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    assert.equal(pkg.dependencies['@juicesharp/rpiv-todo'], '2.1.0');
    assert.equal(pkg.scripts?.postinstall, undefined);
    assert.ok(!existsSync(resolve(__dirname, '../../preseed/agents/pi/npm/rpiv-todo-session-isolation')));
  });
});

describe('Pi settings.json packages assembly (entrypoint.sh)', () => {
  it('REQ-AGENT-076 AC1: fresh container disables context-mode by default', () => {
    const settings = runAssembly('{}');
    const sources = settings.packages.map(sourceOf);
    for (const spec of REQUIRED) {
      assert.ok(sources.includes(spec), `assembled packages must include ${spec}`);
    }
    const contextMode = settings.packages.find((entry) => sourceOf(entry) === 'npm:context-mode@1.0.169');
    assert.deepEqual(contextMode, { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] });
  });

  it('startup removes the retired package while preserving managed and unrelated packages', () => {
    const initial = JSON.stringify({
      packages: [
        { source: 'npm:context-mode@1.0.169', extensions: [] },
        'npm:pi-goal-list-loop-audit@0.34.16',
        'npm:some-user-package@1.0.0', // an unrelated package the user added
      ],
    });
    const settings = runAssembly(initial);
    const sources = settings.packages.map(sourceOf);
    const cm = settings.packages.find((e) => sourceOf(e) === 'npm:context-mode@1.0.169');
    assert.deepEqual(cm, { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] });
    // Managed packages are present regardless of context-mode's prior state.
    for (const spec of REQUIRED) assert.ok(sources.includes(spec), `must include ${spec}`);
    assert.ok(!sources.includes('npm:pi-goal-list-loop-audit@0.34.16'), 'retired glla package must be removed');
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
