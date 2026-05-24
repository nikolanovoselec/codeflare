// REQ-AGENT-005 / REQ-AGENT-023 sentinel: context-mode plugin.json must
// stay pinned at v1.0.151 or newer. v1.0.151 is the first release that
// carries the upstream issue #671 fix (synchronous better-sqlite3 calls
// blocking the Node event loop and burning a whole vCPU on long-lived
// FTS5 indexes). Bumping below this version reintroduces a runaway-CPU
// failure mode codeflare lived through on a multi-day session.
//
// Behavioural assertion: the Dockerfile reads `version` from this JSON
// and runs `npm install -g context-mode@$VER`. If the pin slips, the
// produced container ships the buggy version.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('context-mode plugin.json version pin', () => {
  it('is at least v1.0.151 (issue #671 fix surface)', () => {
    const pluginJson = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json'),
        'utf8'
      )
    );
    const m = pluginJson.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    assert.ok(m, `plugin.json version "${pluginJson.version}" is not semver-shaped`);
    const [major, minor, patch] = m.slice(1).map(Number);
    const flat = major * 1_000_000 + minor * 1_000 + patch;
    assert.ok(
      flat >= 1_000_151,
      `context-mode pinned version ${pluginJson.version} predates the issue #671 fix surface (need >= 1.0.151)`
    );
  });
});
