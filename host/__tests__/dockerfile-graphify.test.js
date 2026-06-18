// Verifies REQ-AGENT-023 AC1 (graphifyy install with pinned version + extras)
// and REQ-AGENT-026 AC2 (global semantic merge-driver registration) by
// reading the Dockerfile content. These are build-time facts the Dockerfile
// itself encodes; testing the rendered string is the only honest check
// without actually building an image (forbidden locally, resource-constrained).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');
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

  it('REQ-AGENT-023 AC1: installs graphifyy with local-only [mcp,sql,pdf] extras at the pinned version', () => {
    assert.ok(
      dockerfile.includes('uv tool install "graphifyy[mcp,sql,pdf]==$VER"'),
      'Dockerfile must `uv tool install graphifyy[mcp,sql,pdf]==$VER` (extras + pinned version, no provider labeling extras)'
    );
    assert.ok(
      !dockerfile.includes('graphifyy[mcp,sql,pdf,gemini]'),
      'Dockerfile must not install the Gemini/provider Graphify extra; Pi labels communities with the active session agent'
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
    // Node-based agents: Codex, Copilot. Claude Code is a native binary;
    // OpenCode and Antigravity (agy) are Go binaries (curl/separate handling).
    // Only the Node pair is installed via npm at image build time.
    const installLine = dockerfile.match(/npm install -g[^\n]+/);
    assert.ok(installLine, 'Dockerfile must `npm install -g ...` at least one agent CLI');
    assert.ok(
      /@openai\/codex/.test(dockerfile) || /codex/.test(installLine[0]),
      'Dockerfile must install the Codex CLI'
    );
    assert.ok(
      /@github\/copilot/.test(dockerfile) || /copilot/.test(installLine[0]),
      'Dockerfile must install the Copilot CLI'
    );
    assert.ok(
      /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/.test(dockerfile),
      'Dockerfile must install Antigravity (agy) via curl'
    );
    assert.ok(
      !/@google\/gemini-cli/.test(dockerfile),
      'Dockerfile must NOT install the removed Gemini CLI'
    );
  });

  it('REQ-AGENT-001 AC4 (Node CLIs warm V8 compile-cache via NODE_COMPILE_CACHE + --version invocations at build)', () => {
    assert.ok(
      /NODE_COMPILE_CACHE/.test(dockerfile),
      'Dockerfile must set NODE_COMPILE_CACHE env so the warm-up populates a cache'
    );
    // Invoke --version on at least one of the Node CLIs to trigger
    // the warm-up; the matching agent binary names are codex/copilot.
    assert.ok(
      /(codex|copilot)\s+(?:[a-z]+\s+)?--version/.test(dockerfile),
      'Dockerfile must run at least one Node-based agent CLI with --version at build to trigger the V8 compile cache'
    );
  });

  it('REQ-AGENT-001 AC5 (Pi extension npm dependencies preinstalled in image cache)', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/agents/pi/package.json preseed/agents/pi/package-lock.json /opt/codeflare/pi-agent/npm/'),
      'Dockerfile must copy the Pi package manifest for the image-time install'
    );
    // The prewarm Pi SDK is bridged to the global @latest runtime agent: the frozen
    // lockfile is dropped and replaced by an npm override forcing
    // @earendil-works/pi-coding-agent to the exact version the global install resolved,
    // then a lockfile-free reinstall. Keeps the prewarm SDK identical to the runtime
    // agent (no transitive drift, no stale-CVE shipping).
    assert.ok(
      dockerfile.includes('/opt/codeflare/pi-agent/npm') && dockerfile.includes('npm install --omit=dev'),
      'Dockerfile must install Pi extension dependencies into the image-local cache'
    );
    assert.ok(
      dockerfile.includes('@earendil-works/pi-coding-agent') && dockerfile.includes('rm -f package-lock.json'),
      'Dockerfile must bridge the prewarm Pi SDK to the global agent version via an npm override (dropping the frozen lockfile)'
    );
    assert.ok(
      dockerfile.includes('[ -n "$PI_VER" ]') && dockerfile.includes('INSTALLED_PI_VER'),
      'the Pi SDK version bridge must fail closed: abort on an unreadable version and assert the override pinned the transitive copy'
    );
    assert.ok(
      entrypoint.includes('warm_pi_npm_dependencies') && entrypoint.includes('Pi extension npm dependencies symlinked'),
      'entrypoint must symlink the image-local Pi npm cache into ~/.pi/agent/npm after restore'
    );
  });

  it('REQ-AGENT-012 (Fast Start controls Pi update checks)', () => {
    const fastStartBlock = entrypoint.match(/# === Fast Start: control auto-update behavior ===[\s\S]*?\nfi\n/);
    assert.ok(fastStartBlock, 'entrypoint must define the Fast Start env-control block');
    const updateFunction = entrypoint.match(/update_pi_when_fast_start_disabled\(\) \{[\s\S]*?\n\}/);
    assert.ok(updateFunction, 'entrypoint must define update_pi_when_fast_start_disabled');

    const script = `${fastStartBlock[0]}\n${updateFunction[0]}\n\n` +
      `CALLS=${JSON.stringify(join(mkdtempSync(join(tmpdir(), 'pi-fast-start-')), 'calls.log'))}\n` +
      `pi() { printf 'pi:%s offline=%s skip=%s\\n' \"$*\" \"\${PI_OFFLINE:-}\" \"\${PI_SKIP_VERSION_CHECK:-}\" >> \"$CALLS\"; }\n` +
      `FAST_CLI_START=true\n${fastStartBlock[0]}\nupdate_pi_when_fast_start_disabled\n` +
      `printf 'on:%s:%s\\n' \"$PI_OFFLINE\" \"$PI_SKIP_VERSION_CHECK\"\n` +
      `FAST_CLI_START=false PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 DISABLE_INSTALLATION_CHECKS=1\n` +
      `${fastStartBlock[0]}\nupdate_pi_when_fast_start_disabled\n` +
      `printf 'off:%s:%s:%s:%s:%s\\n' \"\${PI_OFFLINE-unset}\" \"\${PI_SKIP_VERSION_CHECK-unset}\" \"\${DISABLE_AUTOUPDATER-unset}\" \"\${OPENCODE_DISABLE_AUTOUPDATE-unset}\" \"\${DISABLE_INSTALLATION_CHECKS-unset}\"\n` +
      `cat \"$CALLS\"\n`;

    const result = spawnSync('bash', ['-lc', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /on:1:1/, 'Fast Start ON exports Pi offline flags');
    assert.match(result.stdout, /off:unset:unset:unset:unset:unset/, 'Fast Start OFF unsets update suppressors');
    assert.match(result.stdout, /pi:update offline= skip=/, 'Fast Start OFF runs pi update without truthy Pi offline flags');
    assert.equal((result.stdout.match(/pi:update/g) || []).length, 1, 'pi update runs exactly once');
  });

  it('REQ-AGENT-012 (Fast Start OFF removes settings-file update suppressors)', () => {
    const toolConfigBlock = entrypoint.match(/# === Fast Start: tool-specific config files ===[\s\S]*?\nfi\n\n# Configure tab auto-start/);
    assert.ok(toolConfigBlock, 'entrypoint must define the Fast Start tool-specific config block');

    const fixture = mkdtempSync(join(tmpdir(), 'fast-start-config-'));
    mkdirSync(join(fixture, '.codex'), { recursive: true });
    writeFileSync(join(fixture, '.codex/version.json'), '{"dismissed_version":"999.0.0"}\n');

    const script = `USER_HOME=${JSON.stringify(fixture)}\nFAST_CLI_START=false\n${toolConfigBlock[0].replace('# Configure tab auto-start', '')}\n`;
    const result = spawnSync('bash', ['-lc', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fixture, '.codex/version.json')), false);
  });

  it('REQ-AGENT-001 AC5 (Pi npm warm-cache helper copies dependencies behaviorally)', () => {
    const start = entrypoint.indexOf('warm_pi_npm_dependencies() {');
    const end = entrypoint.indexOf('\n\nupdate_pi_when_fast_start_disabled()', start);
    assert.notEqual(start, -1, 'entrypoint must define warm_pi_npm_dependencies');
    assert.notEqual(end, -1, 'warm_pi_npm_dependencies must precede update_pi_when_fast_start_disabled');
    const warmFunction = entrypoint.slice(start, end);

    const fixture = mkdtempSync(join(tmpdir(), 'pi-npm-warm-'));
    const preseed = join(fixture, 'preseed');
    const target = join(fixture, 'home/.pi/agent/npm');
    mkdirSync(join(preseed, 'node_modules/@gotgenes/pi-subagents'), { recursive: true });
    mkdirSync(join(preseed, 'node_modules/@gaodes/pi-graphify'), { recursive: true });
    writeFileSync(join(preseed, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(preseed, 'node_modules/@gaodes/pi-graphify/package.json'), '{}\n');

    const script = `${warmFunction}\nexport USER_HOME=${JSON.stringify(join(fixture, 'home'))}\nexport PI_NPM_PRESEED=${JSON.stringify(preseed)}\nexport PI_NPM_DIR=${JSON.stringify(target)}\nwarm_pi_npm_dependencies\n`;
    const result = spawnSync('bash', ['-lc', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(target, 'package.json')), 'package.json copied');
    assert.ok(existsSync(join(target, 'node_modules/@gaodes/pi-graphify/package.json')), 'node_modules copied');

    writeFileSync(join(target, 'package.json'), '{"name":"user-custom"}\n');
    writeFileSync(join(preseed, 'package.json'), '{"name":"fixture","version":"2"}\n');
    const rerun = spawnSync('bash', ['-lc', script], { encoding: 'utf8' });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), '{"name":"user-custom"}\n');
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
