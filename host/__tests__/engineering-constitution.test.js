// Verifies the engineering constitution has one canonical Claude owner and one
// Pi-native advanced-mode adaptation while Git Workflow remains in both modes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGeneratedSeed } from '../../scripts/materialize-agent-seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const claudeDir = resolve(repoRoot, 'preseed/agents/claude');
const piDir = resolve(repoRoot, 'preseed/agents/pi');
const piConstitution = readFileSync(resolve(piDir, 'rules/engineering-constitution.md'), 'utf8');
const piDesignRouting = readFileSync(resolve(piDir, 'rules/design-routing.md'), 'utf8');
const piGitWorkflow = readFileSync(resolve(piDir, 'rules/git-workflow.md'), 'utf8');
const localExecutionGate = readFileSync(resolve(claudeDir, 'rules/no-local-builds.md'), 'utf8');
const generatedSource = readFileSync(resolve(repoRoot, 'src/lib/agent-seed.generated.ts'), 'utf8');
const generatedDocuments = parseGeneratedSeed(generatedSource);

// REQ-AGENT-065: Engineering Constitution Preseeded to All Agents
describe('engineering constitution preseed', () => {
  it('seeds the Claude constitution rule, gated to advanced mode', () => {
    assert.ok(
      existsSync(resolve(claudeDir, 'rules/engineering-constitution.md')),
      'engineering-constitution.md must exist in preseed/agents/claude/rules/',
    );
    const manifest = JSON.parse(readFileSync(resolve(claudeDir, 'manifest.json'), 'utf8'));
    const entry = manifest['rules/engineering-constitution.md'];
    assert.ok(entry, 'manifest must list the constitution rule');
    assert.deepEqual(entry.modes, ['advanced'], 'constitution rule must be advanced-gated');
  });

  it('seeds one Pi-native constitution adaptation in advanced mode', () => {
    assert.ok(
      existsSync(resolve(piDir, 'rules/engineering-constitution.md')),
      'Pi engineering constitution adaptation must exist',
    );
    const manifest = JSON.parse(readFileSync(resolve(piDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest['rules/engineering-constitution.md']?.modes,
      ['advanced'],
      'Pi constitution must be present only in Pro and Enterprise mode',
    );
  });

  it('keeps advanced ambient policy bounded and permits owner-scoped parallel work', () => {
    const separatorChars = '\n\n---\n\n'.length;
    const advancedChars = piDesignRouting.trim().length + piConstitution.trim().length
      + piGitWorkflow.trim().length + (separatorChars * 2) + 1;
    assert.ok(advancedChars >= 3_000 && advancedChars <= 4_500, `advanced AGENTS policy is ${advancedChars} chars`);
    assert.match(piConstitution, /Multiple tasks may be `in_progress` only when distinct active owners are working them/);
    assert.match(piConstitution, /Each owner has at most one active task/);
    assert.doesNotMatch(piConstitution, /exactly one task `in_progress`/);
    assert.doesNotMatch(piGitWorkflow, /monitor-ci\.mjs request/,
      'the emitted boundary plan and lazy CI skill own command mechanics');
  });

  it('delivers Git Workflow in both modes and the constitution only in advanced mode', () => {
    const expectedByMode = {
      default: `${piGitWorkflow.trim()}\n\n---\n\n${localExecutionGate.trim()}`,
      advanced: `${piDesignRouting.trim()}\n\n---\n\n${piConstitution.trim()}\n\n---\n\n${piGitWorkflow.trim()}`,
    };
    for (const mode of ['default', 'advanced']) {
      const instructions = generatedDocuments.find(
        (document) => document.key === '.pi/agent/AGENTS.md' && document.modes.includes(mode),
      );
      assert.ok(instructions, `Pi ${mode} AGENTS.md must exist`);
      const policy = instructions.content.split('\n## Skills\n')[0]?.trimEnd();
      assert.equal(policy, expectedByMode[mode], `${mode} Pi policy composition drifted`);
    }
  });
});
