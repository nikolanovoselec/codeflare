import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Helper: extract the MAIN EXECUTION section
function extractMainExecution() {
  const marker = '# MAIN EXECUTION';
  const idx = entrypoint.indexOf(marker);
  if (idx === -1) return null;
  return entrypoint.slice(idx);
}

// ============================================================================
// Test: settings.json configuration in entrypoint.sh
// ============================================================================
// REQ-AGENT-099: Agent Settings and Plugins Assembled at Container Start
// REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

// Both SETTINGS_CONFIG literals, parsed. Asserting against the parsed objects
// rather than substring-matching the whole script means a hook that moves to the
// wrong event, loses its matcher, or lands in the wrong session mode fails here —
// none of which a file-wide `includes()` can see.
function settingsConfigs() {
  const literals = [...entrypoint.matchAll(/^\s*SETTINGS_CONFIG='(\{.*\})'$/gm)].map((m) =>
    JSON.parse(m[1].replaceAll(`'"$PLUGIN_DIR"'`, '/plugins'))
  );
  assert.equal(literals.length, 2, 'expected exactly two SETTINGS_CONFIG literals (advanced + default)');
  const advanced = literals.find((c) => c.hooks);
  const standard = literals.find((c) => !c.hooks);
  assert.ok(advanced, 'one literal must carry hook registrations (advanced mode)');
  assert.ok(standard, 'one literal must be hook-free (default mode)');
  return { advanced, standard };
}

// A command path the merge classifies as managed (its regex anchors on the
// literal `plugins/` segment), so pruning applies to it.
const MANAGED = '/home/user/.claude/plugins/codeflare-hooks/scripts';

// The settings-merge block, lifted verbatim out of entrypoint.sh. Every `fi`
// inside it is indented, so the first column-0 `fi` closes it.
function settingsMergeBlock() {
  // Anchor on the SETTINGS_FILE assignment, which is unique: the `if [ -f
  // "$SETTINGS_FILE" ]` line itself also opens the later Read(/**) permission
  // seeder, so matching that alone would silently exercise the wrong block if
  // the two were ever reordered.
  const assignment = entrypoint.indexOf('SETTINGS_FILE="$USER_CLAUDE_DIR/settings.json"');
  assert.notEqual(assignment, -1, 'entrypoint.sh no longer assigns SETTINGS_FILE');
  const start = entrypoint.indexOf('if [ -f "$SETTINGS_FILE" ]; then', assignment);
  assert.notEqual(start, -1, 'entrypoint.sh no longer has a settings-merge block');
  const end = entrypoint.indexOf('\nfi\n', start);
  assert.notEqual(end, -1, 'the settings-merge block is unterminated');
  return entrypoint.slice(start, end + '\nfi\n'.length);
}

function sessionModeSettingsBlock() {
  const assignment = entrypoint.indexOf('SETTINGS_FILE="$USER_CLAUDE_DIR/settings.json"');
  const start = entrypoint.lastIndexOf(
    'if [ "${SESSION_MODE:-default}" = "advanced" ]; then',
    assignment,
  );
  assert.notEqual(start, -1, 'entrypoint.sh no longer selects Claude settings by session mode');
  return entrypoint.slice(start, assignment);
}

// Runs that block for real against a throwaway settings.json. `existing` seeds
// the file (omit it to exercise the no-file branch) and may be an object or a
// raw string; `config` is the managed SETTINGS_CONFIG. Executing the shell is
// the point: a merge that silently stops merging cannot pass these.
function runSettingsMerge({ existing, config }) {
  const file = join(mkdtempSync(join(tmpdir(), 'settings-merge-')), 'settings.json');
  if (existing !== undefined) {
    writeFileSync(file, typeof existing === 'string' ? existing : JSON.stringify(existing));
  }

  // bash + `set -euo pipefail` to match entrypoint.sh's own shebang and options.
  // Under plain `sh` a command that starts failing inside the block would let
  // the harness sail past it while production aborts the container start —
  // failing open on exactly the regression class this test exists to catch.
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${settingsMergeBlock()}`], {
    env: { ...process.env, SETTINGS_FILE: file, SETTINGS_CONFIG: JSON.stringify(config) },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `settings-merge block exited ${result.status}: ${result.stderr}`);

  const raw = readFileSync(file, 'utf8');
  let settings = null;
  try {
    settings = JSON.parse(raw);
  } catch {
    settings = null;
  }
  return { settings, raw, stdout: result.stdout };
}

function runSessionModeSettings(mode) {
  const userDirectory = mkdtempSync(join(tmpdir(), `settings-${mode}-`));
  const file = join(userDirectory, 'settings.json');
  writeFileSync(file, JSON.stringify({
    theme: 'dark',
    hooks: { Notification: [{ matcher: 'custom', hooks: [{ type: 'command', command: '/user/hook.sh' }] }] },
  }));

  const script = [
    'set -euo pipefail',
    sessionModeSettingsBlock(),
    'SETTINGS_FILE="$USER_CLAUDE_DIR/settings.json"',
    settingsMergeBlock(),
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    env: {
      ...process.env,
      SESSION_MODE: mode,
      USER_CLAUDE_DIR: userDirectory,
      PLUGIN_DIR: '/plugins',
      CONTEXT_MODE_MANIFEST: '/missing/context-mode.json',
      GRAPHIFY_MANIFEST: '/missing/graphify.json',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${mode} settings path exited ${result.status}: ${result.stderr}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Every hook entry registered for one event type, flattened across matchers.
function hookEntries(config, event) {
  return (config.hooks?.[event] ?? []).flatMap((entry) =>
    (entry.hooks ?? []).map((hook) => ({ matcher: entry.matcher ?? '', ...hook }))
  );
}

describe('settings.json configuration / REQ-AGENT-015 (/review command)', () => {
  it('configures settings.json with skipDangerousModePermissionPrompt', () => {
    const { advanced, standard } = settingsConfigs();

    assert.equal(advanced.skipDangerousModePermissionPrompt, true);
    assert.equal(standard.skipDangerousModePermissionPrompt, true);
  });

  it('advanced mode registers each managed hook on its own event type', () => {
    const { advanced } = settingsConfigs();

    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart']) {
      assert.ok(hookEntries(advanced, event).length > 0, `${event} should carry at least one hook`);
    }

    const commandFor = (event, script) =>
      hookEntries(advanced, event).find((h) => (h.command ?? '').includes(script));

    // Each script must be registered on the event that can actually act on it —
    // e.g. a commit blocker is useless after the tool has already run.
    assert.ok(commandFor('PreToolUse', 'block-attributed-commits.sh'), 'commit blocker belongs on PreToolUse');
    assert.ok(commandFor('PreToolUse', 'block-local-builds.sh'), 'local-build blocker belongs on PreToolUse');
    assert.ok(commandFor('PreToolUse', 'git-push-review-reminder.sh'), 'review reminder captures merge state on PreToolUse');
    assert.ok(commandFor('PostToolUse', 'git-push-review-reminder.sh'), 'review reminder belongs on PostToolUse');
    assert.ok(commandFor('PostToolUseFailure', 'git-push-review-reminder.sh'), 'review reminder cleans merge state on PostToolUseFailure');
    assert.ok(commandFor('SessionStart', 'git-push-review-reminder.sh'), 'review reminder belongs on SessionStart');
    assert.ok(commandFor('UserPromptSubmit', 'memory-capture.sh'), 'memory capture belongs on UserPromptSubmit');
    assert.equal(commandFor('PreToolUse', 'memory-capture-block.sh'), undefined,
      'the capture hard block is retired (AD124): registering it again reintroduces the deadlock with the review gate, which refuses the very spawn the block demands');
    assert.equal(commandFor('PreToolUse', 'enforce-review-spawn.sh'), undefined,
      'review-specific PreToolUse gate is retired; unrelated guards remain');
    const stopGate = commandFor('Stop', 'enforce-review-spawn.sh');
    assert.ok(stopGate, 'review-spawn enforcement belongs on Stop');
    // Without asyncRewake the gate's exit 2 is an ordinary blocking error
    // again, and the client answers a blocking error with an immediate "Stop
    // hook error occurred" notification -- the exact defect the stderr
    // delivery was written to end. The key is load-bearing, so it is pinned
    // here.
    assert.equal(stopGate.asyncRewake, true,
      'the Stop gate must be registered for rewake or its directives read as failures');
    // The CLI ignores an unknown key silently, so a dropped or misspelled
    // rewakeMessage restores the unframed directive with a green suite.
    assert.match(stopGate.rewakeMessage ?? '', /Review directive/,
      'the rewake prefix is what replaces the client "blocking error" wording');
  });

  it('hooks use if-gates to filter by command pattern', () => {
    const { advanced } = settingsConfigs();

    // PreToolUse block-attributed-commits keeps its `if:` gates because
    // commit/PR-create commands always lead with `git`/`gh`.
    const commitBlockers = hookEntries(advanced, 'PreToolUse').filter((h) =>
      (h.command ?? '').includes('block-attributed-commits.sh')
    );
    const gates = commitBlockers.map((h) => h.if).filter(Boolean);
    assert.ok(gates.includes('Bash(git *)'), 'block-attributed-commits should be if-gated on Bash(git *)');
    assert.ok(gates.includes('Bash(gh *)'), 'block-attributed-commits should also be if-gated on Bash(gh *)');

    // The push reminder must NOT carry a prefix `if:` gate — it would silently
    // skip chained pipelines (`git add . && git push`), see #243. The script's
    // in-process case statement is the canonical filter.
    const pushReminders = hookEntries(advanced, 'PostToolUse').filter((h) =>
      (h.command ?? '').includes('git-push-review-reminder.sh')
    );
    assert.ok(pushReminders.length > 0, 'push reminder should be registered');
    for (const hook of pushReminders) {
      assert.equal(
        hook.if,
        undefined,
        'git-push-review-reminder must NOT be if-gated — chained pushes would be silently bypassed (#243)'
      );
    }
  });

  // REQ-AGENT-099 AC5: every session mode disables agent view. Parsed from the
  // literal rather than string-matched, so the test still fails if the key is
  // present but false, or if only one of the two modes carries it.
  it('both SETTINGS_CONFIG literals disable agent view', () => {
    const { advanced, standard } = settingsConfigs();

    for (const [mode, config] of [['advanced', advanced], ['default', standard]]) {
      assert.equal(
        config.disableAgentView,
        true,
        `${mode} mode must set disableAgentView:true (agent view is unusable on mobile)`
      );
    }
  });

  it('REQ-TERM-026 AC1: Claude keeps its native notification path without competing Codeflare behavior', () => {
    for (const mode of ['advanced', 'default']) {
      const settings = runSessionModeSettings(mode);
      assert.equal(settings.preferredNotifChannel, 'ghostty');
      assert.deepEqual(settings.hooks.Notification, [
        { matcher: 'custom', hooks: [{ type: 'command', command: '/user/hook.sh' }] },
      ]);
      assert.equal(
        hookEntries(settings, 'Stop').filter((hook) => (hook.command ?? '').includes('notification')).length,
        0,
      );
      assert.equal(settings.theme, 'dark');
    }
  });

  // REQ-MEM-011 AC1: hooks (PreToolUse and UserPromptSubmit) are merged into
  // settings.json ONLY in advanced mode. Default mode gets only
  // skipDangerousModePermissionPrompt -- no hook registrations.
  it('SESSION_MODE gates hook registration', () => {
    const { advanced, standard } = settingsConfigs();

    // Exactly one of the two mode literals carries hooks, and the gate that
    // chooses between them reads SESSION_MODE.
    assert.ok(Object.keys(advanced.hooks).length > 0, 'advanced literal should register hooks');
    assert.equal(standard.hooks, undefined, 'default literal should register no hooks');
    assert.ok(entrypoint.includes('SESSION_MODE:-default'), 'mode selection should read SESSION_MODE');
  });

  // REQ-MEM-011 AC1: default mode must not inject the hooks block.
  // Verify that the hook registration JSON (PreToolUse + UserPromptSubmit) is
  // inside the advanced-mode branch only -- the SETTINGS_CONFIG variable
  // containing "hooks" must be defined inside the advanced conditional, NOT
  // at the top level that runs regardless of mode.
  it('default mode emits only non-hook settings, not hook registrations', () => {
    const { standard } = settingsConfigs();

    // Assert the whole key set, so a hook block (or any other key) added to the
    // default-mode literal fails here rather than shipping to Standard sessions.
    assert.deepEqual(
      Object.keys(standard).sort(),
      ['disableAgentView', 'preferredNotifChannel', 'skipDangerousModePermissionPrompt']
    );
  });

  it('merges managed settings into an existing file without discarding user keys', () => {
    const { settings } = runSettingsMerge({
      existing: {
        theme: 'dark',
        disableAgentView: false,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/user/my-own-hook.sh' }] }],
        },
      },
      config: {
        skipDangerousModePermissionPrompt: true,
        disableAgentView: true,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${MANAGED}/block.sh` }] }],
        },
      },
    });

    assert.equal(settings.theme, 'dark', 'a setting the managed config never mentions must survive the merge');
    assert.equal(settings.skipDangerousModePermissionPrompt, true, 'managed keys must be applied');
    // Managed keys are the right operand of jq's `*`, so they win a conflict.
    // This is deliberate: the mobile default cannot be sticky-overridden by a
    // stale settings.json synced in from an older session.
    assert.equal(settings.disableAgentView, true, 'the managed value must win over the existing one');

    const commands = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(commands.includes('/home/user/my-own-hook.sh'), 'a user-added hook must survive the rebuild');
    assert.ok(commands.includes(`${MANAGED}/block.sh`), 'the managed hook must be registered');
  });

  it('prunes managed hooks the current config no longer registers', () => {
    const { settings } = runSettingsMerge({
      existing: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: `${MANAGED}/removed-upstream.sh` },
                { type: 'command', command: '/home/user/my-own-hook.sh' },
              ],
            },
          ],
        },
      },
      config: { skipDangerousModePermissionPrompt: true },
    });

    const commands = (settings.hooks?.PreToolUse ?? []).flatMap((entry) =>
      entry.hooks.map((hook) => hook.command)
    );
    // Without pruning, a hook deleted from the image keeps firing forever in any
    // container whose settings.json was synced from before the deletion.
    assert.ok(
      !commands.some((command) => command.includes('removed-upstream.sh')),
      'a managed hook absent from the current config must not survive'
    );
    assert.ok(commands.includes('/home/user/my-own-hook.sh'), 'pruning must not take user hooks with it');
  });

  it('creates settings.json when it does not exist', () => {
    // Without the no-file branch a fresh container starts with no managed
    // settings at all — no hooks, no mobile agent-view default.
    const config = { skipDangerousModePermissionPrompt: true, disableAgentView: true };
    const { settings } = runSettingsMerge({ config });

    assert.deepEqual(settings, config, 'the no-file branch must write the managed config verbatim');
  });

  it('handles malformed settings.json gracefully (skip with warning)', () => {
    const malformed = '{ not json';
    const { raw, stdout } = runSettingsMerge({
      existing: malformed,
      config: { skipDangerousModePermissionPrompt: true },
    });

    assert.equal(raw, malformed, 'a failed merge must leave the existing file untouched, not truncate it');
    assert.match(stdout, /WARNING/, 'a failed merge must be reported, not swallowed');
  });

  it('settings merge runs before bisync baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const settingsIdx = main.indexOf('settings.json');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(settingsIdx > -1, 'settings config should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist');
    assert.ok(
      settingsIdx < bisyncBaselineIdx,
      'settings merge must run before bisync baseline'
    );
  });
});

// ============================================================================
// Test: plugin enablement
// ============================================================================
describe('plugin enablement', () => {
  it('enables codeflare-memory plugin in .claude.json', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('codeflare-memory'),
      'entrypoint should reference codeflare-memory plugin'
    );
    assert.ok(
      main.includes('enabledPlugins'),
      'entrypoint should configure enabledPlugins in .claude.json'
    );
  });

  it('enables codeflare-hooks plugin alongside codeflare-memory in every branch', () => {
    // Both literals matter: one for the context-mode-manifest-present branch and
    // one for its else. Checking only the first would let the second ship a
    // session with the managed plugins missing.
    const configs = [...entrypoint.matchAll(/PLUGINS_CONFIG='(\{.*?\})'/g)].map((m) =>
      JSON.parse(m[1])
    );
    assert.equal(configs.length, 2, 'expected both PLUGINS_CONFIG literals');

    for (const config of configs) {
      assert.equal(config.enabledPlugins['codeflare-memory'], true);
      assert.equal(config.enabledPlugins['codeflare-hooks'], true);
    }
  });

  it('plugin enablement uses jq merge into .claude.json', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('enabledPlugins') && main.includes('. * $'),
      'plugin enablement should use jq recursive merge'
    );
  });

  it('plugin enablement is NOT mode-gated (permanent)', () => {
    // Slice the whole plugin-enablement section and assert it never consults
    // SESSION_MODE — wrapping it in an advanced-only branch is the regression
    // this test exists to catch, and a mere reference check cannot see that.
    // Anchor at the section header, not the first literal: a mode gate would be
    // written ABOVE the literals, so a slice starting there cannot see it.
    const start = entrypoint.indexOf('# Enable plugins');
    const end = entrypoint.indexOf('plugins enabled in .claude.json', start);
    assert.ok(start > -1 && end > start, 'plugin enablement section should exist');

    const section = entrypoint.slice(start, end);
    assert.ok(
      !section.includes('SESSION_MODE'),
      'plugin enablement must not be gated on SESSION_MODE'
    );
  });
});

// ============================================================================
// Test: rclone exclusion for memory counter files
//
// Behavioral: spawn rclone with the actual filters extracted from entrypoint.sh
// against a real tmpdir, assert counter files are excluded from `ls` output.
// Skipped if rclone isn't on PATH (test env doesn't have it). NO text-matching:
// either rclone proves the filter excludes the file, or the test skips with a
// concrete reason.
// ============================================================================
// ============================================================================
// Test: memory-capture counter location (REQ-MEM-002 counter-directory constraint)
//
// The counter directory moved from $HOME/.memory/counter/ to
// /tmp/.memory-counter/ to leverage Cloudflare Containers' ephemeral-disk
// guarantee (every container start = fresh /tmp = canonical "fresh container"
// signal). The bisync filter and the boot-time mkdir are therefore obsolete
// and must be absent from entrypoint.sh; the hook script itself mkdir -p's the
// new /tmp path on first fire.
// ============================================================================
describe('memory-capture counter location (REQ-MEM-002 counter-directory constraint)', () => {
  it('entrypoint.sh does NOT carry the obsolete .memory/counter bisync filter', () => {
    const start = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    const end = entrypoint.indexOf('\n)\n', start);
    assert.ok(start > -1 && end > start, 'RCLONE_FILTERS_COMMON array not found');
    const block = entrypoint.slice(start, end);
    const filterRx = /--filter\s+["']-\s+([^"']+)["']/g;
    const patterns = [];
    let m;
    while ((m = filterRx.exec(block)) !== null) patterns.push(m[1]);
    assert.ok(
      !patterns.includes('.memory/counter/**'),
      'obsolete filter .memory/counter/** must be absent (counter now under /tmp)'
    );
  });

  it('entrypoint.sh does NOT carry the obsolete mkdir -p ~/.memory/counter', () => {
    assert.doesNotMatch(
      entrypoint,
      /mkdir\s+-p\s+["']?\$\{?USER_HOME\}?\/\.memory\/counter["']?/,
      'obsolete mkdir -p $USER_HOME/.memory/counter must be absent'
    );
  });

  it('memory-capture.sh resolves COUNTER_DIR to /tmp/.memory-counter by default', () => {
    const hookPath = resolve(
      __dirname,
      '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh',
    );
    const hook = readFileSync(hookPath, 'utf-8');
    assert.match(
      hook,
      /COUNTER_DIR=["']?\$\{MEMCAP_COUNTER_DIR:-\/tmp\/\.memory-counter\}["']?/,
      'memory-capture.sh must default COUNTER_DIR to /tmp/.memory-counter via MEMCAP_COUNTER_DIR override'
    );
    assert.match(
      hook,
      /mkdir\s+-p\s+["']?\$COUNTER_DIR["']?/,
      'memory-capture.sh must mkdir -p its own COUNTER_DIR on first fire'
    );
  });
});

// merge_memory_files and cleanup_old_memory_files were removed alongside the
// MCP server-memory subsystem; the vault is now the sole cross-session memory
// store. The hook gate moved to /tmp/.memory-counter (REQ-MEM-002 counter-directory
// constraint); see counter directory test above.

// ============================================================================
// REQ-STOR-011 AC1/AC2/AC3: workspaceSyncEnabled scope.
//
// Behavioural — extract the RCLONE_FILTERS resolution block out of
// entrypoint.sh, source it through a real bash interpreter with each
// SYNC_MODE setting, and verify the resulting filter array actually
// drives rclone toward/away from /workspace. If a future refactor
// renames RCLONE_FILTERS or removes a branch, the bash exec breaks,
// not a regex.
//
// AC1: SYNC_MODE=none -> the filter set rejects a workspace/foo.txt path.
// AC2: SYNC_MODE=full -> the filter set accepts a workspace/foo.txt path.
// AC3: SYNC_MODE=metadata -> the filter set accepts workspace/CLAUDE.md
//      and workspace/.claude/settings.json, but rejects workspace/foo.txt.
// ============================================================================
describe('workspaceSyncEnabled scope (REQ-STOR-011)', () => {
  // Build a bash harness that sources the real RCLONE_FILTERS resolution
  // out of entrypoint.sh, then drives `rclone --dry-run lsf` against a
  // tiny on-disk workspace fixture for each SYNC_MODE. The pass/fail
  // signal is what rclone actually copies, not whether a string matches.
  function runWithScope(scope) {
    const fixture = mkdtempSync(join(tmpdir(), 'stor011-fixture-'));
    mkdirSync(join(fixture, 'workspace/.claude'), { recursive: true });
    mkdirSync(join(fixture, 'workspace/.git'), { recursive: true });
    writeFileSync(join(fixture, 'workspace/CLAUDE.md'), '# project\n');
    writeFileSync(join(fixture, 'workspace/.claude/settings.json'), '{}\n');
    writeFileSync(join(fixture, 'workspace/foo.txt'), 'plain workspace file\n');
    writeFileSync(join(fixture, 'workspace/.git/HEAD'), 'ref: refs/heads/main\n');

    // Cut entrypoint.sh down to: COMMON array + SYNC_MODE branch logic.
    // We bracket on the COMMON array header and the closing fi of the
    // branch block so we faithfully exercise the same code path the
    // container does at boot. If the file shape changes, this slice
    // breaks loudly.
    const startIdx = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    assert.ok(startIdx !== -1, 'RCLONE_FILTERS_COMMON header missing');
    const fiIdx = entrypoint.indexOf('\nfi\n', startIdx);
    assert.ok(fiIdx !== -1, 'SYNC_MODE branch fi terminator missing');
    const slice = entrypoint.slice(startIdx, fiIdx + 3);

    const script = [
      'set -u',
      `SYNC_MODE="${scope}"`,
      slice,
      // After sourcing, RCLONE_FILTERS is populated. Test each candidate
      // path through `rclone --dry-run lsf` and print one line per path
      // showing whether it survived the filter set.
      'for path in "workspace/foo.txt" "workspace/CLAUDE.md" "workspace/.claude/settings.json" "workspace/.git/HEAD"; do',
      '  if rclone --dry-run "${RCLONE_FILTERS[@]}" lsf --files-only "$1" --include "$path" >/dev/null 2>&1; then',
      '    matched=$(rclone "${RCLONE_FILTERS[@]}" lsf --files-only "$1" 2>/dev/null | grep -F "$path" || true)',
      '    if [ -n "$matched" ]; then echo "INCLUDED $path"; else echo "EXCLUDED $path"; fi',
      '  else',
      '    echo "EXCLUDED $path"',
      '  fi',
      'done',
    ].join('\n');

    const res = spawnSync('bash', ['-c', script, '_', fixture], {
      encoding: 'utf-8',
    });
    if (res.status !== 0) {
      throw new Error(
        `bash harness failed (exit ${res.status}):\nstderr=${res.stderr}\nstdout=${res.stdout}`
      );
    }
    const lines = res.stdout.trim().split('\n');
    const verdict = {};
    for (const line of lines) {
      const [state, path] = line.split(' ');
      verdict[path] = state;
    }
    return verdict;
  }

  // rclone may or may not be on the test runner. Skip cleanly when it
  // is not installed so the suite is still meaningful on dev boxes.
  const rcloneCheck = spawnSync('bash', ['-lc', 'command -v rclone'], {
    encoding: 'utf-8',
  });
  const rcloneAvailable = rcloneCheck.status === 0 && rcloneCheck.stdout.trim() !== '';

  it('AC1: SYNC_MODE=none rejects workspace files at the rclone filter layer', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = runWithScope('none');
    assert.equal(v['workspace/foo.txt'], 'EXCLUDED', 'AC1: plain workspace file must be excluded');
    assert.equal(v['workspace/CLAUDE.md'], 'EXCLUDED', 'AC1: workspace/CLAUDE.md must be excluded under none scope');
    assert.equal(v['workspace/.claude/settings.json'], 'EXCLUDED', 'AC1: workspace/.claude/** must be excluded under none scope');
  });

  it('AC2: SYNC_MODE=full accepts workspace files at the rclone filter layer', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = runWithScope('full');
    assert.equal(v['workspace/foo.txt'], 'INCLUDED', 'AC2: plain workspace file must be included under full scope');
    assert.equal(v['workspace/CLAUDE.md'], 'INCLUDED', 'AC2: workspace/CLAUDE.md must be included under full scope');
    assert.equal(v['workspace/.claude/settings.json'], 'INCLUDED', 'AC2: workspace/.claude/** must be included under full scope');
  });

  it('AC3: SYNC_MODE=metadata accepts only CLAUDE.md + .claude/** and rejects other workspace files', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = runWithScope('metadata');
    assert.equal(v['workspace/CLAUDE.md'], 'INCLUDED', 'AC3: workspace/CLAUDE.md must be included under metadata scope');
    assert.equal(v['workspace/.claude/settings.json'], 'INCLUDED', 'AC3: workspace/.claude/** must be included under metadata scope');
    assert.equal(v['workspace/foo.txt'], 'EXCLUDED', 'AC3: plain workspace file must be excluded under metadata scope');
  });
});
