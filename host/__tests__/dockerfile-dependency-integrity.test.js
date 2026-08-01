import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
const npmToolsPackage = JSON.parse(readFileSync(join(repoRoot, 'preseed/npm-tools/package.json'), 'utf8'));
const npmToolsLock = JSON.parse(readFileSync(join(repoRoot, 'preseed/npm-tools/package-lock.json'), 'utf8'));
const piPackage = JSON.parse(readFileSync(join(repoRoot, 'preseed/agents/pi/package.json'), 'utf8'));
const piLock = JSON.parse(readFileSync(join(repoRoot, 'preseed/agents/pi/package-lock.json'), 'utf8'));
const browserRunLock = JSON.parse(
  readFileSync(join(repoRoot, 'preseed/agents/claude/browser-run-mcp/package-lock.json'), 'utf8'),
);
const wranglerPackage = JSON.parse(readFileSync(join(repoRoot, '.github/npm-tools/wrangler/package.json'), 'utf8'));
const wranglerLock = JSON.parse(readFileSync(join(repoRoot, '.github/npm-tools/wrangler/package-lock.json'), 'utf8'));
const containerWorkflow = readFileSync(join(repoRoot, '.github/workflows/container-image.yml'), 'utf8');
const stressWorkflow = readFileSync(join(repoRoot, '.github/workflows/stress-test.yml'), 'utf8');
const shadowPinWorkflow = readFileSync(join(repoRoot, '.github/workflows/bump-shadow-pins.yml'), 'utf8');

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

describe('REQ-OPS-019/020: build dependencies have committed integrity', () => {
  it('installs every privileged npm tool from one committed lockfile', () => {
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
      assert.ok(npmToolsPackage.dependencies[tool], `${tool} must be locked for the image`);
    }
    assert.deepEqual(npmToolsLock.packages[''].dependencies, npmToolsPackage.dependencies);
    assert.match(dockerfile, /COPY preseed\/npm-tools\/package\.json preseed\/npm-tools\/package-lock\.json \/opt\/codeflare\/npm-tools\//);
    assert.match(dockerfile, /npm ci --omit=dev --no-audit --no-fund/);
    assert.doesNotMatch(dockerfile, /npm install -g|npx -y/);

    for (const [path, metadata] of Object.entries(npmToolsLock.packages)) {
      if (!path || metadata.link) continue;
      assert.ok(metadata.integrity, `${path} must have committed registry integrity`);
    }
  });

  it('uses the committed Pi and Browser Run MCP locks at image build time', () => {
    assert.match(dockerfile, /COPY preseed\/agents\/pi\/package\.json preseed\/agents\/pi\/package-lock\.json \/opt\/codeflare\/pi-agent\/npm\//);
    assert.match(dockerfile, /cd \/opt\/codeflare\/pi-agent\/npm[\s\S]*?npm ci --omit=dev --no-audit --no-fund/);
    assert.doesNotMatch(dockerfile, /rm -f package-lock\.json[\s\S]*?npm install --omit=dev/);

    assert.match(dockerfile, /COPY preseed\/agents\/claude\/browser-run-mcp\/package\.json preseed\/agents\/claude\/browser-run-mcp\/package-lock\.json/);
    assert.match(dockerfile, /cd \/opt\/codeflare\/browser-run-mcp[\s\S]*?npm ci --omit=dev --no-audit --no-fund/);
    assert.ok(browserRunLock.packages['node_modules/@modelcontextprotocol/sdk'].integrity);
  });

  it('pins patched versions across both committed npm runtime trees', () => {
    assert.equal(
      piPackage.overrides['@earendil-works/pi-coding-agent'],
      npmToolsPackage.dependencies['@earendil-works/pi-coding-agent'],
      'Pi prewarm and runtime agent versions must move together',
    );

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
  });

  it('downloads uv as an immutable release artifact and verifies its SHA-256 before extraction', () => {
    assert.match(dockerfile, /^ARG UV_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(dockerfile, /^ARG UV_X86_64_LINUX_SHA256=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /uv-x86_64-unknown-linux-gnu\.tar\.gz/);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.doesNotMatch(dockerfile, /astral\.sh\/uv\/install\.sh\s*\|\s*sh/);
    assert.match(shadowPinWorkflow, /^  uv:$/m);
    assert.match(shadowPinWorkflow, /UV_X86_64_LINUX_SHA256/);
  });

  it('runs workflow Wrangler from its isolated committed lock', () => {
    assert.equal(wranglerLock.packages[''].dependencies.wrangler, wranglerPackage.dependencies.wrangler);
    for (const workflow of [containerWorkflow, stressWorkflow]) {
      assert.match(workflow, /npm ci --prefix \.github\/npm-tools\/wrangler --no-audit --no-fund/);
      assert.match(workflow, /\.github\/npm-tools\/wrangler\/node_modules\/\.bin\/wrangler/);
      assert.doesNotMatch(workflow, /npm install -g/);
    }
  });
});
