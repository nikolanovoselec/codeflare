import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
const rootPackage = readJson('package.json');
const rootLock = readJson('package-lock.json');
const sidebarLock = readJson('openvscode/agent-sidebar/package-lock.json');
const npmToolsPackage = readJson('preseed/npm-tools/package.json');
const npmToolsLock = readJson('preseed/npm-tools/package-lock.json');
const piPackage = readJson('preseed/agents/pi/package.json');
const piLock = readJson('preseed/agents/pi/package-lock.json');
const browserRunPackage = readJson('preseed/agents/claude/browser-run-mcp/package.json');
const browserRunLock = readJson('preseed/agents/claude/browser-run-mcp/package-lock.json');
const wranglerPackage = readJson('.github/npm-tools/wrangler/package.json');
const wranglerLock = readJson('.github/npm-tools/wrangler/package-lock.json');

const versionParts = (version) => version.split('.').map(Number);
const atLeast = (actual, minimum) => {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

function versionsOf(lockfile, dependency) {
  return Object.entries(lockfile.packages)
    .filter(([path]) => path.endsWith(`/node_modules/${dependency}`) || path === `node_modules/${dependency}`)
    .map(([, metadata]) => metadata.version)
    .filter(Boolean);
}

function assertCompleteIntegrityTree(lockfile) {
  for (const [path, metadata] of Object.entries(lockfile.packages)) {
    if (!path || metadata.link) continue;
    assert.ok(metadata.integrity, `${path} must have committed registry integrity`);
  }
}

describe('REQ-OPS-033: build dependencies have committed integrity', () => {
  it('privileged npm tool manifest has a complete committed integrity tree', () => {
    const expectedTools = [
      '@anthropic-ai/claude-code',
      '@earendil-works/pi-coding-agent',
      '@github/copilot',
      '@openai/codex',
      'bun',
      'chrome-devtools-mcp',
      'consult-llm-mcp',
      'context-mode',
      'opencode-ai',
      'oxlint',
    ];

    for (const tool of expectedTools) {
      assert.match(npmToolsPackage.dependencies[tool], /^\d+\.\d+\.\d+$/, `${tool} must have an exact image pin`);
    }
    assert.deepEqual(npmToolsLock.packages[''].dependencies, npmToolsPackage.dependencies);
    assertCompleteIntegrityTree(npmToolsLock);
  });

  it('dedicated Pi, Browser Run MCP, and Wrangler locks match their manifests', () => {
    assert.equal(
      piPackage.overrides['@earendil-works/pi-coding-agent'],
      npmToolsPackage.dependencies['@earendil-works/pi-coding-agent'],
    );
    assert.deepEqual(browserRunLock.packages[''].dependencies, browserRunPackage.dependencies);
    assert.equal(browserRunPackage.overrides['@hono/node-server'], '2.0.12');
    assert.deepEqual(wranglerLock.packages[''].dependencies, wranglerPackage.dependencies);
    assertCompleteIntegrityTree(piLock);
    assertCompleteIntegrityTree(browserRunLock);
    assertCompleteIntegrityTree(wranglerLock);
  });

  it('REQ-SEC-024 dependency constraint: edgepush is exact-pinned with committed integrity', () => {
    assert.equal(rootPackage.dependencies.edgepush, '0.1.1');
    assert.equal(rootLock.packages[''].dependencies.edgepush, '0.1.1');
    assert.equal(rootLock.packages['node_modules/edgepush'].version, '0.1.1');
    assert.match(rootLock.packages['node_modules/edgepush'].integrity, /^sha512-/);
  });

  it('pins patched versions across every affected committed runtime tree', () => {
    const floors = {
      'brace-expansion': '5.0.9',
      protobufjs: '7.6.5',
      undici: '8.9.0',
      ws: '8.21.0',
      '@hono/node-server': '2.0.5',
    };

    for (const [dependency, minimum] of Object.entries(floors)) {
      for (const lockfile of [npmToolsLock, piLock]) {
        const versions = versionsOf(lockfile, dependency);
        assert.ok(versions.length > 0, `${dependency} must be represented in the lock`);
        assert.ok(
          versions.every((version) => atLeast(version, minimum)),
          `${dependency} versions ${versions.join(', ')} must all be >= ${minimum}`,
        );
      }
    }

    for (const lockfile of [npmToolsLock, piLock, browserRunLock]) {
      const versions = versionsOf(lockfile, 'ip-address');
      assert.ok(versions.length > 0, 'ip-address must be represented in each affected runtime lock');
      assert.ok(
        versions.every((version) => atLeast(version, '10.3.1')),
        `ip-address versions ${versions.join(', ')} must all be >= 10.3.1`,
      );
    }

    for (const lockfile of [rootLock, wranglerLock]) {
      const versions = versionsOf(lockfile, 'undici');
      assert.ok(versions.length > 0, 'undici must be represented in each 7.x runtime lock');
      assert.ok(versions.every((version) => atLeast(version, '7.29.0')));
    }

    for (const lockfile of [rootLock, browserRunLock, npmToolsLock, piLock]) {
      const versions = versionsOf(lockfile, 'hono');
      assert.ok(versions.length > 0, 'hono must be represented in each affected runtime lock');
      assert.ok(versions.every((version) => atLeast(version, '4.12.34')));
    }

    const postcssVersions = versionsOf(sidebarLock, 'postcss');
    assert.ok(postcssVersions.length > 0);
    assert.ok(postcssVersions.every((version) => atLeast(version, '8.5.23')));

    const browserHonoVersions = versionsOf(browserRunLock, '@hono/node-server');
    assert.ok(browserHonoVersions.length > 0);
    assert.ok(browserHonoVersions.every((version) => atLeast(version, '2.0.5')));
  });
});
