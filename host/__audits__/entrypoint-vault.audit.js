// Structural audit (NOT a behavioural test) for REQ-VAULT-001..007:
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

describe('vault bisync filter (REQ-MEMORY-100)', () => {
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

  it('does not still include the legacy hidden-vault path .user_vault/**', () => {
    // The vault was at ~/.user_vault/ until the rename. Leaving the old
    // include behind would bisync stale content and surface a confusing
    // duplicate folder in the storage panel.
    assert.ok(
      !entrypoint.includes('--filter "+ .user_vault/**"'),
      'legacy .user_vault/** include must be removed after the rename'
    );
  });

  it('excludes .graphify/ (ephemeral global graph) from bisync', () => {
    assert.ok(
      entrypoint.includes('--filter "- .graphify/**"'),
      'entrypoint.sh must exclude ~/.graphify (global-graph workspace) from R2 sync'
    );
  });
});

describe('persistent user folders (REQ-VAULT-001 AC5)', () => {
  it('init_user_vault mkdir -p creates Uploads + Temporary alongside Vault', () => {
    // The storage panel always-shows these prefixes, and the tooltip
    // promises the user the files live at /home/user/{Uploads,Temporary}.
    // If the entrypoint stops creating them, the promise is a lie.
    assert.ok(
      /mkdir -p "\$USER_HOME\/Uploads" "\$USER_HOME\/Temporary"/.test(entrypoint),
      'init_user_vault must mkdir -p $USER_HOME/Uploads and $USER_HOME/Temporary'
    );
  });

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

describe('vault skeleton + daemons (REQ-MEMORY-101..103)', () => {
  it('defines init_user_vault and runs it after baseline', () => {
    assert.ok(/^init_user_vault\(\)/m.test(entrypoint), 'init_user_vault function must exist');
    assert.ok(
      entrypoint.includes('(init_user_vault) || echo'),
      'init_user_vault must be called from the bisync init subshell with non-fatal fallback'
    );
  });

  it('defines start_vault_monitor_daemon and launches it', () => {
    assert.ok(/^start_vault_monitor_daemon\(\)/m.test(entrypoint), 'start_vault_monitor_daemon function must exist');
    assert.ok(
      entrypoint.includes('start_vault_monitor_daemon'),
      'start_vault_monitor_daemon must be invoked from the daemon launch block'
    );
  });

  it('uses the two-marker pattern (tick + last + vars)', () => {
    assert.ok(entrypoint.includes('vault-monitor.tick'), 'must reference vault-monitor.tick (heartbeat)');
    assert.ok(entrypoint.includes('vault-extract.last'), 'must reference vault-extract.last (high-water mark)');
    assert.ok(entrypoint.includes('vault-extract.vars'), 'must reference vault-extract.vars (trigger)');
  });

  it('excludes all four preseed-managed root pages from the daemon find (REQ-VAULT-003 AC1)', () => {
    for (const page of ['index.md', 'CONFIG.md', 'README.md', 'STYLES.md']) {
      assert.ok(
        entrypoint.includes(`-not -path "$VAULT_ROOT/${page}"`),
        `vault-monitor daemon must exclude ${page} from -newer find (codeflare-authoritative; agent cp must not trigger extraction)`
      );
    }
  });

  it('bumps vault-extract.last after init_user_vault writes a preseed page (REQ-VAULT-003 AC1)', () => {
    assert.ok(
      /PRESEED_PAGE_WRITTEN[\s\S]{0,400}touch\s+"\$HOOK_CACHE\/vault-extract\.last"/.test(entrypoint),
      'init_user_vault must touch vault-extract.last when any preseed page is rewritten, so the next daemon tick does not treat the cp as a user edit'
    );
  });

  it('defines start_silverbullet_supervisor with a restart loop', () => {
    assert.ok(/^start_silverbullet_supervisor\(\)/m.test(entrypoint), 'silverbullet supervisor function must exist');
    assert.ok(
      entrypoint.includes('start_silverbullet_supervisor'),
      'silverbullet supervisor must be launched from the daemon block'
    );
    assert.ok(entrypoint.includes('127.0.0.1') || entrypoint.includes('SILVERBULLET_HOST'),
      'silverbullet must bind to localhost (Worker proxy is the auth boundary)');
  });
});

describe('SilverBullet binary install (REQ-MEMORY-103)', () => {
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

  it('Dockerfile preseeds SilverBullet config under /opt/silverbullet-preseed/', () => {
    assert.ok(
      dockerfile.includes('COPY preseed/silverbullet/ /opt/silverbullet-preseed/'),
      'preseed/silverbullet/ must ship in the container image'
    );
  });
});

describe('shutdown bisync reliability (bundled fix)', () => {
  it('wraps final bisync with a 60s budget + watchdog kill', () => {
    // We use a background subshell + watchdog rather than timeout(1)
    // because bisync_with_r2 is a shell function (not a binary).
    assert.ok(
      /sleep 60.*kill.*BISYNC_PID/s.test(entrypoint),
      'shutdown_handler must hard-kill bisync at 60s if it runs over budget'
    );
    assert.ok(
      entrypoint.includes('TIMED OUT after 60s'),
      'shutdown_handler must log a recognisable timeout message for telemetry'
    );
  });

  it('also terminates vault-monitor + silverbullet supervisor pids', () => {
    assert.ok(entrypoint.includes('/tmp/vault-monitor.pid'), 'shutdown_handler must kill the vault-monitor daemon');
    assert.ok(entrypoint.includes('/tmp/silverbullet.pid'), 'shutdown_handler must kill the silverbullet supervisor');
  });

  it('logs elapsed shutdown time for telemetry', () => {
    assert.ok(
      entrypoint.includes('elapsed:'),
      'shutdown_handler must emit an elapsed-time line so we can tune the 60s/75s budget over time'
    );
  });
});

describe('UserPromptSubmit hook registration (REQ-MEMORY-102)', () => {
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

describe('preseed manifest entries (REQ-MEMORY-100..103)', () => {
  const required = [
    'plugins/codeflare-vault/.claude-plugin/plugin.json',
    'plugins/codeflare-vault/scripts/vault-monitor-hook.sh',
    'plugins/codeflare-vault/scripts/vault-extract-prompt.md',
    'rules/vault.md',
  ];
  for (const path of required) {
    it(`registers ${path}`, () => {
      assert.ok(manifest[path], `manifest must include ${path}`);
    });
  }
});

describe('vault preseed files exist on disk', () => {
  const files = [
    'preseed/agents/claude/plugins/codeflare-vault/.claude-plugin/plugin.json',
    'preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh',
    'preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md',
    'preseed/agents/claude/rules/vault.md',
    'preseed/silverbullet/config.yaml',
    'preseed/silverbullet/index.md',
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
