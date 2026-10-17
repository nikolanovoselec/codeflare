// Runs the real embedded Node program from entrypoint.sh that assembles Pi's
// ~/.pi/agent/settings.json `packages` array, against fixture settings files.
// This is the "run the real thing" coverage (per tdd-discipline.md) for:
//   - context-mode being disabled by default while remaining controllable through explicit /ctx off/on,
//   - the managed extension packages, including Goal, Open TUI, and Evaluate, being present in
//     `required` so they are
//     available WITH AND WITHOUT context-mode — toggling /ctx never removes them,
//   - advisor guidance being user-invoked only while preserving user model config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

function runHeredoc(body, filename, initialJson, times = 1, reviewAssets = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-pkgs-'));
  const scriptPath = join(dir, 'script.cjs'); // .cjs: the program uses require()/argv
  const jsonPath = join(dir, filename);
  writeFileSync(scriptPath, body);
  writeFileSync(jsonPath, initialJson);
  if (reviewAssets) {
    mkdirSync(join(dir, 'extensions'));
    for (const name of ['review-enforcement.ts', 'operator-review-remote.ts',
      'operator-review-selector.ts']) writeFileSync(join(dir, 'extensions', name), 'export default () => {}');
  }
  for (let index = 0; index < times; index++) {
    if (index === 1 && reviewAssets === 'curation-local-only') {
      rmSync(join(dir, 'extensions', 'operator-review-selector.ts'));
      rmSync(join(dir, 'extensions', 'operator-review-remote.ts'));
    }
    const result = spawnSync('node', [scriptPath, jsonPath], { encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`heredoc exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(readFileSync(jsonPath, 'utf-8'));
}

function runAssembly(initialSettings, times = 1, reviewAssets = false) {
  return runHeredoc(extractAssembly(), 'settings.json', initialSettings, times, reviewAssets);
}

function runAdvisorGuidanceMerge(initialConfig) {
  return runHeredoc(extractAdvisorGuidanceMerge(), 'advisor.json', initialConfig);
}

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry && entry.source);
const piPackage = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
// Derived from the preseed, never spelled out here. A bump that moves the preseed pin but
// misses entrypoint.sh leaves the container asking npm for a version the image never baked,
// and a hand-maintained literal in this file would agree with itself and pass anyway. Pi
// itself is the runtime the packages load into, not one of the managed packages.
const REQUIRED = Object.entries(piPackage.dependencies)
  .filter(([name]) => name !== '@earendil-works/pi-coding-agent')
  .map(([name, version]) => `npm:${name}@${version}`);

describe('Pi settings.json packages assembly (entrypoint.sh)', () => {
  it('REQ-AGENT-076 AC1 / REQ-AGENT-133 AC1: fresh container assembles required packages with context-mode disabled', () => {
    const settings = runAssembly('{}');
    const sources = settings.packages.map(sourceOf);
    assert.ok(REQUIRED.length > 0, 'the derived required set must not be empty');
    for (const spec of REQUIRED) {
      assert.ok(sources.includes(spec), `assembled packages must include ${spec}`);
    }
    const contextMode = settings.packages.find((entry) => sourceOf(entry) === 'npm:context-mode@1.0.169');
    assert.deepEqual(contextMode, { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] });
  });

  it('startup restores the disabled default while preserving managed and unrelated packages', () => {
    const initial = JSON.stringify({
      packages: [
        { source: 'npm:context-mode@1.0.169', extensions: [] },
        'npm:pi-goal-list-loop-audit@0.34.16',
        'npm:pi-caveman@1.0.8',
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
    assert.ok(!sources.includes('npm:pi-caveman@1.0.8'), 'retired response package must be removed');
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
    const once = runAssembly(JSON.stringify({ extensions: ['user-ext.ts'] }), 1, true);
    const twice = runAssembly(JSON.stringify({ extensions: ['user-ext.ts'] }), 2, true);

    assert.deepEqual(runAssembly(JSON.stringify({ extensions: ['user-ext.ts'] })).extensions,
      ['user-ext.ts', '-builtin:mcp'], 'a local-only release retains local Review and disables duplicate native MCP');
    assert.deepEqual(runAssembly(JSON.stringify({ extensions: ['user-ext.ts'] }), 2,
      'curation-local-only').extensions, ['user-ext.ts', '-builtin:mcp'],
    'a restored local-only release removes obsolete managed exclusions in the same session home');
    for (const settings of [once, twice]) {
      assert.equal(settings.extensions[0], 'user-ext.ts');
      assert.equal(settings.extensions.length, 4, 'Review and native MCP exclusions must not accumulate');
      assert.equal(settings.extensions[1], '-builtin:mcp');
      assert.deepEqual(settings.extensions.slice(2).map(entry => entry.split('/').at(-1)),
        ['review-enforcement.ts', 'operator-review-remote.ts']);
      assert.ok(settings.extensions.slice(2).every(entry => entry.startsWith('-/')));
    }
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

// Exact source/filter and removed-identity outputs are intentional startup
// migration contracts. Native enabled behavior is exercised by open-tui.test.mjs.
describe('REQ-AGENT-056 / REQ-AGENT-209: Open TUI adoption and managed Usage retirement', () => {
  const expected = { source: 'npm:pi-open-tui@0.3.11', extensions: [] };
  it('REQ-AGENT-056: fresh startup supplies exactly the reviewed adapter-owned package filter', () => {
    const settings = runAssembly('{}');
    assert.deepEqual(settings.packages.filter(entry => /^npm:pi-open-tui(?:@|$)/.test(sourceOf(entry))), [expected]);
    assert.ok(!settings.packages.some(entry => /^npm:@narumitw\/pi-usage(?:@|$)/.test(sourceOf(entry))));
    assert.equal(piPackage.dependencies['pi-open-tui'], '0.3.11'); // Intentional release pin.
    assert.equal(piPackage.dependencies['@narumitw/pi-usage'], undefined);
  });

  for (const stale of ['npm:pi-open-tui', 'npm:pi-open-tui@0.2.0',
    { source: 'npm:pi-open-tui@0.3.11', extensions: ['extensions/open-tui/index.ts'], skills: [] }]) {
    it(`REQ-AGENT-209 AC1/AC2 / REQ-AGENT-056: restored ${JSON.stringify(stale)} converges without deleting similarly named user packages`, () => {
      const user = { source: 'npm:user-extension@1.0.0', extensions: ['keep.ts'], userField: true };
      const initial = {
        packages: [stale, 'npm:pi-open-tui@0.1.0', 'npm:@narumitw/pi-usage',
          'npm:@narumitw/pi-usage@0.61.1', 'npm:@narumitw/pi-usage@0.60.0',
          { source: 'npm:@narumitw/pi-usage', extensions: [] },
          { source: 'npm:@narumitw/pi-usage@0.61.1', extensions: ['dist/index.ts'] },
          { source: 'npm:@narumitw/pi-usage@0.60.0' },
          'npm:@narumitw/pi-usage-extra@1.0.0', 'npm:pi-open-tui-extra@1.0.0', user],
        defaultModel: 'opaque-user-route', defaultThinkingLevel: 'off',
        customPreference: { keep: ['one', 'two'] }, extensions: ['user-extension.ts'],
      };
      const first = runAssembly(JSON.stringify(initial));
      const second = runAssembly(JSON.stringify(first));
      assert.deepEqual(second, first, 'complete settings migration is idempotent');
      assert.deepEqual(first.packages.filter(entry => /^npm:pi-open-tui(?:@|$)/.test(sourceOf(entry))), [expected]);
      assert.ok(!first.packages.some(entry => /^npm:@narumitw\/pi-usage(?:@|$)/.test(sourceOf(entry))));
      assert.ok(first.packages.includes('npm:@narumitw/pi-usage-extra@1.0.0'));
      assert.ok(first.packages.includes('npm:pi-open-tui-extra@1.0.0'));
      assert.deepEqual(first.packages.find(entry => sourceOf(entry) === user.source), user);
      for (const key of ['defaultModel', 'defaultThinkingLevel', 'customPreference']) assert.deepEqual(first[key], initial[key]);
      assert.deepEqual(first.extensions, ['user-extension.ts', '-builtin:mcp']);
      assert.deepEqual(first.packages.find(entry => /^npm:context-mode@/.test(sourceOf(entry))),
        { source: 'npm:context-mode@1.0.169', extensions: [], skills: [] });
      for (const required of REQUIRED) assert.ok(first.packages.some(entry => sourceOf(entry) === required), required);
    });
  }
});
