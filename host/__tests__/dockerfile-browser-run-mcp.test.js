// Verifies REQ-BROWSER-005 AC1/build: the Claude browser-run MCP server is built
// into the image (COPY + npm install + import smoke test) and pins its MCP SDK.
// Build-time facts the Dockerfile encodes; testing the rendered string is the
// only honest check without building an image (forbidden locally, 1 vCPU).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../preseed/agents/claude/browser-run-mcp/package.json'), 'utf8'),
);

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
