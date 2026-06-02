// Verifies REQ-AGENT-023 AC3 + AC4, REQ-AGENT-024 AC1/AC7: graphify SessionStart + PostToolUse + PreToolUse
// hooks are merged into settings.json in advanced session mode when the
// plugin manifest is present, and absent otherwise (mode-gated discipline).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the entire advanced-mode SETTINGS_CONFIG assembly block, from
// `if [ "${SESSION_MODE:-default}" = "advanced" ]; then` through the
// validating `if ! printf '%s' "$SETTINGS_CONFIG" | jq empty` guard, so
// the harness exercises the real merge chain (codeflare-memory + ctx +
// graphify) rather than the graphify slice alone.
function extractAdvancedSettingsBlock() {
  // The SETTINGS_CONFIG assembly is the advanced-mode guard immediately
  // preceding the unique "Hardening: validate SETTINGS_CONFIG" marker. Anchor
  // on that marker and search backwards, so other advanced-mode guards added
  // earlier in entrypoint.sh (e.g. the vault rclone-filter gate) are not picked
  // up by mistake.
  const validateMarker = entrypoint.indexOf("Hardening: validate SETTINGS_CONFIG");
  if (validateMarker === -1) throw new Error('SETTINGS_CONFIG validate marker not found');
  const start = entrypoint.lastIndexOf('if [ "${SESSION_MODE:-default}" = "advanced" ]; then', validateMarker);
  if (start === -1) throw new Error('advanced-mode SETTINGS_CONFIG block start not found');
  const fiIdx = entrypoint.indexOf('\nfi\n', validateMarker);
  if (fiIdx === -1) throw new Error('advanced-mode block fi-terminator not found');
  return entrypoint.slice(start, fiIdx + 4);
}

function buildHarness(cwd, { sessionMode, graphifyManifest, ctxManifest }) {
  const userHome = join(cwd, 'user-home');
  const pluginDir = join(userHome, '.claude', 'plugins');
  mkdirSync(pluginDir, { recursive: true });

  const graphifyManifestPath = join(pluginDir, 'graphify', '.claude-plugin', 'plugin.json');
  if (graphifyManifest) {
    mkdirSync(dirname(graphifyManifestPath), { recursive: true });
    writeFileSync(graphifyManifestPath, JSON.stringify({ name: 'graphify', version: '0.7.19' }));
  }
  const ctxManifestPath = join(pluginDir, 'context-mode', '.claude-plugin', 'plugin.json');
  if (ctxManifest) {
    mkdirSync(dirname(ctxManifestPath), { recursive: true });
    writeFileSync(ctxManifestPath, JSON.stringify({ name: 'context-mode', version: '1.0.118' }));
  }

  const block = extractAdvancedSettingsBlock();

  const script = `
set -e
SESSION_MODE="${sessionMode}"
USER_HOME="${userHome}"
PLUGIN_DIR="${pluginDir}"
GRAPHIFY_MANIFEST="${graphifyManifestPath}"
CONTEXT_MODE_MANIFEST="${ctxManifestPath}"
CONTEXT_MODE_VERSION="1.0.118"
${block}
echo "SETTINGS_CONFIG_BEGIN"
printf '%s' "$SETTINGS_CONFIG"
echo
echo "SETTINGS_CONFIG_END"
`;

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness bash exited ${result.status}: ${result.stderr}`);
  }
  const match = result.stdout.match(/SETTINGS_CONFIG_BEGIN\n([\s\S]*?)\nSETTINGS_CONFIG_END/);
  if (!match) throw new Error(`SETTINGS_CONFIG envelope not found in stdout:\n${result.stdout}`);
  const settings = JSON.parse(match[1]);
  return { settings, pluginDir };
}

describe('entrypoint graphify hooks (advanced session mode)', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'gf-hooks-'));
  });

  it('manifest present + advanced mode: SessionStart hook is wired with matcher=startup', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-startup-'));
    const { settings, pluginDir } = buildHarness(cwd, {
      sessionMode: 'advanced', graphifyManifest: true, ctxManifest: false,
    });
    const sessionStart = settings.hooks.SessionStart;
    assert.ok(Array.isArray(sessionStart), 'SessionStart hooks array must exist');
    const gfHook = sessionStart.find(h =>
      h.matcher === 'startup' &&
      h.hooks.some(x => x.command.includes('graphify/scripts/graphify-session-start.sh'))
    );
    assert.ok(gfHook, 'SessionStart hook with matcher=startup pointing at graphify-session-start.sh must be present');
    assert.equal(
      gfHook.matcher,
      'startup',
      'matcher must be exactly "startup" - resume/compact reminders are noise'
    );
    assert.ok(
      gfHook.hooks[0].command.startsWith(`bash ${pluginDir}/graphify`),
      `hook command must invoke bash on the script under ${pluginDir}/graphify`
    );
  });

  it('manifest present + advanced mode: PostToolUse hook wired for Bash and MCP shell tools', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-clone-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'advanced', graphifyManifest: true, ctxManifest: false,
    });
    const ptu = settings.hooks.PostToolUse;
    assert.ok(Array.isArray(ptu), 'PostToolUse hooks array must exist');

    const bashGf = ptu.find(h =>
      h.matcher === 'Bash' &&
      h.hooks.some(x => x.command.includes('graphify-clone-prompt.sh'))
    );
    assert.ok(bashGf, 'PostToolUse hook for Bash pointing at graphify-clone-prompt.sh must be present');

    const mcpGf = ptu.find(h =>
      h.matcher === 'mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute' &&
      h.hooks.some(x => x.command.includes('graphify-clone-prompt.sh'))
    );
    assert.ok(mcpGf, 'PostToolUse hook for MCP shell tools must also point at graphify-clone-prompt.sh (issue #317 multi-shape coverage)');
  });

  it('manifest present + advanced mode: graphify hooks coexist with existing PostToolUse hooks', () => {
    // The existing PostToolUse list already carries the git-push review
    // reminder (and ctx-mode hooks if its manifest is present). Adding
    // graphify must EXTEND, not replace.
    const cwd = mkdtempSync(join(baseTmp, 'coexist-postool-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'advanced', graphifyManifest: true, ctxManifest: true,
    });
    const ptu = settings.hooks.PostToolUse;
    const hasReviewReminder = ptu.some(h =>
      h.hooks.some(x => x.command.includes('git-push-review-reminder.sh'))
    );
    const hasGraphify = ptu.some(h =>
      h.hooks.some(x => x.command.includes('graphify-clone-prompt.sh'))
    );
    const hasCtxMode = ptu.some(h =>
      h.hooks.some(x => x.command.includes('context-mode hook claude-code posttooluse'))
    );
    assert.ok(hasReviewReminder, 'pre-existing git-push-review-reminder hook must be preserved');
    assert.ok(hasGraphify, 'graphify-clone-prompt hook must be added');
    assert.ok(hasCtxMode, 'context-mode PostToolUse hook must be preserved when its manifest is present');
  });

  it('manifest absent + advanced mode: no graphify hooks wired (mode is right, manifest is the second gate)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'absent-advanced-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'advanced', graphifyManifest: false, ctxManifest: false,
    });
    const allHooks = JSON.stringify(settings.hooks || {});
    assert.ok(
      !allHooks.includes('graphify-session-start.sh'),
      'SessionStart graphify hook must not be wired without the plugin manifest'
    );
    assert.ok(
      !allHooks.includes('graphify-clone-prompt.sh'),
      'PostToolUse graphify hook must not be wired without the plugin manifest'
    );
    assert.ok(
      !allHooks.includes('graph-first-nudge.sh'),
      'PreToolUse graphify nudge hook must not be wired without the plugin manifest'
    );
  });

  it('manifest present + advanced mode: PreToolUse graph-first nudge wired for Grep|Glob and the ctx grep-equivalents (REQ-AGENT-024 AC7)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-nudge-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'advanced', graphifyManifest: true, ctxManifest: false,
    });
    const preToolUse = settings.hooks.PreToolUse;
    assert.ok(Array.isArray(preToolUse), 'PreToolUse hooks array must exist');

    // Non-custom-tier matcher path: Grep|Glob fire directly.
    const grepGlob = preToolUse.find(h =>
      h.matcher === 'Grep|Glob' &&
      h.hooks.some(x => x.command.includes('graph-first-nudge.sh'))
    );
    assert.ok(
      grepGlob,
      'PreToolUse hook for Grep|Glob pointing at graph-first-nudge.sh must be present (non-custom-tier matcher path)'
    );

    // Custom-tier matcher path: ctx_search + ctx_batch_execute are what
    // the agent uses when enforce-ctx-mode denies Grep/Glob.
    const ctxGrep = preToolUse.find(h =>
      h.matcher === 'mcp__context-mode__ctx_search|mcp__context-mode__ctx_batch_execute' &&
      h.hooks.some(x => x.command.includes('graph-first-nudge.sh'))
    );
    assert.ok(
      ctxGrep,
      'PreToolUse hook for ctx_search|ctx_batch_execute pointing at graph-first-nudge.sh must be present (custom-tier matcher path)'
    );
  });

  it('manifest present + default mode: PreToolUse graph-first nudge NOT wired (discipline is advanced-gated)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'default-nudge-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'default', graphifyManifest: true, ctxManifest: false,
    });
    const hooksJson = JSON.stringify(settings.hooks || {});
    assert.ok(
      !hooksJson.includes('graph-first-nudge.sh'),
      'default mode must not wire the graph-first nudge hook even when the plugin manifest is present'
    );
  });

  it('manifest present + default mode: production advanced block short-circuits and no graphify hooks land', () => {
    // Real gut-check: execute the actual production block from entrypoint.sh
    // with SESSION_MODE=default and confirm the advanced gate does not fire.
    // If somebody flipped the gate condition the wrong way, this test would
    // fail. (The earlier version of this test hand-wrote the expected
    // SETTINGS_CONFIG and never invoked the production code - tautology.)
    const cwd = mkdtempSync(join(baseTmp, 'default-mode-real-'));
    const { settings } = buildHarness(cwd, {
      sessionMode: 'default', graphifyManifest: true, ctxManifest: true,
    });
    const hooksJson = JSON.stringify(settings.hooks || {});
    assert.ok(
      !hooksJson.includes('graphify-session-start.sh'),
      'default mode must not wire the graphify SessionStart hook even when the plugin manifest is present'
    );
    assert.ok(
      !hooksJson.includes('graphify-clone-prompt.sh'),
      'default mode must not wire the graphify PostToolUse hook even when the plugin manifest is present'
    );
    // The default-mode branch sets just the skipDangerousModePermissionPrompt
    // flag; the assembled SETTINGS_CONFIG must reflect that.
    assert.equal(
      settings.skipDangerousModePermissionPrompt,
      true,
      'default-mode SETTINGS_CONFIG must still carry skipDangerousModePermissionPrompt'
    );
  });
});
