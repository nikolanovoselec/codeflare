// REQ-AGENT-076 / REQ-AGENT-023 sentinel: context-mode plugin.json must stay
// pinned at v1.0.169 or newer — the effective floor of two upstream fixes.
// v1.0.151 is the first release carrying the issue #671 fix (synchronous
// better-sqlite3 calls blocking the Node event loop and burning a whole vCPU on
// long-lived FTS5 indexes). v1.0.169 additionally carries the issue #868
// foreground/subagent bridge idle-reaper split that codeflare relies on
// (REQ-AGENT-076 AC6) so subagent bridge helpers self-release instead of piling up.
// The Dockerfile reads `version` from this JSON and runs `npm install -g
// context-mode@$VER`; if the pin slips below either floor, the produced container
// ships a version that reintroduces a failure mode codeflare lived through.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function pinnedVersionFlat() {
  const pluginJson = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json'),
      'utf8'
    )
  );
  const m = pluginJson.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(m, `plugin.json version "${pluginJson.version}" is not semver-shaped`);
  const [major, minor, patch] = m.slice(1).map(Number);
  return { version: pluginJson.version, flat: major * 1_000_000 + minor * 1_000 + patch };
}

describe('context-mode plugin.json version pin', () => {
  it('is at least v1.0.151 (issue #671 fix surface)', () => {
    const { version, flat } = pinnedVersionFlat();
    assert.ok(
      flat >= 1_000_151,
      `context-mode pinned version ${version} predates the issue #671 fix surface (need >= 1.0.151)`
    );
  });

  it('is at least v1.0.169 (issue #868 foreground/subagent bridge idle-reaper split)', () => {
    const { version, flat } = pinnedVersionFlat();
    assert.ok(
      flat >= 1_000_169,
      `context-mode pinned version ${version} predates the issue #868 foreground/subagent bridge idle-reaper split (need >= 1.0.169); a downgrade below this silently stops subagent bridge helpers self-releasing`
    );
  });
});
