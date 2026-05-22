// Verifies REQ-AGENT-024 AC1-AC3: in advanced session mode the discipline
// pieces are preseeded (graph-first rule + SKILL.md + SessionStart hook
// script). Also asserts the manifest gates the rule/skill to advanced mode
// only, not default. The HOOK-level wiring (which advanced settings.json
// adds the bash command) is covered by entrypoint-graphify-hooks.test.js.
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
  it('AC2: rules/graph-first.md exists and is preseeded', () => {
    const path = resolve(repoRoot, 'preseed/agents/claude/rules/graph-first.md');
    assert.ok(existsSync(path), 'graph-first.md must exist in preseed/agents/claude/rules/');
  });

  it('AC2: graph-first.md is authoritative and short (target ~100 tokens, hard ceiling ~250 words)', () => {
    const body = readPreseed('rules/graph-first.md');
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    assert.ok(
      wordCount < 250,
      `graph-first.md must stay tight; got ${wordCount} words (target ~100 tokens, ceiling 250 words)`
    );
  });

  it('AC2: graph-first.md uses MUST / MUST NOT decision-tree structure', () => {
    const body = readPreseed('rules/graph-first.md');
    assert.ok(/^MUST\s+(?:use|NOT\s+use)/m.test(body), 'must contain MUST bullets');
    assert.ok(/MUST NOT use the graph/.test(body), 'must contain a MUST NOT block');
  });

  it('AC2: graph-first.md references the SKILL for mechanics rather than restating them', () => {
    const body = readPreseed('rules/graph-first.md');
    assert.ok(
      /skills\/graphify\/SKILL\.md/.test(body),
      'graph-first.md must point at the SKILL for mechanics'
    );
  });

  it('AC3: skills/graphify/SKILL.md exists and is preseeded', () => {
    const path = resolve(repoRoot, 'preseed/agents/claude/skills/graphify/SKILL.md');
    assert.ok(existsSync(path), 'SKILL.md must exist in preseed/agents/claude/skills/graphify/');
    const size = statSync(path).size;
    assert.ok(size > 1000, `SKILL.md must carry real content; got ${size} bytes`);
  });

  it('AC1: SessionStart hook script exists and is executable', () => {
    const path = resolve(
      repoRoot,
      'preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh'
    );
    assert.ok(existsSync(path), 'graphify-session-start.sh must exist');
    const mode = statSync(path).mode & 0o111;
    assert.ok(mode !== 0, 'graphify-session-start.sh must have execute bits set');
  });

  it('AC4: graph-first-nudge.sh exists and is executable', () => {
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
      modesFor('rules/graph-first.md'),
      ['advanced'],
      'graph-first.md must be advanced-only'
    );
    assert.deepEqual(
      modesFor('skills/graphify/SKILL.md'),
      ['advanced'],
      'SKILL.md must be advanced-only'
    );
    assert.deepEqual(
      modesFor('plugins/graphify/scripts/graphify-session-start.sh'),
      ['advanced'],
      'SessionStart hook script must be advanced-only'
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
