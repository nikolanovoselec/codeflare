// Verifies REQ-AGENT-023 AC1 (graphifyy install with pinned version + extras)
// and REQ-AGENT-026 AC2 (global semantic merge-driver registration) by
// reading the Dockerfile content. These are build-time facts the Dockerfile
// itself encodes; testing the rendered string is the only honest check
// without actually building an image (forbidden locally, 1 vCPU).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
const pluginJson = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json'),
    'utf8'
  )
);

describe('Dockerfile graphify install (REQ-AGENT-023, REQ-AGENT-026)', () => {
  it('REQ-AGENT-023 AC1: copies plugin.json into image and reads the version from it', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json /tmp/graphify-plugin.json'),
      'Dockerfile must COPY the plugin.json so the install layer can read the pinned version'
    );
    assert.ok(
      /VER=\$\(jq -r '\.version[^']*' \/tmp\/graphify-plugin\.json\)/.test(dockerfile),
      'Dockerfile must extract VER from /tmp/graphify-plugin.json with jq'
    );
  });

  it('REQ-AGENT-023 AC1: installs graphifyy with the [mcp,sql,pdf] extras at the pinned version', () => {
    assert.ok(
      dockerfile.includes('uv tool install "graphifyy[mcp,sql,pdf]==$VER"'),
      'Dockerfile must `uv tool install graphifyy[mcp,sql,pdf]==$VER` (extras + pinned version)'
    );
  });

  it('REQ-AGENT-023 AC1: plugin.json carries a non-empty .version (Dependabot anchor)', () => {
    assert.ok(
      typeof pluginJson.version === 'string' && /^\d+\.\d+\.\d+/.test(pluginJson.version),
      `plugin.json .version must be a semver-shaped string; got ${JSON.stringify(pluginJson.version)}`
    );
  });

  it('REQ-AGENT-023 AC1: smoke-tests the graphify CLI and MCP entrypoint in the same RUN layer', () => {
    assert.ok(
      dockerfile.includes('graphify --version'),
      'Dockerfile must smoke-test the CLI shim after install'
    );
    assert.ok(
      dockerfile.includes("import graphify.serve"),
      'Dockerfile must smoke-test that the MCP server module imports'
    );
  });

  it('REQ-AGENT-026 AC2: registers the semantic merge driver globally (tier-independent)', () => {
    assert.ok(
      dockerfile.includes('git config --global merge.graphify.driver "graphify merge-driver %O %A %B"'),
      'Dockerfile must register the graphify merge driver in /etc/gitconfig via `git config --global`'
    );
    assert.ok(
      dockerfile.includes('git config --global merge.graphify.name'),
      'Dockerfile must also register a merge.graphify.name for git diagnostics'
    );
  });

  it('REQ-AGENT-026 AC2: merge-driver registration is NOT wrapped in a SESSION_MODE conditional', () => {
    // The driver lands at image-build time, before SESSION_MODE is ever set.
    // Guard against a future refactor that accidentally gates this on the
    // session-mode variable that exists only at entrypoint.sh runtime.
    const idx = dockerfile.indexOf('git config --global merge.graphify.driver');
    assert.notEqual(idx, -1);
    const surrounding = dockerfile.slice(Math.max(0, idx - 400), idx);
    assert.ok(
      !/SESSION_MODE\s*[!=]=/.test(surrounding),
      'merge-driver registration must not be conditional on SESSION_MODE'
    );
  });
});
