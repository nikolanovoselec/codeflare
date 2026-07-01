import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// Regression guard for the Pi skill-load break shipped with the Cloudflare-skills
// bundle (REQ-AGENT-075): the `cloudflare` and `cloudflare-stack` SKILL.md
// descriptions carried an unquoted colon-space ("... entry point: for ...").
// Claude's skill loader tolerated it, but Pi's stricter YAML parser reads a plain
// (unquoted) scalar containing ": " as a nested mapping and rejects the skill at
// load ("Nested mappings are not allowed in compact mappings"), breaking every Pi
// session. Contract: any unquoted frontmatter scalar value must be YAML-safe — no
// colon-space, and no leading indicator that would change the scalar's type.

const SKILL_ROOTS = [
  fileURLToPath(new URL('../../preseed/agents/claude/skills/', import.meta.url)),
  fileURLToPath(new URL('../../preseed/agents/pi/skills/', import.meta.url)),
];

function skillFiles() {
  const out = [];
  for (const root of SKILL_ROOTS) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(root, e.name, 'SKILL.md');
      try {
        readFileSync(p);
        out.push(p);
      } catch {
        // no SKILL.md in this dir
      }
    }
  }
  return out;
}

function frontmatterLines(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1].split('\n') : null;
}

// A plain (unquoted, non-block) scalar is unsafe if it contains a colon-space
// (parsed as a nested mapping) or a space-hash (parsed as a trailing comment).
function plainScalarHazard(value) {
  if (/:(\s|$)/.test(value)) return 'unquoted colon-space (parsed as a nested mapping)';
  if (/\s#/.test(value)) return 'unquoted space-hash (parsed as a trailing comment)';
  return null;
}

test('every bundled skill has a frontmatter block', () => {
  const files = skillFiles();
  assert.ok(files.length > 0, 'expected to find bundled SKILL.md files');
  for (const f of files) {
    assert.ok(frontmatterLines(readFileSync(f, 'utf8')), `${f}: missing --- frontmatter ---`);
  }
});

test('every unquoted skill frontmatter scalar is YAML-safe (Pi strict parser)', () => {
  const failures = [];
  for (const f of skillFiles()) {
    const lines = frontmatterLines(readFileSync(f, 'utf8'));
    if (!lines) continue;
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][\w-]*):[ \t]+(\S.*)$/);
      if (!m) continue; // blank line, list item, or continuation — not a scalar key: value
      const [, key, value] = m;
      const first = value[0];
      // quoted, flow, or block scalars are already safe
      if (['"', "'", '[', '{', '>', '|', '&', '*'].includes(first)) continue;
      const hazard = plainScalarHazard(value);
      if (hazard) failures.push(`${f}: "${key}" — ${hazard}: ${value.slice(0, 70)}`);
    }
  }
  assert.deepEqual(failures, [], `YAML-unsafe skill frontmatter:\n${failures.join('\n')}`);
});
