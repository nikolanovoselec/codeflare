// Verifies manifest delivery for REQ-AGENT-024 AC2 and REQ-AGENT-091.
// Runtime graph-first behavior is exercised by graph-first-nudge.test.js; this
// file owns only the executable/file and manifest delivery boundary.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

function readPreseed(rel) {
  return readFileSync(resolve(repoRoot, 'preseed/agents/claude', rel), 'utf8');
}

describe('graphify preseed - advanced-mode discipline (REQ-AGENT-024)', () => {
  it('AC2: skills/graphify/SKILL.md exists and is preseeded', () => {
    const path = resolve(repoRoot, 'preseed/agents/claude/skills/graphify/SKILL.md');
    assert.ok(existsSync(path), 'SKILL.md must exist in preseed/agents/claude/skills/graphify/');
  });

  it('retired graphify SessionStart hook is absent from source and manifest', () => {
    const path = resolve(
      repoRoot,
      'preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh'
    );
    assert.equal(existsSync(path), false, 'graphify-session-start.sh must stay retired');
    const manifest = JSON.parse(readPreseed('manifest.json'));
    assert.equal(
      manifest['plugins/graphify/scripts/graphify-session-start.sh'],
      undefined,
      'the retired hook must not be delivered by the preseed manifest'
    );
  });

  it('REQ-AGENT-091 AC1: graph-first-nudge.sh exists and is executable', () => {
    const path = resolve(
      repoRoot,
      'preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh'
    );
    assert.ok(existsSync(path), 'graph-first-nudge.sh must exist');
    const mode = statSync(path).mode & 0o111;
    assert.ok(mode !== 0, 'graph-first-nudge.sh must have execute bits set');
  });

  it('manifest gates rule + skill + discipline scripts to advanced mode only', () => {
    const manifestText = readPreseed('manifest.json');
    const manifest = JSON.parse(manifestText);
    function modesFor(rel) {
      const entry = manifest[rel];
      assert.ok(entry, `manifest must list ${rel}`);
      assert.ok(Array.isArray(entry.modes), `${rel} must declare modes`);
      return entry.modes;
    }
    assert.deepEqual(
      modesFor('rules/engineering-constitution.md'),
      ['advanced'],
      'the constitution carrying the graph-first discipline must be advanced-only'
    );
    assert.deepEqual(
      modesFor('skills/graphify/SKILL.md'),
      ['advanced'],
      'SKILL.md must be advanced-only'
    );
    assert.deepEqual(
      modesFor('plugins/graphify/scripts/graph-first-nudge.sh'),
      ['advanced'],
      'graph-first-nudge.sh must be advanced-only'
    );
  });

  it('plugin manifest (plugin.json + the MCP-registration sentinel) ships to BOTH modes', () => {
    const manifest = JSON.parse(readPreseed('manifest.json'));
    const entry = manifest['plugins/graphify/.claude-plugin/plugin.json'];
    assert.ok(entry, 'plugin.json must be in the manifest');
    assert.deepEqual(
      entry.modes.sort(),
      ['advanced', 'default'],
      'plugin.json (MCP-server gate) must ship to both default and advanced (REQ-AGENT-023 AC2)'
    );
  });
});
