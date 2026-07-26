import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const generatedSource = readFileSync(join(repoRoot, 'src/lib/agent-seed.generated.ts'), 'utf8');
const assignment = 'export const AGENTS_SEEDED_CONFIGS: SeedDocument[] = ';
const jsonStart = generatedSource.indexOf(assignment) + assignment.length;
const jsonEnd = generatedSource.lastIndexOf('];') + 1;
assert.ok(jsonStart >= assignment.length && jsonEnd > jsonStart, 'generated seed document array not found');
const documents = JSON.parse(generatedSource.slice(jsonStart, jsonEnd));
const piManifest = JSON.parse(readFileSync(join(repoRoot, 'preseed/agents/pi/manifest.json'), 'utf8'));

function targetKey(relativePath) {
  if (relativePath === 'package.json' || relativePath === 'package-lock.json') {
    return `.pi/agent/npm/${relativePath}`;
  }
  if (relativePath === 'settings.json') return '.pi/agent/settings.json';
  return `.pi/agent/${relativePath}`;
}

function parseFrontmatter(content) {
  return Object.fromEntries(
    (content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
      .split('\n')
      .map((line) => line.split(/:\s*/, 2))
      .filter((parts) => parts.length === 2),
  );
}

const PI_RUNTIME_REPLACEMENTS = [
  ['mcp__graphify__god_nodes(top_n=50)', 'graphify_query("top 50 most-connected nodes / god nodes")'],
  ['mcp__graphify__god_nodes(top_n=20)', 'graphify_query("top 20 most-connected nodes / god nodes")'],
  ['mcp__graphify__god_nodes(top_k=20)', 'graphify_query("top 20 most-connected nodes / god nodes")'],
  ['mcp__graphify__get_neighbors(<concept-or-symbol>)', 'graphify_explain(<concept-or-symbol>)'],
  ['mcp__graphify__get_node(<symbol>)', 'graphify_explain(<symbol>)'],
  ['mcp__graphify__shortest_path', 'graphify_path'],
  ['mcp__graphify__query_graph', 'graphify_query'],
  ['mcp__graphify__get_neighbors', 'graphify_explain'],
  ['mcp__graphify__get_node', 'graphify_explain'],
  ['mcp__graphify__get_community', 'graphify_explain'],
  ['mcp__graphify__god_nodes', 'graphify_query'],
  ['mcp__graphify__graph_stats', 'graphify_query'],
  ['mcp__graphify__*', 'Pi graphify tools'],
  ['mcp__context-mode__ctx_batch_execute', 'ctx_batch_execute'],
  ['mcp__context-mode__ctx_execute_file', 'ctx_execute_file'],
  ['mcp__context-mode__ctx_execute', 'ctx_execute'],
  ['mcp__context-mode__ctx_search', 'ctx_search'],
  ['mcp__context-mode__ctx_fetch_and_index', 'ctx_fetch_and_index'],
  ['Claude Code: `EnterPlanMode`', 'Pi: use the `Plan` agent'],
  ['`EnterPlanMode`', 'the Pi `Plan` agent'],
  ['Task(subagent_type', 'subagent(subagent_type'],
  ['Task tool', 'subagent tool'],
  ['Agent tool', 'subagent tool'],
  ['Agent call', 'subagent call'],
  ['Claude Code', 'Pi'],
];

const PI_SDD_COMPATIBILITY_NOTE = `\n## Pi runtime compatibility\n\nThis transformed Pi skill uses Pi-native tool names and workflows:\n\n- Use only tools exposed by the current agent. Report-only reviewers use Bash; root sessions may use Bash/Read/Grep/Find/Edit/Write. Do not assume context-mode \`ctx_*\` tools exist.\n- Root sessions may use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` directly. Report-only reviewers inspect repository artifacts through Bash and do not invoke Graphify tools.\n- Root sessions use Pi's \`subagent\` tool for delegation and the \`Plan\` agent for Plan Mode. Report-only reviewers never launch subagents or mutate files.\n`;

const SDD_SKILLS = new Set([
  'doc-enforce', 'doc-enforce-lanes', 'doc-enforce-shape', 'doc-enforce-truth',
  'spec-enforce', 'spec-enforce-ac', 'spec-enforce-truth', 'tdd-enforce',
]);

function compactPiSkillDescription(content) {
  return content.replace(/^description:\s*(.+)$/m, (_match, rawDescription) => {
    let description = rawDescription.trim();
    if (description.startsWith('"') && description.endsWith('"')) {
      try { description = JSON.parse(description); } catch { /* Preserve the raw YAML scalar. */ }
    }
    if (description.length <= 80) return `description: ${JSON.stringify(description)}`;
    const prefix = description.slice(0, 77).replace(/\s+\S*$/, '').trimEnd();
    return `description: ${JSON.stringify(`${prefix}…`)}`;
  });
}

function expectedCanonicalSkill(skillName) {
  let content = readFileSync(
    join(repoRoot, 'preseed/agents/claude/skills', skillName, 'SKILL.md'),
    'utf8',
  ).replaceAll('~/.claude/', '~/.pi/agent/');
  for (const [from, to] of PI_RUNTIME_REPLACEMENTS) content = content.replaceAll(from, to);
  content = compactPiSkillDescription(content);
  content = content.replace(
    /^---\n([\s\S]*?)\n---\n/,
    (_match, frontmatter) => `---\n${frontmatter}\ndisable-model-invocation: true\n---\n`,
  );
  return SDD_SKILLS.has(skillName)
    ? `${content.trimEnd()}\n${PI_SDD_COMPATIBILITY_NOTE}`
    : content;
}

function expectedPiContent(relativePath) {
  const source = readFileSync(join(repoRoot, 'preseed/agents/pi', relativePath), 'utf8');
  return source.replace(/^<!-- @include-skill ([a-z0-9-]+) -->$/gm, (_directive, skillName) => {
    const skill = documents.find(
      (document) => document.key === `.pi/agent/skills/${skillName}/SKILL.md`,
    );
    assert.ok(skill, `seeded skill ${skillName} not found`);
    return `<embedded-skill name="${skillName}">\n${skill.content}</embedded-skill>`;
  });
}

describe('REQ-AGENT-006 AC1 and REQ-AGENT-007 AC4: Pi manifest ownership', () => {
  it('emits every manifest-declared Pi asset exactly once per mode with canonical bytes', () => {
    for (const [relativePath, entry] of Object.entries(piManifest)) {
      const key = targetKey(relativePath);
      for (const mode of entry.modes) {
        const matches = documents.filter((document) => document.key === key && document.modes.includes(mode));
        assert.equal(matches.length, 1, `${key} must have one ${mode}-mode owner`);
        assert.equal(
          matches[0].content,
          expectedPiContent(relativePath),
          `${key} ${mode} was transformed from another harness instead of seeded from canonical Pi source`,
        );
      }
    }
  });

  it('REQ-AGENT-085/REQ-AGENT-040: the canonical review programs reach Pi byte-identically', () => {
    // Both are one canonical source in the Claude tree; Pi receives them
    // through the ordinary transform rather than owning a second copy. Two
    // things make that worth pinning. Skill adaptation computes the Pi runtime
    // rewrites BEFORE it decides a file is not a SKILL.md, so an executable
    // aux file is in scope for those replacements -- a future comment
    // containing a rewritten runtime name would silently corrupt Pi's copy.
    // And byte-identity for these files is no longer covered by the
    // manifest-driven check above, because Pi's manifest deliberately does not
    // own them.
    for (const script of ['build-review-packet.mjs', 'inert-source-delta.mjs', 'lane-evidence.mjs']) {
      const canonical = readFileSync(
        join(repoRoot, 'preseed/agents/claude/skills/review-scope/scripts', script),
        'utf8',
      );
      const seeded = documents.find(
        (document) => document.key === `.pi/agent/skills/review-scope/scripts/${script}`,
      );
      assert.ok(seeded, `Pi must receive ${script} at the path it is invoked from`);
      assert.equal(
        seeded.content,
        canonical,
        `Pi runtime-name adaptation must never rewrite ${script}`,
      );
    }
  });

  it('REQ-AGENT-084: enforcement round limit honors only the exact fully autonomous marker', () => {
    const script = join(repoRoot, 'preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs');
    const decide = (count, marker) => {
      const result = spawnSync(process.execPath, [script, String(count), ...(marker ? [marker] : [])], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };

    assert.equal(decide(4), 'continue');
    assert.equal(decide(5), 'stop');
    assert.equal(decide(5, 'fully-autonomous'), 'continue');
    assert.equal(decide(5, 'FULLY AUTONOMOUS'), 'stop');
  });

  // The gate above is only reached if the manifest row sends a lane to it. That
  // row is executed inline, so it has to be self-sufficient: a lane that reads
  // it as an invitation to judge can return `continue` on a window the gate
  // would stop, and the anti-spiral limit silently stops existing.
  it('REQ-AGENT-084: the round-limit row routes the verdict to the gate in every runtime', () => {
    const rowOf = (text) => text
      .split('\n')
      .find((line) => line.startsWith('| Commit-prefix + 5-round limit |'));

    const canonical = rowOf(readFileSync(
      join(repoRoot, 'preseed/agents/claude/skills/spec-enforce/SKILL.md'),
      'utf8',
    ));
    assert.ok(canonical, 'the enforcement manifest must carry the round-limit row');
    assert.match(canonical, /round-limit\.mjs/,
      'the row must name the executable gate, not leave the verdict to judgment');
    assert.match(canonical, /gate=/,
      'the evidence template must carry the verdict, so a self-judged one is not reportable');

    // Pi enforces the same rule from the same source. Only the runtime root is
    // adapted, and it must be -- Pi cannot execute a `~/.claude` path.
    const piSpecReviewer = documents.find((document) => document.key === '.pi/agent/agents/spec-reviewer.md');
    assert.ok(piSpecReviewer, '.pi/agent/agents/spec-reviewer.md not found');
    const piRow = rowOf(piSpecReviewer.content);
    assert.equal(piRow, canonical.replace('~/.claude/skills/', '~/.pi/agent/skills/'),
      'apart from the runtime root Pi enforces the canonical row; a paraphrase is a parity gap');

    // A row naming a gate that does not ship is the same failure as no row.
    for (const [row, key] of [
      [canonical, '.claude/skills/spec-enforce/scripts/round-limit.mjs'],
      [piRow, '.pi/agent/skills/spec-enforce/scripts/round-limit.mjs'],
    ]) {
      assert.ok(row.includes(`~/${key}`), `the row must name the gate it ships: ${key}`);
      assert.ok(documents.some((document) => document.key === key), `${key} must be seeded`);
    }
  });

  it('REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt', () => {
    const requiredSkills = {
      'code-reviewer': ['review-scope', 'tdd-enforce'],
      'spec-reviewer': ['review-scope', 'spec-enforce', 'spec-enforce-ac', 'spec-enforce-truth'],
      'doc-updater': ['review-scope', 'doc-enforce', 'doc-enforce-lanes', 'doc-enforce-shape', 'doc-enforce-truth'],
    };

    for (const [reviewer, skillNames] of Object.entries(requiredSkills)) {
      const key = `.pi/agent/agents/${reviewer}.md`;
      const reviewerDocument = documents.find((document) => document.key === key);
      assert.ok(reviewerDocument, `${key} not found`);
      const embeddedNames = [...reviewerDocument.content.matchAll(/<embedded-skill name="([^"]+)">/g)]
        .map((match) => match[1]);
      assert.deepEqual(embeddedNames, skillNames);
      assert.equal(parseFrontmatter(reviewerDocument.content).skills, undefined);
      assert.equal(reviewerDocument.content, expectedPiContent(`agents/${reviewer}.md`));
      for (const skillName of skillNames.filter((name) => name !== 'review-scope')) {
        const embedded = reviewerDocument.content.match(
          new RegExp(`<embedded-skill name="${skillName}">\\n([\\s\\S]*?)</embedded-skill>`),
        )?.[1];
        assert.equal(embedded, expectedCanonicalSkill(skillName), `${reviewer} drifted from ${skillName}`);
      }
    }
  });
});
