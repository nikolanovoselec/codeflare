// Runs the real embedded Node program from entrypoint.sh that assembles Pi's
// ~/.pi/agent/settings.json `packages` array, against fixture settings files.
// This is the "run the real thing" coverage (per tdd-discipline.md) for:
//   - context-mode being disabled by default while remaining controllable through explicit /ctx off/on,
//   - the managed extension packages, including Goal, Usage, and Evaluate, being present in
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
const piPackage = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
// Derived from the preseed, never spelled out here. A bump that moves the preseed pin but
// misses entrypoint.sh leaves the container asking npm for a version the image never baked,
// and a hand-maintained literal in this file would agree with itself and pass anyway. Pi
// itself is the runtime the packages load into, not one of the managed packages.
const REQUIRED = Object.entries(piPackage.dependencies)
  .filter(([name]) => name !== '@earendil-works/pi-coding-agent')
  .map(([name, version]) => `npm:${name}@${version}`);

const REVIEWED_GOAL_RELEASES = Object.freeze({
  '0.46.0': 'sha512-NY6fsXQmdD1hfX1f4ijI1fsJskoV6KGu7GoY0ZbzCUsfM5LKS7VsKNpGWuRMsOvjgd2sJCPKv8se/eUDu5wGGg==',
  '0.49.5': 'sha512-0rMVURaipVyJCXq6t34WVZQGfCjyESgme0MJ0U9hZ22DeyobhQV4Ft6BqCoBgRNtgf+HrAuZrXCJmBU54Wd0gQ==',
  '0.49.7': 'sha512-7FznIa3HGEsMkppnv7CLW6/TCvtuslKdk+BgrcvNrmJVK/HJfo5rTBCxCzahW2BbEy47Ixfsdqzrg6HL4LX8qw==',
  '0.53.0': 'sha512-cmWowqAzlkgRLKYp2hFnUZvEEs6G6aGjEOazBWNW88T7LB9cd/AzOFOGYvA1QxxsGtIdOuFRZJVhfAJDGsAcjw==',
  '0.54.2': 'sha512-RbrArj7OoP/6FGMZ+yBtKiRyz1r1PjTFdPJv+23MhoGxsyNB6suJk8VDni9jOk6lS5lwsJhaj/S1s1AT8urtnw==',
  '0.54.3': 'sha512-UgPF7uKm6B9XITmOji3uRJGeeQiBeFODwiiyFe3V3dUPWbCSXUUhvF0RuorkxNnsp1uPN46tELNxK9riBTNMZg==',
});

describe('Goal package preseed (REQ-AGENT-111)', () => {
  it('replaces glla with one exact reviewed and integrity-locked Goal release', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    const version = pkg.dependencies['@narumitw/pi-goal'];
    const expectedIntegrity = REVIEWED_GOAL_RELEASES[version];
    assert.equal(version, '0.54.3');
    assert.ok(expectedIntegrity, `unreviewed pi-goal release: ${String(version)}`);
    assert.equal(pkg.dependencies['pi-goal-list-loop-audit'], undefined);
    const goal = lock.packages['node_modules/@narumitw/pi-goal'];
    assert.equal(goal.version, version);
    assert.equal(goal.integrity, expectedIntegrity);
    assert.equal(lock.packages['node_modules/pi-goal-list-loop-audit'], undefined);
  });

});

describe('Usage package preseed (REQ-AGENT-131)', () => {
  it('pins the reviewed upstream package and integrity-locks its Pi entrypoint', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    const version = pkg.dependencies['@narumitw/pi-usage'];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const usage = lock.packages['node_modules/@narumitw/pi-usage'];
    assert.equal(usage.version, version);
    assert.equal(usage.resolved, `https://registry.npmjs.org/@narumitw/pi-usage/-/pi-usage-${version}.tgz`);
    assert.match(usage.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.deepEqual(usage.peerDependencies, {
      '@earendil-works/pi-ai': '*',
      '@earendil-works/pi-coding-agent': '*',
    });
  });
});

describe('Evaluate package preseed (REQ-AGENT-133)', () => {
  it('pins the reviewed upstream release and integrity-locks its declared extension entrypoint', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    const version = pkg.dependencies['pi-evaluate'];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const evaluate = lock.packages['node_modules/pi-evaluate'];
    assert.equal(evaluate.version, version);
    assert.equal(evaluate.resolved, `https://registry.npmjs.org/pi-evaluate/-/pi-evaluate-${version}.tgz`);
    assert.match(evaluate.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    // The skill ships inside the package, so the peer range is what keeps a Pi
    // upgrade from silently loading an extension built against an older API.
    assert.deepEqual(evaluate.peerDependencies, { '@earendil-works/pi-coding-agent': '>=0.82.0' });
  });
});

describe('Plan mode package preseed (REQ-AGENT-152)', () => {
  it('pins the reviewed upstream release and integrity-locks its declared extension entrypoint', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    const version = pkg.dependencies['@narumitw/pi-plan-mode'];
    assert.equal(version, '0.55.3');
    const planMode = lock.packages['node_modules/@narumitw/pi-plan-mode'];
    assert.equal(planMode.version, version);
    assert.equal(
      planMode.resolved,
      `https://registry.npmjs.org/@narumitw/pi-plan-mode/-/pi-plan-mode-${version}.tgz`,
    );
    assert.equal(
      planMode.integrity,
      'sha512-pBLJdDWsANbMmRkTtTUcEJO95WY3tRmbWbS57uKIHsbQ5dc5sStD20R4qpcGXSl/r5tyPVR2Gru/YqwCqpmJ3Q==',
    );
    assert.deepEqual(planMode.peerDependencies, {
      '@earendil-works/pi-coding-agent': '*',
      '@earendil-works/pi-tui': '*',
    });
  });
});

describe('rpiv-todo upstream session isolation (REQ-AGENT-081)', () => {
  it('pins the reviewed upstream release and retains no source-override machinery', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package.json'), 'utf-8'));
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../preseed/agents/pi/package-lock.json'), 'utf-8'));
    assert.equal(pkg.dependencies['@juicesharp/rpiv-todo'], '2.7.1');
    assert.equal(lock.packages['node_modules/@juicesharp/rpiv-todo'].version, '2.7.1');
    assert.equal(
      lock.packages['node_modules/@juicesharp/rpiv-todo'].integrity,
      'sha512-5SCPe1Z2ofgiK805fYm5dGott6XA8zlDMeQHADq50S2UFjH1EuXpTnSmx+X8JUPMIzyRnBY3gVltz525oWH52Q==',
    );
    assert.equal(pkg.scripts?.postinstall, undefined);
    assert.ok(!existsSync(resolve(__dirname, '../../preseed/agents/pi/npm/rpiv-todo-session-isolation')));
  });
});

describe('Pi settings.json packages assembly (entrypoint.sh)', () => {
  it('REQ-AGENT-076 AC1 / REQ-AGENT-131 AC1 / REQ-AGENT-133 AC1: fresh container assembles required packages with context-mode disabled', () => {
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
