// Verifies the seed generator refuses to build when a Pi rule-transform key no
// longer resolves to a Claude rule.
//
// PI_COMPACTED_RULES, PI_COVERED_RULES and PI_RULE_SKILL_GROUPS all name Claude
// rules by exact path. A renamed or merged rule leaves a dead key, and the
// failure is silent AND inverted: the rule stops being excluded from Pi and
// flows into AGENTS.md, which is the opposite of what the collection exists to
// do. These tests drive the generator across a process boundary because the
// collections are module-private and the script runs its work on import.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// The generator resolves its inputs as siblings of scripts/, so a runnable
// copy needs preseed/ and scripts/ under one root. src/lib/ is created because
// the successful path writes the generated seed there.
function stageTree() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-rule-membership-'));
  cpSync(join(repoRoot, 'preseed'), join(dir, 'preseed'), { recursive: true });
  cpSync(join(repoRoot, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  return dir;
}

function generate(dir) {
  return spawnSync('node', ['scripts/generate-agent-seed.mjs'], {
    cwd: dir,
    encoding: 'utf8',
  });
}

describe('generate-agent-seed.mjs - Pi rule-transform membership', () => {
  it('every Pi rule-transform key resolves to a Claude rule in the shipped tree', () => {
    const dir = stageTree();
    try {
      const result = generate(dir);
      assert.equal(result.status, 0,
        `the shipped tree must generate cleanly; stderr: ${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails generation when a compacted rule no longer exists', () => {
    // no-local-builds.md is a PI_COMPACTED_RULES member. A rename or merge removes
    // both the file and its manifest entry while leaving the transform key
    // behind -- the manifest's own existence check never fires, so before this
    // guard the generator succeeded and silently shipped the rule into Pi's
    // AGENTS.md.
    const dir = stageTree();
    try {
      const manifestPath = join(dir, 'preseed/agents/claude/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      delete manifest['rules/no-local-builds.md'];
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(join(dir, 'preseed/agents/claude/rules/no-local-builds.md'));
      const result = generate(dir);
      assert.notEqual(result.status, 0,
        'a dead rule-transform key must fail the build, not pass silently');
      assert.match(result.stderr, /no-local-builds\.md/,
        'the failure must name the rule that went missing');
      assert.match(result.stderr, /PI_COMPACTED_RULES/,
        'the failure must name the collection holding the dead key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
