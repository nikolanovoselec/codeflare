import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
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

describe('REQ-OPS-019/033: build dependencies have committed integrity', () => {
  it('REQ-AGENT-001 AC3: privileged npm tool manifest has a complete committed integrity tree', () => {
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

  it('pins patched versions across every affected committed runtime tree', () => {
    const floors = {
      'brace-expansion': '5.0.8',
      protobufjs: '7.6.5',
      undici: '8.5.0',
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

    const browserHonoVersions = versionsOf(browserRunLock, '@hono/node-server');
    assert.ok(browserHonoVersions.length > 0);
    assert.ok(browserHonoVersions.every((version) => atLeast(version, '2.0.5')));
  });
});
