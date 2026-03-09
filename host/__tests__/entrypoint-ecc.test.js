import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../preseed/agents/claude/manifest.json'), 'utf8')
);

// Helper: extract the MAIN EXECUTION section
function extractMainExecution() {
  const marker = '# MAIN EXECUTION';
  const idx = entrypoint.indexOf(marker);
  if (idx === -1) return null;
  return entrypoint.slice(idx);
}

// ============================================================================
// Test: ECC plugin is NOT enabled — only context7 + superpowers
// ============================================================================
describe('ECC plugin removal', () => {
  it('does NOT enable everything-claude-code plugin', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      !main.includes('everything-claude-code@everything-claude-code'),
      'enabledPlugins must NOT reference ECC plugin'
    );
  });

  it('still enables context7 and superpowers plugins', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('context7@claude-plugins-official'),
      'enabledPlugins should reference context7 plugin'
    );
    assert.ok(
      main.includes('superpowers@claude-plugins-official'),
      'enabledPlugins should reference superpowers plugin'
    );
  });

  it('does NOT export ECC_DISABLED_HOOKS', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      !main.includes('ECC_DISABLED_HOOKS'),
      'should not export ECC_DISABLED_HOOKS (no ECC hooks to disable)'
    );
  });

  it('does NOT configure homunculus/instinct system', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      !main.includes('HOMUNCULUS_DIR'),
      'should not reference HOMUNCULUS_DIR (instinct system removed)'
    );
    assert.ok(
      !main.includes('homunculus'),
      'should not reference homunculus at all'
    );
  });

  it('plugin enablement is gated to advanced mode (checks for rules/common)', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('rules/common'),
      'plugin enablement should check for presence of rules/common directory'
    );
  });
});

// ============================================================================
// Test: Cherry-picked agents are in manifest
// ============================================================================
describe('Cherry-picked agents in manifest', () => {
  const expectedAgents = [
    'architect', 'build-error-resolver', 'code-reviewer', 'doc-updater',
    'planner', 'refactor-cleaner', 'security-reviewer', 'tdd-guide'
  ];

  for (const agent of expectedAgents) {
    it(`manifest includes agents/${agent}.md`, () => {
      const key = `agents/${agent}.md`;
      assert.ok(manifest[key], `manifest should include ${key}`);
      assert.ok(
        manifest[key].modes.includes('advanced'),
        `${key} should be in advanced mode`
      );
    });
  }

  it('does NOT include excluded agents', () => {
    const excluded = [
      'chief-of-staff', 'database-reviewer', 'e2e-runner',
      'go-build-resolver', 'go-reviewer', 'harness-optimizer',
      'loop-operator', 'python-reviewer'
    ];
    for (const agent of excluded) {
      assert.ok(
        !manifest[`agents/${agent}.md`],
        `manifest should NOT include agents/${agent}.md`
      );
    }
  });
});

// ============================================================================
// Test: Cherry-picked commands are in manifest
// ============================================================================
describe('Cherry-picked commands in manifest', () => {
  const expectedCommands = [
    'build-fix', 'checkpoint', 'code-review', 'plan',
    'refactor-clean', 'tdd', 'test-coverage', 'verify'
  ];

  for (const cmd of expectedCommands) {
    it(`manifest includes commands/${cmd}.md`, () => {
      const key = `commands/${cmd}.md`;
      assert.ok(manifest[key], `manifest should include ${key}`);
      assert.ok(
        manifest[key].modes.includes('advanced'),
        `${key} should be in advanced mode`
      );
    });
  }

  it('does NOT include ECC-dependent commands', () => {
    const excluded = [
      'claw', 'evolve', 'instinct-status', 'instinct-export',
      'instinct-import', 'loop-start', 'loop-status', 'projects',
      'promote', 'sessions', 'quality-gate'
    ];
    for (const cmd of excluded) {
      assert.ok(
        !manifest[`commands/${cmd}.md`],
        `manifest should NOT include commands/${cmd}.md`
      );
    }
  });
});

// ============================================================================
// Test: Cherry-picked skills are in manifest
// ============================================================================
describe('Cherry-picked skills in manifest', () => {
  const expectedSkills = [
    'api-design', 'backend-patterns', 'coding-standards',
    'content-hash-cache-pattern', 'database-migrations', 'deployment-patterns',
    'frontend-patterns', 'iterative-retrieval',
    'search-first', 'security-review'
  ];

  for (const skill of expectedSkills) {
    it(`manifest includes skills/${skill}/SKILL.md`, () => {
      const key = `skills/${skill}/SKILL.md`;
      assert.ok(manifest[key], `manifest should include ${key}`);
      assert.ok(
        manifest[key].modes.includes('advanced'),
        `${key} should be in advanced mode`
      );
    });
  }

  it('security-review includes cloud-infrastructure-security.md reference', () => {
    const key = 'skills/security-review/cloud-infrastructure-security.md';
    assert.ok(manifest[key], `manifest should include ${key}`);
  });

  it('does NOT include ECC-only skills', () => {
    const excluded = [
      'continuous-learning-v2', 'continuous-learning', 'autonomous-loops',
      'configure-ecc', 'nanoclaw-repl', 'skill-stocktake'
    ];
    for (const skill of excluded) {
      assert.ok(
        !manifest[`skills/${skill}/SKILL.md`],
        `manifest should NOT include skills/${skill}/SKILL.md`
      );
    }
  });
});

// ============================================================================
// Test: No ECC plugin cache files in manifest
// ============================================================================
describe('ECC plugin cache removed from manifest', () => {
  it('manifest has no everything-claude-code plugin references', () => {
    const eccKeys = Object.keys(manifest).filter(k =>
      k.includes('everything-claude-code')
    );
    assert.equal(
      eccKeys.length, 0,
      `manifest should have no ECC plugin entries, found: ${eccKeys.join(', ')}`
    );
  });

  it('manifest still has claude-plugins-official (context7 + superpowers)', () => {
    const officialKeys = Object.keys(manifest).filter(k =>
      k.includes('claude-plugins-official')
    );
    assert.ok(
      officialKeys.length > 0,
      'manifest should still have claude-plugins-official plugin entries'
    );
  });
});

// ============================================================================
// Test: Existing preseed components unchanged
// ============================================================================
describe('Existing preseed components preserved', () => {
  it('hooks are still in manifest', () => {
    assert.ok(manifest['hooks/memory-capture.sh'], 'memory-capture.sh should be in manifest');
    assert.ok(manifest['hooks/memory-agent-prompt.md'], 'memory-agent-prompt.md should be in manifest');
    assert.ok(manifest['hooks/block-attributed-commits.sh'], 'block-attributed-commits.sh should be in manifest');
  });

  it('codeflare-specific skills preserved', () => {
    assert.ok(manifest['skills/cloudflare-stack/SKILL.md'], 'cloudflare-stack skill should be in manifest');
    assert.ok(manifest['skills/ship/SKILL.md'], 'ship skill should be in manifest');
    assert.ok(manifest['skills/consult-llm/SKILL.md'], 'consult-llm skill should be in manifest');
  });

  it('rules preserved', () => {
    assert.ok(manifest['rules/ci-monitoring.md'], 'ci-monitoring rule should be in manifest');
    assert.ok(manifest['rules/cloudflare-environment.md'], 'cloudflare-environment rule should be in manifest');
    assert.ok(manifest['rules/common/coding-style.md'], 'common/coding-style rule should be in manifest');
  });
});
