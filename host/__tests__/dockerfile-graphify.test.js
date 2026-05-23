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

describe('Dockerfile graphify install (REQ-AGENT-023, REQ-AGENT-026) / REQ-OPS-011 (container base image: Debian bookworm-slim)', () => {
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

  it('REQ-AGENT-017 (bubblewrap installed in container image so Codex can sandbox its execution)', () => {
    assert.ok(
      /\bbubblewrap\b/.test(dockerfile),
      'Dockerfile must install bubblewrap (apt package providing /usr/bin/bwrap)'
    );
  });

  it('REQ-AGENT-001 AC3 (Node-based agent CLIs pre-installed globally via npm)', () => {
    // Three Node-based agents: Codex, Gemini, Copilot. Claude Code is a
    // native binary and OpenCode is Go-based; only the Node trio is
    // installed via npm at image build time.
    const installLine = dockerfile.match(/npm install -g[^\n]+/);
    assert.ok(installLine, 'Dockerfile must `npm install -g ...` at least one agent CLI');
    assert.ok(
      /@openai\/codex/.test(dockerfile) || /codex/.test(installLine[0]),
      'Dockerfile must install the Codex CLI'
    );
    assert.ok(
      /@google\/gemini-cli/.test(dockerfile) || /gemini/.test(installLine[0]),
      'Dockerfile must install the Gemini CLI'
    );
    assert.ok(
      /@github\/copilot/.test(dockerfile) || /copilot/.test(installLine[0]),
      'Dockerfile must install the Copilot CLI'
    );
  });

  it('REQ-AGENT-001 AC4 (Node CLIs warm V8 compile-cache via NODE_COMPILE_CACHE + --version invocations at build)', () => {
    assert.ok(
      /NODE_COMPILE_CACHE/.test(dockerfile),
      'Dockerfile must set NODE_COMPILE_CACHE env so the warm-up populates a cache'
    );
    // Invoke --version on at least one of the three Node CLIs to trigger
    // the warm-up; the matching agent binary names are codex/gemini/copilot.
    assert.ok(
      /(codex|gemini|copilot)\s+(?:[a-z]+\s+)?--version/.test(dockerfile),
      'Dockerfile must run at least one Node-based agent CLI with --version at build to trigger the V8 compile cache'
    );
  });

  it('REQ-AGENT-023: graphify CLI shim symlinked onto system PATH', () => {
    // uv tool install lands the shim at /root/.local/bin/graphify which is
    // not on the default container PATH; without this symlink every bash
    // subshell launched by a hook gates on `command -v graphify` returning
    // false and silently noops the global-graph add step (see entrypoint.sh
    // self-heal counterpart for the runtime safety net).
    assert.ok(
      dockerfile.includes(
        'ln -sf /root/.local/share/uv/tools/graphifyy/bin/graphify /usr/local/bin/graphify'
      ),
      'Dockerfile must symlink the graphify shim into /usr/local/bin so non-interactive bash subshells can resolve it'
    );
    // The symlink must land BEFORE `graphify --version` smoke-tests so the
    // smoke test exercises the canonical lookup path, not just the uv shim.
    // Match all occurrences (a future Dockerfile change that introduces a
    // second symlink for an alternative path must still keep the FIRST
    // one ahead of the smoke test).
    const allLinks = [...dockerfile.matchAll(/ln -sf \/root\/\.local\/share\/uv\/tools\/graphifyy\/bin\/graphify/g)];
    const allSmokes = [...dockerfile.matchAll(/graphify --version/g)];
    assert.ok(allLinks.length >= 1, 'at least one graphify shim symlink must exist');
    assert.ok(allSmokes.length >= 1, 'at least one `graphify --version` smoke test must exist');
    assert.ok(
      allLinks[0].index < allSmokes[0].index,
      'first ln -sf must precede the first graphify --version smoke test'
    );
  });
});
