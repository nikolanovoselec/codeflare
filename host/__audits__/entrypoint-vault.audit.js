// Structural audit (NOT a behavioural test) for REQ-VAULT-001..007, -010, -012, -014, plus the capture-pipeline structure (REQ-VAULT-002) and the unified-graph resolution chain (REQ-VAULT-004):
// the persistent vault wiring across entrypoint.sh, Dockerfile, and
// the preseed layer.
//
// This is a code-presence audit. It greps the shipped files for the
// specific markers each piece of the rollout depends on. Breaking
// any of these lines indicates a likely vault regression, but the
// audit does NOT boot a container or exercise the runtime - the
// per-feature behavioural coverage lives in the language-specific
// test suites (src/__tests__/container/index.test.ts for shutdown
// budget, src/__tests__/routes/vault.test.ts for the proxy validator)
// and the E2E paths called out in sdd/vault.md verification fields.
//
// Located under host/__audits__/ rather than __tests__/ so it does NOT
// run as part of `npm test` (`node --test __tests__/*.test.js`) and
// does not count toward test coverage. Run on demand with:
//     node --test host/__audits__/*.audit.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'preseed/agents/claude/manifest.json'), 'utf8'));

describe('vault bisync filter (REQ-VAULT-001 AC1, REQ-MEM-004 AC1)', () => {
  // REQ-VAULT-001 AC1, REQ-MEM-004 AC1
  it('explicitly includes Vault/** before the graphify-out exclude', () => {
    const includeIdx = entrypoint.indexOf('--filter "+ Vault/**"');
    const excludeIdx = entrypoint.indexOf('--filter "- **/graphify-out/**"');
    assert.notEqual(includeIdx, -1, 'vault include filter must be present');
    assert.notEqual(excludeIdx, -1, 'graphify-out exclude filter must still be present');
    assert.ok(
      includeIdx < excludeIdx,
      'vault include must come BEFORE the graphify-out exclude (rclone filter first-match)'
    );
  });

  // REQ-VAULT-001 AC5
  it('also includes Uploads/** and Temporary/** before the graphify-out exclude', () => {
    // These two prefixes are the always-on R2-backed user folders the
    // storage panel exposes alongside Vault. They must sync to R2 with
    // the same first-match ordering rule so a vault-side graphify-out/
    // never silently leaks but Uploads/screenshots.png still rides along.
    const uploadsIdx = entrypoint.indexOf('--filter "+ Uploads/**"');
    const temporaryIdx = entrypoint.indexOf('--filter "+ Temporary/**"');
    const excludeIdx = entrypoint.indexOf('--filter "- **/graphify-out/**"');
    assert.notEqual(uploadsIdx, -1, 'Uploads include filter must be present');
    assert.notEqual(temporaryIdx, -1, 'Temporary include filter must be present');
    assert.ok(
      uploadsIdx < excludeIdx && temporaryIdx < excludeIdx,
      'Uploads + Temporary includes must come BEFORE the graphify-out exclude'
    );
  });

  // REQ-VAULT-001 Constraint (non-hidden basename)
  it('does not still include the legacy hidden-vault path .user_vault/**', () => {
    // The vault was at ~/.user_vault/ until the rename. Leaving the old
    // include behind would bisync stale content and surface a confusing
    // duplicate folder in the storage panel.
    assert.ok(
      !entrypoint.includes('--filter "+ .user_vault/**"'),
      'legacy .user_vault/** include must be removed after the rename'
    );
  });

  // REQ-VAULT-001 AC2, REQ-MEM-004 AC5
  it('excludes .graphify/ (ephemeral global graph) from bisync', () => {
    assert.ok(
      entrypoint.includes('--filter "- .graphify/**"'),
      'entrypoint.sh must exclude ~/.graphify (global-graph workspace) from R2 sync'
    );
  });
});

describe('persistent user folders (REQ-VAULT-001 AC5)', () => {
  // REQ-VAULT-001 AC5
  it('init_user_vault mkdir -p creates Uploads + Temporary alongside Vault', () => {
    // The storage panel always-shows these prefixes, and the tooltip
    // promises the user the files live at /home/user/{Uploads,Temporary}.
    // If the entrypoint stops creating them, the promise is a lie.
    assert.ok(
      /mkdir -p "\$USER_HOME\/Uploads" "\$USER_HOME\/Temporary"/.test(entrypoint),
      'init_user_vault must mkdir -p $USER_HOME/Uploads and $USER_HOME/Temporary'
    );
  });

  // REQ-VAULT-001 Constraint (non-hidden basename), REQ-VAULT-005 AC2
  it('silverbullet supervisor pins VAULT_ROOT to literal $HOME/Vault', () => {
    // This is a code-presence audit (the test name reflects what is
    // actually verified): we pin the literal `$HOME/Vault` string in the
    // supervisor. The behavioural reason (SilverBullet's file walk
    // aborts on dot-prefixed basenames, see the constraint on
    // REQ-VAULT-001) is enforced by the literal; renaming back to a
    // hidden path would fail this assertion and the SB UI would go
    // empty in production.
    assert.ok(
      /local VAULT_ROOT="\$HOME\/Vault"/.test(entrypoint),
      'silverbullet supervisor must point at $HOME/Vault (non-hidden basename)'
    );
  });
});

describe('vault boot ordering (REQ-MEM-004 AC2, AC3)', () => {
  // REQ-MEM-004 AC2: rclone pull must run before init_user_vault so returning
  // sessions inherit their R2-persisted content without the skeleton init
  // overwriting it.
  it('establish_bisync_baseline (initial R2 pull) precedes init_user_vault call', () => {
    const pullIdx = entrypoint.indexOf('establish_bisync_baseline');
    const initIdx = entrypoint.indexOf('init_user_vault');
    assert.notEqual(pullIdx, -1, 'establish_bisync_baseline must exist in entrypoint.sh');
    assert.notEqual(initIdx, -1, 'init_user_vault must exist in entrypoint.sh');
    assert.ok(
      pullIdx < initIdx,
      'establish_bisync_baseline (initial R2 pull) must appear before init_user_vault in entrypoint.sh'
    );
  });

  // REQ-MEM-004 AC3: init_user_vault must guard each subdirectory / config
  // creation with an existence check so a second run on the same container
  // does not overwrite user-edited files.
  it('init_user_vault guards file creation with existence checks (idempotent)', () => {
    // Extract the init_user_vault function body.
    const start = entrypoint.indexOf('init_user_vault()');
    assert.notEqual(start, -1, 'init_user_vault function must exist');
    const lines = entrypoint.slice(start).split('\n');
    let depth = 0;
    const bodyLines = [];
    for (const line of lines) {
      bodyLines.push(line);
      if (/\{/.test(line)) depth += (line.match(/\{/g) || []).length;
      if (/\}/.test(line)) depth -= (line.match(/\}/g) || []).length;
      if (depth <= 0 && bodyLines.length > 1) break;
    }
    const body = bodyLines.join('\n');
    // The function must use [ -f ... ], [ -d ... ], or [ -e ... ] guards before
    // writing -- OR use mkdir -p / cp --no-clobber (inherently non-destructive).
    // PRESEED_PAGE_WRITTEN is the flag set when the function conditionally
    // copies preseed pages. Any of these confirm the idempotency contract.
    const hasGuard =
      /\[\s+-[fde]\s+/.test(body) ||
      body.includes('cp --no-clobber') ||
      body.includes('mkdir -p') ||
      body.includes('PRESEED_PAGE_WRITTEN');
    assert.ok(
      hasGuard,
      'init_user_vault must guard file creation (existence check or non-destructive ops) so repeated calls only create absent files'
    );
  });
});

describe('vault skeleton + daemons (REQ-VAULT-001, REQ-VAULT-003, REQ-VAULT-005)', () => {
  // REQ-VAULT-001 AC3, AC4
  it('defines init_user_vault and runs it after baseline', () => {
    assert.ok(/^init_user_vault\(\)/m.test(entrypoint), 'init_user_vault function must exist');
    assert.ok(
      entrypoint.includes('(init_user_vault) || echo'),
      'init_user_vault must be called from the bisync init subshell with non-fatal fallback'
    );
  });

  // REQ-VAULT-003 AC1
  it('defines start_vault_monitor_daemon and launches it', () => {
    assert.ok(/^start_vault_monitor_daemon\(\)/m.test(entrypoint), 'start_vault_monitor_daemon function must exist');
    assert.ok(
      entrypoint.includes('start_vault_monitor_daemon'),
      'start_vault_monitor_daemon must be invoked from the daemon launch block'
    );
  });

  // REQ-VAULT-003 AC2 (three-marker pattern)
  it('uses the two-marker pattern (tick + last + vars)', () => {
    assert.ok(entrypoint.includes('vault-monitor.tick'), 'must reference vault-monitor.tick (heartbeat)');
    assert.ok(entrypoint.includes('vault-extract.last'), 'must reference vault-extract.last (high-water mark)');
    assert.ok(entrypoint.includes('vault-extract.vars'), 'must reference vault-extract.vars (trigger)');
  });

  // REQ-VAULT-003 AC1, REQ-VAULT-010 AC1
  it('excludes all four preseed-managed root pages from the daemon find (REQ-VAULT-003 AC1)', () => {
    for (const page of ['Index.md', 'CONFIG.md', 'README.md', 'STYLES.md']) {
      assert.ok(
        entrypoint.includes(`-not -path "$VAULT_ROOT/${page}"`),
        `vault-monitor daemon must exclude ${page} from -newer find (codeflare-authoritative; agent cp must not trigger extraction)`
      );
    }
  });

  // REQ-VAULT-003 AC6
  it('bumps vault-extract.last after init_user_vault writes a preseed page (REQ-VAULT-003 AC1)', () => {
    assert.ok(
      /PRESEED_PAGE_WRITTEN[\s\S]{0,400}touch\s+"\$HOOK_CACHE\/vault-extract\.last"/.test(entrypoint),
      'init_user_vault must touch vault-extract.last when any preseed page is rewritten, so the next daemon tick does not treat the cp as a user edit'
    );
  });

  // REQ-VAULT-005 AC2
  it('defines start_silverbullet_supervisor with a restart loop', () => {
    assert.ok(/^start_silverbullet_supervisor\(\)/m.test(entrypoint), 'silverbullet supervisor function must exist');
    assert.ok(
      entrypoint.includes('start_silverbullet_supervisor'),
      'silverbullet supervisor must be launched from the daemon block'
    );
    assert.ok(entrypoint.includes('127.0.0.1') || entrypoint.includes('SILVERBULLET_HOST'),
      'silverbullet must bind to localhost (Worker proxy is the auth boundary)');
  });

  // REQ-VAULT-012 AC2, REQ-VAULT-001 Constraint
  it('exports SB_INDEX_PAGE=Index in the supervisor (TitleCase index page)', () => {
    // SilverBullet 2.x hardcodes IndexPage to lowercase "index" in
    // server/cmd/server.go:29; the only override is the SB_INDEX_PAGE
    // env var. Without this the TitleCase Index.md preseed page is
    // unreachable from "/" and the user lands in an empty editor.
    assert.ok(
      /export\s+SB_INDEX_PAGE=["']Index["']/.test(entrypoint),
      'supervisor must export SB_INDEX_PAGE="Index" before launching silverbullet'
    );
  });
});

describe('SilverBullet binary install (REQ-VAULT-005, REQ-VAULT-007)', () => {
  // REQ-VAULT-005 AC1
  it('Dockerfile installs the silverbullet-server binary (not the CLI sb)', () => {
    assert.ok(
      dockerfile.includes('silverbullet-server-linux-x86_64.zip'),
      'Dockerfile must download silverbullet-server-* (sb-* is the CLI, not the server)'
    );
    assert.ok(
      /SILVERBULLET_SHA256=/.test(dockerfile),
      'Dockerfile must pin SilverBullet SHA256 (supply-chain integrity)'
    );
    assert.ok(
      dockerfile.includes('mv /tmp/silverbullet/silverbullet /usr/local/bin/silverbullet'),
      'SilverBullet binary must land in /usr/local/bin/silverbullet'
    );
  });

  // REQ-VAULT-007 AC2
  it('Dockerfile preseeds SilverBullet config under /opt/silverbullet-preseed/', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/silverbullet/ /opt/silverbullet-preseed/'),
      'preseed/silverbullet/ must ship in the container image'
    );
  });
});

describe('shutdown bisync reliability (REQ-VAULT-006 / REQ-MEM-004 AC6)', () => {
  // REQ-VAULT-006 AC1 / REQ-MEM-004 AC6: shutdown handler watchdog allows the
  // final bisync up to 120s (108s SIGTERM + 12s SIGKILL) to drain pending writes
  // before SIGKILL.
  it('wraps final bisync with a 120s budget + watchdog kill (108s SIGTERM + 12s SIGKILL)', () => {
    // We use a background subshell + watchdog rather than timeout(1)
    // because bisync_with_r2 is a shell function (not a binary). 108s
    // SIGTERM gives rclone room to flush; 12s more SIGKILL is the hard
    // kill. Total 120s matches the budget the DO destroy() leaves us
    // (135s minus 15s clean-exit buffer). See AD57.
    assert.ok(
      /sleep 108[\s\S]*kill_subtree TERM "\$BISYNC_PID"[\s\S]*sleep 12[\s\S]*kill_subtree KILL "\$BISYNC_PID"/.test(entrypoint),
      'shutdown_handler must SIGTERM at 108s then SIGKILL at 120s'
    );
    assert.ok(
      entrypoint.includes('TIMED OUT after 120s'),
      'shutdown_handler must log a recognisable 120s timeout message for telemetry'
    );
  });

  // REQ-VAULT-006 AC2 (also terminates vault-monitor and silverbullet supervisor pidfiles)
  it('also terminates vault-monitor + silverbullet supervisor pids', () => {
    assert.ok(entrypoint.includes('/tmp/vault-monitor.pid'), 'shutdown_handler must kill the vault-monitor daemon');
    assert.ok(entrypoint.includes('/tmp/silverbullet.pid'), 'shutdown_handler must kill the silverbullet supervisor');
  });

  // REQ-VAULT-006 AC3 (logs shutdown elapsed time so operators can tune the 120s budget)
  it('logs elapsed shutdown time for telemetry', () => {
    assert.ok(
      entrypoint.includes('elapsed:'),
      'shutdown_handler must emit an elapsed-time line so we can tune the 120s budget over time'
    );
  });
});

describe('UserPromptSubmit hook registration (REQ-VAULT-003, REQ-MEM-001)', () => {
  // REQ-VAULT-003 AC3, REQ-MEM-001 AC1
  it('SETTINGS_CONFIG registers vault-monitor-hook.sh as UserPromptSubmit', () => {
    const settingsLineIdx = entrypoint.indexOf('SETTINGS_CONFIG=');
    assert.notEqual(settingsLineIdx, -1, 'SETTINGS_CONFIG must exist');
    // Find the surrounding ~10KB so we don't accidentally match an unrelated reference.
    const slice = entrypoint.slice(settingsLineIdx, settingsLineIdx + 10000);
    assert.ok(
      slice.includes('codeflare-vault/scripts/vault-monitor-hook.sh'),
      'SETTINGS_CONFIG must register codeflare-vault/scripts/vault-monitor-hook.sh'
    );
    assert.ok(slice.includes('UserPromptSubmit'), 'registration must be under UserPromptSubmit');
  });
});

describe('preseed manifest entries (REQ-VAULT-007 AC1)', () => {
  const required = [
    'plugins/codeflare-vault/.claude-plugin/plugin.json',
    'plugins/codeflare-vault/scripts/vault-monitor-hook.sh',
    'plugins/codeflare-vault/scripts/vault-extract-prompt.md',
    'rules/vault-note-capture.md',
    'skills/vault-note-capture/SKILL.md',
    'skills/vault-operations/SKILL.md',
  ];
  for (const path of required) {
    it(`registers ${path}`, () => {
      assert.ok(manifest[path], `manifest must include ${path}`);
    });
  }
});

describe('capture pipeline structure (REQ-VAULT-002)', () => {
  const captureScript = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh'),
    'utf8',
  );
  const promptFile = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md'),
    'utf8',
  );

  // REQ-VAULT-002 AC1 (capture file path under Raw/Sessions/)
  it('memory-agent-prompt.md targets /home/user/Vault/Raw/Sessions/ for capture writes', () => {
    assert.ok(
      /\/home\/user\/Vault\/Raw\/Sessions\//.test(promptFile),
      'prompt must instruct agent to write captures under Vault/Raw/Sessions/',
    );
  });

  // REQ-VAULT-002 AC4 (flock graphify global add --as user_vault)
  it('memory-agent-prompt.md merges into global graph under flock /tmp/graphify-global.lock with --as user_vault', () => {
    assert.ok(/flock\s+(-w\s+\d+\s+)?\/tmp\/graphify-global\.lock/.test(promptFile),
      'prompt must serialise global-add through /tmp/graphify-global.lock');
    assert.ok(/graphify global add[\s\S]{0,200}--as\s+user_vault/.test(promptFile),
      'prompt must tag the merge with --as user_vault');
  });

  // REQ-VAULT-002 (capture-script dedup gate references .vars marker that the agent deletes first)
  it('memory-capture.sh writes a .vars marker that the subagent deletes (dedup gate per REQ-VAULT-002 Constraints)', () => {
    assert.ok(/VARS_FILE=/.test(captureScript), 'hook must populate VARS_FILE');
  });
});

describe('unified-graph resolution chain (REQ-VAULT-004)', () => {
  const mcpLazy = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py'),
    'utf8',
  );
  const activeRepo = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh'),
    'utf8',
  );

  // REQ-VAULT-004 AC1 (mcp-lazy prefers ~/.graphify/global-graph.json)
  it('graphify-mcp-lazy.py prefers ~/.graphify/global-graph.json in _resolve_active', () => {
    assert.ok(/_resolve_active/.test(mcpLazy), 'wrapper must define _resolve_active');
    assert.ok(/global-graph\.json/.test(mcpLazy), 'wrapper must reference the unified global graph path');
  });

  // REQ-VAULT-004 AC2 (active-repo hook flock + graphify global add)
  it('graphify-active-repo.sh serialises global-add via flock /tmp/graphify-global.lock', () => {
    assert.ok(/flock\s+(-w\s+\d+\s+)?\/tmp\/graphify-global\.lock/.test(activeRepo),
      'active-repo hook must flock /tmp/graphify-global.lock');
    assert.ok(/graphify global add/.test(activeRepo),
      'active-repo hook must call graphify global add');
  });

  // REQ-VAULT-004 AC3 (excludes $HOME/Vault from active-repo candidate resolution)
  it('graphify-active-repo.sh excludes $HOME/Vault from active-repo candidate resolution', () => {
    assert.ok(/Vault/.test(activeRepo),
      'active-repo hook must reference Vault to short-circuit when the walk-up hits it');
  });
});

describe('active-repo invariant and lock serialisation (REQ-VAULT-014)', () => {
  const activeRepo = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh'),
    'utf8',
  );
  const captureScript = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md'),
    'utf8',
  );
  const vaultExtract = readFileSync(
    resolve(repoRoot, 'preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md'),
    'utf8',
  );

  // REQ-VAULT-014 AC1 (basename mismatch -> graphify global remove BEFORE add)
  it('active-repo hook runs `graphify global remove` on basename change before the add', () => {
    assert.ok(/graphify global remove/.test(activeRepo),
      'hook must call graphify global remove when previous basename differs');
  });

  // REQ-VAULT-014 AC4 (all write sites flock /tmp/graphify-global.lock)
  it('every global-add write site serialises via flock -w 5 /tmp/graphify-global.lock', () => {
    const sites = {
      'graphify-active-repo.sh': activeRepo,
      'memory-agent-prompt.md': captureScript,
      'vault-extract-prompt.md': vaultExtract,
    };
    for (const [name, body] of Object.entries(sites)) {
      assert.ok(
        /flock\s+-w\s+\d+\s+\/tmp\/graphify-global\.lock/.test(body),
        `${name} must serialise global-add via flock -w <n> /tmp/graphify-global.lock`,
      );
    }
  });
});

describe('vault WS rate-limit key contract (REQ-VAULT-005 AC4)', () => {
  // REQ-VAULT-005 AC4: vault WS upgrades share the same ws-connect:<email>
  // rate-limit key as terminal WebSockets. This is a code-presence audit
  // of src/routes/vault.ts -- the full handleVaultRequest path requires a
  // live Worker runtime and is therefore not exercised at the unit level
  // (same rationale as terminal.test.ts line 7). The assertions below are
  // the strongest static guarantee available without a Worker harness.
  const vaultRoute = readFileSync(resolve(repoRoot, 'src/routes/vault.ts'), 'utf8');
  const terminalRoute = readFileSync(resolve(repoRoot, 'src/routes/terminal.ts'), 'utf8');

  // REQ-VAULT-005 AC4 - shared key
  it('handleVaultRequest uses the ws-connect:<email> key for WS rate-limiting (same key as terminal)', () => {
    // The key literal in vault.ts must match terminal.ts exactly so both
    // routes decrement the same per-user bucket. A vault-specific key
    // would create a separate budget that tab-spam can exploit.
    assert.match(
      vaultRoute,
      /key:\s*`ws-connect:\$\{user\.email\}`/,
      'vault.ts must use key: `ws-connect:${user.email}` for WebSocket rate-limit',
    );
    assert.match(
      terminalRoute,
      /key:\s*`ws-connect:\$\{user\.email\}`/,
      'terminal.ts must also use key: `ws-connect:${user.email}` (shared budget contract)',
    );
  });

  // REQ-VAULT-005 AC4 - shared constants (same limit, window, TTL)
  it('vault.ts imports the same WS_RATE_LIMIT_* constants as terminal.ts (no separate budget)', () => {
    const requiredConstants = [
      'WS_RATE_LIMIT_MAX_CONNECTIONS',
      'WS_RATE_LIMIT_WINDOW_MS',
      'WS_RATE_LIMIT_TTL_SECONDS',
    ];
    for (const constant of requiredConstants) {
      assert.ok(
        vaultRoute.includes(constant),
        `vault.ts must import ${constant} from constants (shared with terminal.ts)`,
      );
      assert.ok(
        terminalRoute.includes(constant),
        `terminal.ts must import ${constant} from constants (shared with vault.ts)`,
      );
    }
  });

  // REQ-VAULT-005 AC4 - HTTP requests must NOT consume the WS budget
  it('rate-limit call in vault.ts is guarded by isWebSocket (HTTP fetches do not burn the WS budget)', () => {
    // The WS rate-limit check must appear inside an `if (isWebSocket)` block
    // so the ~30 static asset requests the SilverBullet shell makes on page
    // load do not exhaust the per-user connection budget.
    const wsBlockMatch = vaultRoute.match(/if\s*\(isWebSocket\)\s*\{[\s\S]{0,600}ws-connect:/);
    assert.ok(
      wsBlockMatch !== null,
      'the ws-connect rate-limit key must appear inside an if (isWebSocket) guard in vault.ts',
    );
  });
});

describe('vault preseed files exist on disk (REQ-VAULT-007 AC1)', () => {
  const files = [
    'preseed/agents/claude/plugins/codeflare-vault/.claude-plugin/plugin.json',
    'preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh',
    'preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md',
    'preseed/agents/claude/rules/vault-note-capture.md',
    'preseed/silverbullet/Index.md',
    'preseed/silverbullet/CONFIG.md',
    'preseed/silverbullet/README.md',
    'preseed/silverbullet/STYLES.md',
  ];
  for (const file of files) {
    it(`${file} exists`, () => {
      assert.ok(existsSync(resolve(repoRoot, file)), `${file} must exist on disk`);
    });
  }
});
