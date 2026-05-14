// Verifies REQ-AGENT-024 AC3: SKILL.md instructs the agent on the
// codeflare-specific git-persistence model and large-repo flag. Failing
// any of these means the agent will not be told to set up `.gitignore` /
// `.gitattributes` properly on first build, which breaks REQ-AGENT-026.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(__dirname, '../../preseed/agents/claude/skills/graphify/SKILL.md'),
  'utf8'
);

describe('graphify SKILL.md content (REQ-AGENT-024 AC3, REQ-AGENT-026)', () => {
  it('directs the agent to add graphify-out/.cache/ to .gitignore', () => {
    assert.ok(
      skill.includes('graphify-out/.cache/'),
      'SKILL must instruct adding graphify-out/.cache/ to .gitignore'
    );
  });

  it('directs the agent to add graphify-out/.chunks/ to .gitignore', () => {
    assert.ok(
      skill.includes('graphify-out/.chunks/'),
      'SKILL must instruct adding graphify-out/.chunks/ to .gitignore'
    );
  });

  it('directs the agent to add graph.json merge=graphify to .gitattributes', () => {
    assert.ok(
      /graphify-out\/graph\.json\s+merge=graphify/.test(skill),
      'SKILL must instruct adding the merge=graphify attribute to .gitattributes'
    );
  });

  it('explains the no-push-permission fallback (working tree only, ephemeral)', () => {
    assert.ok(
      /push permission/i.test(skill),
      'SKILL must discuss what happens for repos without push permission'
    );
    assert.ok(
      /ephemeral/i.test(skill) || /working tree only/i.test(skill),
      'SKILL must describe the ephemeral / working-tree-only fallback'
    );
  });

  it('documents the large-repo path (>2000 files): cluster-only --no-viz', () => {
    assert.ok(
      /cluster-only.*--no-viz/.test(skill) || /--no-viz.*cluster-only/.test(skill),
      'SKILL must document `graphify cluster-only . --no-viz` for large repos'
    );
    assert.ok(
      /2000|2,000/.test(skill),
      'SKILL must mention the >2000-file threshold for the large-repo path'
    );
  });

  it('documents the cheap AST-only refresh path (`graphify update .`)', () => {
    assert.ok(
      /graphify update/.test(skill),
      'SKILL must document `graphify update .` as the cheap incremental refresh'
    );
  });

  it('warns against `--backend openai` (no third-party API keys configured)', () => {
    // The session model handles extraction; routing to OpenAI would silently
    // fail or escape the in-session billing model.
    assert.ok(
      /backend openai|--backend\s+openai/i.test(skill),
      'SKILL must explicitly mention --backend openai (warning the agent off it)'
    );
  });
});
