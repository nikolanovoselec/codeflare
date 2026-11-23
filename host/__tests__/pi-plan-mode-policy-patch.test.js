import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPECTED_PI_PLAN_MODE_VERSION,
  patchPiPlanModeDirectory,
} from '../../scripts/patch-pi-plan-mode-tool-policy.mjs';

const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

// Exercise the retained, integrity-pinned registry archives directly; no source
// delta reconstruction or network access is needed.
const PLAN_FIXTURES = {
  [EXPECTED_PI_PLAN_MODE_VERSION]: ['sha512-pBLJdDWsANbMmRkTtTUcEJO95WY3tRmbWbS57uKIHsbQ5dc5sStD20R4qpcGXSl/r5tyPVR2Gru/YqwCqpmJ3Q=='],
  '0.56.0': ['sha512-sxbIODVaV6Ct+eD+lDN+tEn0mKtU9PG7rkkVhF6EC1d7t6YLHi1ixFhrKwMrJmsAPfkCnBKKImJcXx/bMFateg==', 'chunk-57OBPS7P.js'],
  '0.58.3': ['sha512-mC2dOLXrsLedLH4VrX0t3wwdXrr9AccoI8SgvYYn0KewaR6hZ0a6fIyLnReVlnJ4zNcjhdwBKWujrM49EW4zsg==', 'chunk-L2CXUWCH.ts'],
  '0.59.2': ['sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==', 'chunk-MJV6WNHK.ts'],
  '0.59.4': ['sha512-ISq9YB3+4PWqL4JSxJCBASb844NcnKH/RuGuIJwdNk8xmtGKDYOnjSrkfl+MBiSTImV56m7WX0TBBcG/0FuGYA==', 'chunk-MJV6WNHK.ts'],
  '0.59.6': ['sha512-c749Stq0YL0Sj3W62o8puWOUhvjbExGu4MAreepnuodI3mqDdzm10duT3broRD7J0RdRVJ0dotONH7lT5oxEGA==', 'chunk-W7D6N2MI.ts'],
  '0.60.0': ['sha512-ea+KiLQo4P3tn5Orp/l8sdsvSXjq+Ws3032hakwh9bse0TkONjDpAXPrgww2ppL9XE1jE1kson6jr0jHxpD1kQ==', 'chunk-UJ6TV2YV.ts'],
  '0.60.1': ['sha512-TRG8ncSkkS9qgDSxIgRr5S5hohvB9pC/GaNb1OrIDnkXTDVL9SlU27B45MoZILQdTLzo8qklaniyhBx+7xZ4RA==', 'chunk-UJ6TV2YV.ts'],
};
const ENTRYPOINTS = ['src/plan-mode.ts', 'dist/index.ts'];
const policyPaths = version => ['src/tool-policy.ts', `dist/chunks/${PLAN_FIXTURES[version][1]}`];

function extractPlanFixture(version, root) {
  const archivePath = join(FIXTURES_DIRECTORY, `narumitw-pi-plan-mode-${version}.tgz`);
  const archive = readFileSync(archivePath);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, PLAN_FIXTURES[version][0]);
  execFileSync('tar', ['-xzf', archivePath, '-C', root, '--strip-components=1'], { stdio: 'ignore' });
}

const PINNED_RUNTIME_STUBS = {
  name: 'pinned-runtime-stubs',
  setup(bundle) {
    bundle.onResolve(
      { filter: /^@(?:earendil-works\/pi-(?:coding-agent|tui)|narumitw\/pi-tui-kit(?:\/(?:editor-status-widget|terminal-document|terminal-text))?)$/ },
      ({ path }) => ({ path, namespace: 'pinned-runtime-stub' }),
    );
    bundle.onLoad({ filter: /.*/, namespace: 'pinned-runtime-stub' }, () => ({
      loader: 'js',
      contents: `
        export const defineMenu = (definition) => definition;
        export const getAgentDir = () => process.cwd();
        export const getMarkdownTheme = () => ({});
        export const runMenu = async () => ({ kind: "cancel" });
        export const stripTerminalSequences = (value) => value;
        // Fixture inputs contain no terminal controls; UI sanitation is an
        // external boundary, not the Plan behavior under test.
        export const sanitizeTerminalText = (value) => value;
        export const truncateToWidth = (value) => value;
        export const visibleWidth = (value) => value.length;
        export const sanitizeTerminalDocument = (value) => value;
        export const hardWrapTerminalDocument = (value) => value.split('\\n');
        export const getKeybindings = () => ({ getResolvedBindings: () => ({}) });
        export const matchesKey = () => false;
        export const isKeyRelease = () => false;
        export const isKeyRepeat = () => false;
        export const withFileMutationQueue = async (_path, operation) => operation();
        export class Markdown {}
        export class EditorStatusWidget {}
      `,
    }));
  },
};

const fixtureRequire = createRequire(import.meta.url);
function fixtureEsbuild() {
  let modulePath;
  let imageFallback = false;
  try {
    modulePath = fixtureRequire.resolve('esbuild');
  } catch (error) {
    const installedPackage = fixtureRequire.resolve.paths('esbuild')
      ?.some((root) => existsSync(join(root, 'esbuild/package.json')));
    if (error.code !== 'MODULE_NOT_FOUND' || installedPackage) throw error;
    const imageRoot = '/opt/codeflare/npm-tools/node_modules/esbuild';
    const locked = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'))
      .packages['node_modules/esbuild'].version;
    const installed = JSON.parse(readFileSync(join(imageRoot, 'package.json'), 'utf8'));
    if (installed.name !== 'esbuild' || installed.version !== locked) {
      throw new Error(`Approved image esbuild must match the locked version ${locked}`);
    }
    modulePath = join(imageRoot, 'lib/main.js');
    imageFallback = true;
  }
  // Loading failures are not a missing-package fallback: preserve them as failures.
  return { esbuild: fixtureRequire(modulePath), imageFallback };
}

async function bundleFixture(entryPoint, outputPath, exportName = 'default') {
  const { esbuild: { build }, imageFallback } = fixtureEsbuild();
  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [PINNED_RUNTIME_STUBS],
    // Only image-backed fixtures may resolve peers from the installed image runtime.
    nodePaths: [join(process.cwd(), 'node_modules'), ...(imageFallback ? ['/opt/codeflare/npm-tools/node_modules'] : [])],
  });
  const fixture = await import(`${pathToFileURL(outputPath).href}?fixture=${Date.now()}`);
  return exportName === 'namespace' ? fixture : fixture.default;
}

function createExtensionHarness() {
  const commands = new Map();
  const lifecycle = new Map();
  const eventListeners = new Map();
  const entries = [];
  const tools = [
    { name: 'read', description: 'Read files', sourceInfo: { source: 'builtin' } },
    { name: 'bash', description: 'Run bounded commands', sourceInfo: { source: 'builtin' } },
    { name: 'edit', description: 'Edit files', sourceInfo: { source: 'builtin' } },
  ];
  let activeTools = [];
  let thinkingLevel = 'medium';
  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const ui = new Proxy({}, { get: () => () => undefined });
  const api = new Proxy({
    events: {
      on(channel, listener) {
        const listeners = eventListeners.get(channel) ?? [];
        listeners.push(listener);
        eventListeners.set(channel, listeners);
        return () => eventListeners.set(channel, listeners.filter((candidate) => candidate !== listener));
      },
      emit(channel, payload) {
        return Promise.all((eventListeners.get(channel) ?? []).map((listener) => listener(payload)));
      },
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => {
      tools.push({
        ...definition,
        sourceInfo: { source: 'extension', path: 'pinned-fixture' },
      });
      activeTools.push(definition.name);
    },
    registerFlag: () => undefined,
    getFlag: () => false,
    on(name, listener) {
      const listeners = lifecycle.get(name) ?? [];
      listeners.push(listener);
      lifecycle.set(name, listeners);
    },
    appendEntry(customType, data) {
      // Session persistence snapshots values; later runtime mutation must not
      // rewrite the previously persisted branch in this behavioral harness.
      entries.push({ type: 'custom', customType, data: structuredClone(data) });
    },
    sendMessage: (message) => { entries.push({ type: 'custom_message', ...message }); },
    getAllTools: () => [...tools],
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools) => { activeTools = [...tools]; },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => { thinkingLevel = level; },
  }, { get: (target, property) => target[property] ?? (() => undefined) });
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: 'interactive',
    sessionManager,
    ui,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  return {
    activeTools: () => activeTools,
    api,
    commands,
    ctx,
    entries,
    tools,
    dispatch: async (name, event = {}) => {
      let result;
      for (const listener of lifecycle.get(name) ?? []) result = await listener(event, ctx) ?? result;
      return result;
    },
    startSession: async () => {
      for (const listener of lifecycle.get('session_start') ?? []) await listener({}, ctx);
    },
    runContext: async () => {
      let event = { messages: [] };
      for (const listener of lifecycle.get('context') ?? []) {
        event = await listener(event, ctx) ?? event;
      }
      return event;
    },
  };
}

async function assertParsedShellAuthorization(root, version) {
  const configured = { git: ['status', 'diff'], gh: ['pr view'] };
  for (const [index, path] of policyPaths(version).entries()) {
    const policy = await bundleFixture(join(root, path), join(root, `parsed-${index}.mjs`), 'namespace');
    for (const check of [policy.findBlockedCommandSegment, policy.findBlockedPowerShellCommandSegment]) {
      assert.equal(check('git status', configured), undefined);
      for (const command of ['git status; touch sentinel', 'git status && rm sentinel', 'git status > sentinel',
        'git status $(touch sentinel)', 'git status | sh', 'git diff --output=sentinel', 'gh pr view --json title --web']) {
        assert.notEqual(check(command, configured), undefined, command);
      }
    }
  }
}

for (const version of ['0.56.0', '0.58.3', '0.59.2', '0.60.1']) {
  it(`REQ-AGENT-266 AC2: Plan ${version} parses configured shell reads before authorizing them`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-parsed-policy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture(version, root);
    patchPiPlanModeDirectory(version, root);
    await assertParsedShellAuthorization(root, version);
  });
}

it('REQ-AGENT-266 AC2/AC3: prepared Plan rejects scripts carrying version flags while retaining standalone version reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-plan-version-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  extractPlanFixture('0.60.1', root);
  patchPiPlanModeDirectory('0.60.1', root);
  const configured = { git: ['status', 'diff'], gh: ['pr view'] };
  const denied = [
    'node action.js --version', 'node --no-warnings action.js --version',
    'node -e "void 0" --version', 'python action.py --version',
    'python3 -c "print(1)" --version', 'tsc action.ts --version',
    'biome check . --version', 'ruff check . --version', 'ty check . --version',
  ];
  for (const [index, file] of policyPaths('0.60.1').entries()) {
    const policy = await bundleFixture(join(root, file), join(root, `version-policy-${index}.mjs`), 'namespace');
    for (const command of ['node --version', 'python --version', 'python3 --version', 'tsc --version', 'git status']) {
      assert.equal(policy.findBlockedCommandSegment(command, configured), undefined, command);
    }
    assert.equal(policy.findBlockedPowerShellCommandSegment('git status', configured), undefined);
    // PowerShell already rejects interpreter commands; do not widen its existing policy.
    assert.notEqual(policy.findBlockedPowerShellCommandSegment('node --version', configured), undefined);
    for (const check of [policy.findBlockedCommandSegment, policy.findBlockedPowerShellCommandSegment]) {
      for (const command of denied) assert.notEqual(check(command, configured), undefined, command);
    }
  }
  const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'version-plan.mjs'));
  const harness = createExtensionHarness();
  extension(harness.api, { settingsPath: join(root, 'settings.json') });
  await harness.startSession();
  t.after(() => harness.dispatch('session_shutdown'));
  harness.api.setActiveTools(['read']);
  await harness.commands.get('plan').handler('start', harness.ctx);
  await harness.runContext();
  // The real exposure finalizer activates the captured policy before execution.
  harness.api.setActiveTools(['read', 'bash']);
  assert.equal(await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'node --version' } }), undefined);
  assert.equal((await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'node action.js --version' } }))?.block, true);
});

for (const version of Object.keys(PLAN_FIXTURES)) {
  it(`REQ-AGENT-266 AC3: Plan ${version} starts with registered discovery tools without expanding provider exposure`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-registered-policy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture(version, root);
    patchPiPlanModeDirectory(version, root);
    const patchedPlan = readFileSync(join(root, 'dist/index.ts'), 'utf8');
    patchPiPlanModeDirectory(version, root);
    assert.equal(readFileSync(join(root, 'dist/index.ts'), 'utf8'), patchedPlan);
    assert.throws(() => patchPiPlanModeDirectory('0.55.2', root), /Unsupported Plan Mode version/);

    const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'plan.mjs'));
    const harness = createExtensionHarness();
    extension(harness.api, { settingsPath: join(root, 'settings.json') });
    await harness.startSession();
    harness.api.setActiveTools(['read']);
    await harness.commands.get('plan').handler('start', harness.ctx);
    await harness.runContext();
    const planState = harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1);
    assert.equal(planState?.customType, 'plan-mode-state');
    assert.equal(planState?.data?.enabled, true);
    assert.ok(planState?.data?.workflowToolPolicy?.resolved);
    assert.deepEqual(planState.data.workflowToolPolicy.allowedNames, ['bash', 'read']);
    assert.deepEqual(harness.activeTools(), ['read']);
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.dispatch('session_shutdown');
  });
}

for (const version of ['0.60.0', '0.60.1']) {
  it(`REQ-AGENT-152: Plan ${version} is repeatable and fails closed before writes on manifest or source drift`, t => {
    const prepare = root => patchPiPlanModeDirectory(version, root);
    const paths = [...ENTRYPOINTS, ...policyPaths(version)];
    for (const phase of ['pristine', 'prepared']) {
      for (const drift of ['name', 'version', 'entrypoint', ...paths]) {
        const root = mkdtempSync(join(tmpdir(), 'pi-plan-identity-'));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        extractPlanFixture(version, root);
        const destinations = ['package.json', ...paths];
        if (phase === 'prepared') {
          prepare(root);
          const before = destinations.map(path => readFileSync(join(root, path)));
          prepare(root);
          assert.deepEqual(destinations.map(path => readFileSync(join(root, path))), before);
        }
        if (paths.includes(drift)) {
          writeFileSync(join(root, drift), `${readFileSync(join(root, drift), 'utf8')}\n// unreviewed drift\n`);
        } else {
          const path = join(root, 'package.json');
          const manifest = JSON.parse(readFileSync(path, 'utf8'));
          if (drift === 'entrypoint') manifest.pi.extensions = ['./unknown.ts'];
          else manifest[drift] = 'unreviewed';
          writeFileSync(path, JSON.stringify(manifest));
        }
        const before = destinations.map(path => readFileSync(join(root, path)));
        assert.throws(() => prepare(root), /digest|identity|version|expected|entrypoint/);
        assert.deepEqual(destinations.map(path => readFileSync(join(root, path))), before);
        assert.throws(() => patchPiPlanModeDirectory('0.60.2', root), /Unsupported Plan Mode version/);
        assert.deepEqual(destinations.map(path => readFileSync(join(root, path))), before);
      }
    }
  });
}

it('REQ-AGENT-152: Plan 0.59.6 validates the exact chunk and all destinations before writing', t => {
  const paths = [...ENTRYPOINTS, ...policyPaths('0.59.6')];
  for (const phase of ['pristine', 'prepared']) {
    for (const path of paths) {
      const root = mkdtempSync(join(tmpdir(), 'pi-plan-0596-identity-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      extractPlanFixture('0.59.6', root);
      if (phase === 'prepared') {
        patchPiPlanModeDirectory('0.59.6', root);
        const before = paths.map(path => readFileSync(join(root, path)));
        patchPiPlanModeDirectory('0.59.6', root);
        assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
      }
      writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + '\n// unreviewed drift\n');
      const before = paths.map(path => readFileSync(join(root, path)));
      assert.throws(() => patchPiPlanModeDirectory('0.59.6', root), /source digest/);
      assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
    }
  }
});

it('REQ-AGENT-152: Plan 0.59.6 manifest drift fails before preparing any artifact', t => {
  for (const field of ['name', 'version', 'entrypoint']) {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-manifest-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture('0.59.6', root);
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (field === 'entrypoint') manifest.pi.extensions = ['./unreviewed.ts'];
    else manifest[field] = 'unreviewed';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const paths = [...ENTRYPOINTS, ...policyPaths('0.59.6'), 'package.json'];
    const before = paths.map(path => readFileSync(join(root, path)));
    assert.throws(() => patchPiPlanModeDirectory('0.59.6', root),
      /identity|version|expected|entrypoint/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
  }
});

it('REQ-AGENT-152: unreviewed Plan command layout fails without partial writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-plan-policy-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  extractPlanFixture('0.58.3', root);
  const paths = [...ENTRYPOINTS, ...policyPaths('0.58.3')];
  const chunk = join(root, paths.at(-1));
  writeFileSync(chunk, readFileSync(chunk, 'utf8').replace('if (matchesConfiguredSafeSubcommand(command, safeSubcommands)) return void 0;', 'return void 0;'));
  const before = paths.map((path) => readFileSync(join(root, path), 'utf8'));
  assert.throws(() => patchPiPlanModeDirectory('0.58.3', root), /command policy anchors/);
  assert.deepEqual(paths.map((path) => readFileSync(join(root, path), 'utf8')), before);
  assert.throws(() => patchPiPlanModeDirectory('0.56.1', root), /Unsupported Plan Mode version/);
  assert.deepEqual(paths.map((path) => readFileSync(join(root, path), 'utf8')), before);
});

it('REQ-AGENT-266 AC2/AC3: transformed pinned Plan candidate rejects unsafe commands and invalid publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-plan-candidate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  extractPlanFixture('0.58.3', root);
  patchPiPlanModeDirectory('0.58.3', root);
  // Exercise the generated candidate entrypoint, not a command recorder.
  const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'plan.mjs'));
  const harness = createExtensionHarness();
  extension(harness.api, { settingsPath: join(root, 'settings.json') });
  await harness.startSession();
  harness.api.setActiveTools(['read', 'bash']);
  await harness.commands.get('plan').handler('start', harness.ctx);
  await harness.runContext();
  assert.equal(await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'git status' } }), undefined);
  const denied = await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'git status && touch sentinel' } });
  assert.equal(denied?.block, true);
  const complete = harness.tools.find((tool) => tool.name === 'plan_mode_complete');
  for (const plan of ['', '   ', 'x'.repeat(50_001), 42]) {
    await assert.rejects(() => complete.execute('invalid', { plan }, undefined, undefined, harness.ctx));
    assert.equal(harness.entries.filter((entry) => entry.customType === 'plan-mode-state').at(-1).data.latestPlan, undefined);
  }
  const candidate = '# Exact candidate\n\nPreserve every decision.';
  const published = await complete.execute('valid', { plan: `  ${candidate}\n` }, undefined, undefined, harness.ctx);
  assert.equal(published.details.plan, candidate);
  assert.equal(published.content[0].text, `**Proposed Plan**\n\n${candidate}`);
  assert.equal(harness.entries.filter((entry) => entry.customType === 'plan-mode-state').at(-1).data.latestPlan, candidate);
  await harness.commands.get('plan').handler('exit', harness.ctx);
  await harness.dispatch('session_shutdown');
});

for (const targetVersion of ['0.59.4', '0.59.6', '0.60.0']) {
  it(`REQ-AGENT-266 AC2/AC3: Plan ${targetVersion} prepares both entrypoints with registered-tool policy and parsed shell authorization`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-entrypoints-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture(targetVersion, root);
    const paths = [...ENTRYPOINTS, ...policyPaths(targetVersion)];
    // Qualify the native no-op before applying any compatibility preparation.
    for (const [index, entry] of ENTRYPOINTS.entries()) {
      const native = await bundleFixture(join(root, entry), join(root, `native-${index}.mjs`));
      const harness = createExtensionHarness();
      native(harness.api, { settingsPath: join(root, `native-settings-${index}.json`) });
      await harness.startSession();
      harness.api.setActiveTools(harness.tools.map(tool => tool.name));
      await harness.commands.get('plan').handler('start', harness.ctx);
      await harness.runContext();
      const plan = '# Upstream intent\n\nThe native boundary preserves this plan.';
      await harness.tools.find(tool => tool.name === 'plan_mode_complete')
        .execute('native-publish', { plan }, undefined, undefined, harness.ctx);
      const current = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      await harness.dispatch('before_agent_start', { messageType: 'custom',
        message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
      assert.equal(current().latestPlan, plan);
      assert.equal(current().awaitingAction, true);
      await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the plan', systemPrompt: '' });
      assert.equal(current().latestPlan, undefined);
      assert.equal(current().awaitingAction, false);
      await harness.commands.get('plan').handler('exit', harness.ctx);
      await harness.dispatch('session_shutdown');
    }
    patchPiPlanModeDirectory(targetVersion, root);
    const prepared = paths.map(path => readFileSync(join(root, path)));
    patchPiPlanModeDirectory(targetVersion, root);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path))), prepared,
      'repeat preparation preserves all generated artifacts');
    for (const [index, entry] of ENTRYPOINTS.entries()) {
      const extension = await bundleFixture(join(root, entry), join(root, `plan-${index}.mjs`));
      const harness = createExtensionHarness();
      extension(harness.api, { settingsPath: join(root, `settings-${index}.json`) });
      await harness.startSession();
      harness.api.setActiveTools(['read']);
      await harness.commands.get('plan').handler('start', harness.ctx);
      await harness.runContext();
      const state = harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      assert.equal(state.enabled, true);
      assert.deepEqual(state.workflowToolPolicy.allowedNames, ['bash', 'read']);
      assert.deepEqual(harness.activeTools(), ['read'], 'policy capture does not expand ordinary provider exposure');
      assert.equal(await harness.dispatch('tool_call', { toolName: 'read', input: { path: 'README.md' } }), undefined);
      assert.equal((await harness.dispatch('tool_call', { toolName: 'edit', input: {} }))?.block, true);
      for (const plan of ['', '   ', 42]) {
        await assert.rejects(() => harness.tools.find(tool => tool.name === 'plan_mode_complete')
          .execute('invalid', { plan }, undefined, undefined, harness.ctx));
      }
      const plan = '# Native custom-turn boundary\n\nRetain the published user intent.';
      const complete = harness.tools.find(tool => tool.name === 'plan_mode_complete');
      await complete.execute('publish', { plan }, undefined, undefined, harness.ctx);
      const current = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      await harness.dispatch('before_agent_start', { messageType: 'custom',
        message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
      assert.equal(current().latestPlan, plan, 'upstream custom-turn boundary needs no second patch');
      assert.equal(current().awaitingAction, true);
      await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the plan', systemPrompt: '' });
      assert.equal(current().latestPlan, undefined);
      assert.equal(current().awaitingAction, false);
      await harness.commands.get('plan').handler('exit', harness.ctx);
      await harness.dispatch('session_shutdown');
    }
    await assertParsedShellAuthorization(root, targetVersion);
    writeFileSync(join(root, paths[0]), Buffer.concat([prepared[0], Buffer.from('\n// drift after preparation\n')]));
    const drifted = paths.map(path => readFileSync(join(root, path)));
    assert.throws(() => patchPiPlanModeDirectory(targetVersion, root), /source digest/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path))), drifted,
      'repeat preparation rejects drift before any artifact write');
  });
}

for (const version of ['0.59.2', '0.59.4']) {
  it(`REQ-AGENT-266 AC3: candidate Plan ${version} retains published user intent through custom turns but invalidates it on a user prompt`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-custom-turn-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture(version, root);
    patchPiPlanModeDirectory(version, root);
    const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'plan.mjs'));
    const harness = createExtensionHarness();
    extension(harness.api, { settingsPath: join(root, 'settings.json') });
    await harness.startSession();
    harness.api.setActiveTools(['read', 'bash']);
    await harness.commands.get('plan').handler('start', harness.ctx);
    await harness.runContext();
    const plan = '# Published intent\n\nKeep the reviewed decisions until the user acts.';
    await harness.tools.find(tool => tool.name === 'plan_mode_complete')
      .execute('publish', { plan }, undefined, undefined, harness.ctx);
    const state = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
    assert.equal(state().latestPlan, plan);
    assert.equal(state().awaitingAction, true);
    await harness.dispatch('before_agent_start', { messageType: 'custom',
      message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
    assert.equal(state().latestPlan, plan);
    assert.equal(state().awaitingAction, true);
    await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the proposed plan', systemPrompt: '' });
    assert.equal(state().latestPlan, undefined);
    assert.equal(state().awaitingAction, false);
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.dispatch('session_shutdown');
  });

  it(`REQ-AGENT-152: candidate Plan ${version} chunk drift rejects the complete transform without partial writes`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-candidate-drift-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPlanFixture(version, root);
    const paths = ['package.json', ...ENTRYPOINTS, ...policyPaths(version)];
    const chunk = join(root, paths.at(-1));
    writeFileSync(chunk, readFileSync(chunk, 'utf8').replace('if (matchesConfiguredSafeSubcommand(segment, safeSubcommands)) return true;', 'return true;'));
    const before = paths.map(path => readFileSync(join(root, path), 'utf8'));
    assert.throws(() => patchPiPlanModeDirectory(version, root), /command policy anchors|source digest/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path), 'utf8')), before);
  });
}
