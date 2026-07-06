// Verifies the Dockerfile contracts for both Browser Run MCP surfaces.
// Build-time facts the Dockerfile encodes are checked structurally because
// building the image locally is forbidden in this resource-constrained repo.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../preseed/agents/claude/browser-run-mcp/package.json'), 'utf8'),
);

const CHROME_DEVTOOLS_MCP_BIN = '/opt/codeflare/bin/chrome-devtools-mcp';

describe('Dockerfile Claude browser-run MCP server (REQ-BROWSER-005)', () => {
  it('copies the server source into the image', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/agents/claude/browser-run-mcp/ /opt/codeflare/browser-run-mcp/'),
      'Dockerfile must COPY the browser-run-mcp source dir into /opt/codeflare',
    );
  });

  it('installs prod dependencies for the server at build time', () => {
    const idx = dockerfile.indexOf('/opt/codeflare/browser-run-mcp');
    assert.notEqual(idx, -1);
    const region = dockerfile.slice(idx, idx + 600);
    assert.ok(
      region.includes('npm install --omit=dev'),
      'Dockerfile must `npm install --omit=dev` the server so the runtime needs no registry fetch',
    );
  });

  it('smoke-tests that the server module imports cleanly (no stdin block)', () => {
    assert.ok(
      dockerfile.includes("import('/opt/codeflare/browser-run-mcp/index.mjs')"),
      'Dockerfile must import the server at build to catch a broken SDK import',
    );
    assert.ok(
      dockerfile.includes('browser-run-mcp import failed'),
      'the smoke test must fail the build (FATAL) if the import throws',
    );
  });

  it('pins the MCP SDK to an exact version (shadow-pinned, reproducible)', () => {
    const v = pkg.dependencies['@modelcontextprotocol/sdk'];
    assert.ok(v, 'server package.json must depend on @modelcontextprotocol/sdk');
    assert.ok(
      /^\d+\.\d+\.\d+$/.test(v),
      `@modelcontextprotocol/sdk must be pinned exact (no ^ or ~) so the browser-run-mcp shadow-pin job can watch it; got ${JSON.stringify(v)}`,
    );
  });

  it('declares the bin and is an ES module', () => {
    assert.equal(pkg.type, 'module', 'server must be an ES module (index.mjs uses import)');
    assert.ok(pkg.bin && pkg.bin['codeflare-browser-run-mcp'] === 'index.mjs', 'declares the server bin');
  });
});

describe('Dockerfile chrome-devtools MCP bake (REQ-BROWSER-001 / REQ-BROWSER-006)', () => {
  it('bakes the pinned chrome-devtools-mcp npx cache into the image and exposes a stable bin', () => {
    assert.match(
      dockerfile,
      /ENV CHROME_DEVTOOLS_MCP_VERSION=\d+\.\d+\.\d+/,
      'Dockerfile must carry the single chrome-devtools-mcp version pin for shadow-pin bumps',
    );
    assert.ok(
      dockerfile.includes('CHROME_DEVTOOLS_MCP_NPX_CACHE=/opt/codeflare/chrome-devtools-mcp-npx-cache'),
      'Dockerfile must keep the npx cache under /opt/codeflare so it survives container creation',
    );
    assert.ok(
      dockerfile.includes(`CHROME_DEVTOOLS_MCP_BIN=${CHROME_DEVTOOLS_MCP_BIN}`),
      'Dockerfile must publish a stable chrome-devtools-mcp bin path for entrypoint.sh',
    );
    assert.ok(
      dockerfile.includes('npx -y "chrome-devtools-mcp@$CHROME_DEVTOOLS_MCP_VERSION" --help'),
      'Dockerfile must warm the exact pinned npm package through npx at build time',
    );
    assert.ok(
      dockerfile.includes('find "$CHROME_DEVTOOLS_MCP_NPX_CACHE/_npx"')
        && dockerfile.includes('node_modules/.bin/chrome-devtools-mcp')
        && dockerfile.includes('readlink -f "$MCP_BIN_LINK"')
        && dockerfile.includes('ln -sf "$MCP_BIN" "$CHROME_DEVTOOLS_MCP_BIN"'),
      'Dockerfile must resolve the baked npx-installed bin and link it to the stable path',
    );
    assert.ok(
      dockerfile.includes('"$CHROME_DEVTOOLS_MCP_BIN" --help'),
      'Dockerfile must smoke-test the stable chrome-devtools-mcp bin during image build',
    );
  });

  it('entrypoint registers the baked chrome-devtools-mcp bin and never shells out to npx for Browser Run', () => {
    const browserBlock = entrypoint.slice(
      entrypoint.indexOf('# Configure Browser Run (Cloudflare Browser Rendering)'),
      entrypoint.indexOf('# Configure Claude Code settings.json with hooks'),
    );
    assert.ok(browserBlock.includes(CHROME_DEVTOOLS_MCP_BIN), 'Browser Run MCP config must use the baked stable bin path');
    assert.ok(
      !browserBlock.includes('chrome-devtools-mcp@') && !browserBlock.includes('command:"npx"'),
      'Browser Run MCP config must not use runtime npx or an entrypoint-local version literal',
    );
  });
});
