import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { cloneTargetPath, graphifyCloneAction, graphifyClonePromptDecision, graphifyPromptMarker, isFailedToolExecution as isFailedGraphifyToolExecution, renderGraphifyCloneDirective } from '../../../preseed/agents/pi/extensions/graphify-helpers';
import { buildSpawnOptions, captureFilename, captureTimestamp, compactMessages, isFirstMessage, isRealUserPrompt, isResumedSession, MEMORY_CAPTURE_PENDING_TTL_MS, MEMORY_EVERY_N_PROMPTS, parseSessionMessages, realUserPromptCount, sessionId, shouldCapture, withCurrentPrompt } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';
import { attributionBlockReason, isLocalBuildCommand, localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';
import { DEBUG_WORKFLOW, DEPLOY_WORKFLOW, BRAINSTORM_WORKFLOW, commandInstructions, deployTarget } from '../../../preseed/agents/pi/extensions/commands-helpers';
import { restoreActiveRepoFromPersistedFiles, shouldHandleClonePrompt } from '../../../preseed/agents/pi/extensions/codeflare-pi';
import { sddCommandDecision, type SddRepoState } from '../../../preseed/agents/pi/extensions/sdd-helpers';
import contextModeRuntime from '../../../preseed/agents/pi/extensions/context-mode-runtime';

/**
 * Validates invariants of the generated agent seed configs.
 *
 * The generator script (generate-agent-seed.mjs) reads manifest.json and the
 * preseed file tree at build time, validates bidirectional consistency, and
 * embeds the result into AGENTS_SEEDED_CONFIGS. These tests verify the
 * generated output's runtime invariants without filesystem access (which
 * isn't available in the Workers vitest pool).
 */

const VALID_KEY_PREFIXES = ['.claude/', '.codex/', '.gemini/', '.copilot/', '.config/opencode/', '.pi/agent/'];

function stripPrefix(key: string): string {
  for (const prefix of VALID_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return key;
}

function claudeDocs() {
  return AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key.startsWith('.claude/'));
}

function markdownHeadings(content: string): string[] {
  return [...content.matchAll(/^##+\s+(.+)$/gm)].map((match) => match[1]);
}

function markdownSection(content: string, heading: string): string {
  const match = [...content.matchAll(/^##+\s+(.+)$/gm)].find((candidate) => candidate[1] === heading);
  expect(match, `section ${heading}`).toBeTruthy();
  const start = match?.index ?? 0;
  const rest = content.slice(start);
  const next = rest.slice(1).search(/\n##+\s+/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function frontmatter(content: string): Record<string, string> {
  return Object.fromEntries(
    (content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
      .split('\n')
      .map((line) => line.split(/:\s*/, 2))
      .filter((parts) => parts.length === 2),
  );
}

// REQ-AGENT-026: Knowledge-Graph Persistence via Git
// REQ-AGENT-063: PR-Boundary Command Parsing
// REQ-BROWSER-003: Pi Native Browser Run Wrapper

describe('agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)', () => {
  it('generated configs array is non-empty', () => {
    expect(AGENTS_SEEDED_CONFIGS.length).toBeGreaterThan(0);
  });

  it('every entry has a valid key, contentType, content, and modes', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(typeof doc.key).toBe('string');
      expect(doc.key.length).toBeGreaterThan(0);
      expect(typeof doc.contentType).toBe('string');
      expect(typeof doc.content).toBe('string');
      expect(Array.isArray(doc.modes)).toBe(true);
    }
  });

  it('every entry has non-empty modes array with only "default" and/or "advanced"', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(doc.modes.length, `${doc.key} should have at least one mode`).toBeGreaterThan(0);
      for (const mode of doc.modes) {
        expect(['default', 'advanced']).toContain(mode);
      }
    }
  });

  // REQ-MEM-006 AC4: Pro mode seeds a strict superset of Standard's preseed files;
  // the memory and vault plugins/rules are part of the Pro-only delta.
  it('"advanced" is a superset of "default" -- all default keys also appear in advanced', () => {
    const defaultKeys = new Set(
      AGENTS_SEEDED_CONFIGS.filter((doc) => doc.modes.includes('default')).map((doc) => doc.key)
    );
    const advancedKeys = new Set(
      AGENTS_SEEDED_CONFIGS.filter((doc) => doc.modes.includes('advanced')).map((doc) => doc.key)
    );

    for (const key of defaultKeys) {
      expect(advancedKeys, `default key "${key}" missing from advanced`).toContain(key);
    }
  });

  it('no path traversal, no leading / or ., no backslashes in relative portion of keys', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      const rel = stripPrefix(doc.key);
      expect(rel).not.toContain('..');
      expect(rel.startsWith('/')).toBe(false);
      expect(rel.startsWith('.')).toBe(false);
      expect(rel).not.toContain('\\');
    }
  });

  it('all keys start with a valid agent prefix', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      const hasValidPrefix = VALID_KEY_PREFIXES.some((p) => doc.key.startsWith(p));
      expect(hasValidPrefix, `key "${doc.key}" has no valid prefix`).toBe(true);
    }
  });

  it('manifest.json itself is NOT included in generated seed output', () => {
    const keys = AGENTS_SEEDED_CONFIGS.map((doc) => doc.key);
    expect(keys).not.toContain('.claude/manifest.json');
    expect(keys).not.toContain('manifest.json');
  });

  it('no duplicate (key, mode) pairs', () => {
    const seen = new Set<string>();
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      for (const mode of doc.modes) {
        const pair = `${doc.key}::${mode}`;
        expect(seen.has(pair), `duplicate (key, mode): ${pair}`).toBe(false);
        seen.add(pair);
      }
    }
  });

  it('Claude docs have no duplicate keys', () => {
    const keys = claudeDocs().map((doc) => doc.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});

// REQ-AGENT-071: PR-Boundary Review Agent Dispatch
// REQ-AGENT-073: Pi Review Monitor Delivery Reliability
describe('multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape) / REQ-AGENT-071', () => {
  it('each non-Claude agent has an instructions file', () => {
    const keys = new Set(AGENTS_SEEDED_CONFIGS.map((doc) => doc.key));
    expect(keys.has('.codex/AGENTS.md')).toBe(true);
    expect(keys.has('.gemini/GEMINI.md')).toBe(true);
    expect(keys.has('.copilot/copilot-instructions.md')).toBe(true);
    expect(keys.has('.config/opencode/AGENTS.md')).toBe(true);
    expect(keys.has('.pi/agent/AGENTS.md')).toBe(true);
  });

  it('instructions files appear twice (one per mode, different content)', () => {
    const instructionKeys = [
      '.codex/AGENTS.md',
      '.gemini/GEMINI.md',
      '.copilot/copilot-instructions.md',
      '.config/opencode/AGENTS.md',
      '.pi/agent/AGENTS.md',
    ];
    for (const key of instructionKeys) {
      const entries = AGENTS_SEEDED_CONFIGS.filter((d) => d.key === key);
      expect(entries, `${key} should have 2 entries`).toHaveLength(2);
      const modes = entries.map((e) => e.modes).flat().sort();
      expect(modes).toEqual(['advanced', 'default']);
    }
  });

  it('REQ-AGENT-056 AC1: seeds the Pi local statusline in default and advanced modes', () => {
    const entries = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === '.pi/agent/extensions/local-statusline.ts');
    expect(entries).toHaveLength(1);
    expect([...entries[0]!.modes].sort()).toEqual(['advanced', 'default']);
    expect(entries[0]!.contentType).toBe('text/typescript; charset=utf-8');
  });

  it('REQ-AGENT-080 AC3: seeds the boundary dispatcher in both modes but reviewers only in advanced', () => {
    for (const key of [
      '.pi/agent/extensions/active-repo-memory.ts',
      '.pi/agent/extensions/review-enforcement.ts',
      '.pi/agent/extensions/review-helpers.ts',
      '.pi/agent/extensions/review-scope.ts',
    ]) {
      const document = AGENTS_SEEDED_CONFIGS.find((entry) => entry.key === key);
      expect(document?.modes).toEqual(['default', 'advanced']);
    }
    for (const reviewer of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const document = AGENTS_SEEDED_CONFIGS.find((entry) => entry.key === `.pi/agent/agents/${reviewer}.md`);
      expect(document?.modes).toEqual(['advanced']);
    }
  });

  it('REQ-AGENT-085: generated reviewers grant direct context execution without indexed batch retrieval', () => {
    for (const reviewer of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const document = AGENTS_SEEDED_CONFIGS.find(
        (entry) => entry.key === `.pi/agent/agents/${reviewer}.md`,
      );
      const tools = frontmatter(document?.content ?? '').tools.split(/,\s*/);
      expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'bash', 'ctx_execute']));
      expect(tools).not.toContain('ctx_batch_execute');
    }
  });

  it('REQ-AGENT-068/070: seeds distinct Claude and Pi CI workflow contracts', () => {
    const claudeGitWorkflow = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/rules/git-workflow.md');
    const claudeCiSkill = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/skills/ci-monitoring/SKILL.md');
    const piGitWorkflow = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/rules/git-workflow.md');
    const piCiSkill = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/skills/ci-monitoring/SKILL.md');

    expect([...(claudeGitWorkflow?.modes ?? [])].sort()).toEqual(['advanced', 'default']);
    expect([...(claudeCiSkill?.modes ?? [])].sort()).toEqual(['advanced', 'default']);
    expect([...(piGitWorkflow?.modes ?? [])].sort()).toEqual(['advanced', 'default']);
    expect([...(piCiSkill?.modes ?? [])].sort()).toEqual(['advanced', 'default']);
    expect(claudeGitWorkflow?.content).not.toEqual(piGitWorkflow?.content);
    expect(claudeCiSkill?.content).not.toEqual(piCiSkill?.content);

    const piCiMonitor = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/agents/ci-monitor.md');
    const piMonitorModule = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs');
    expect(piCiMonitor).toMatchObject({
      key: '.pi/agent/agents/ci-monitor.md',
      contentType: 'text/markdown; charset=utf-8',
      modes: ['default', 'advanced'],
    });
    const piCiFrontmatter = frontmatter(piCiMonitor?.content ?? '');
    expect(piCiFrontmatter).toMatchObject({
      name: 'ci-monitor',
      tools: 'bash',
      prompt_mode: 'replace',
      run_in_background: 'true',
      inherit_context: 'false',
    });
    expect(piCiFrontmatter).not.toHaveProperty('max_turns');
    expect(piMonitorModule).toMatchObject({
      key: '.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs',
      contentType: 'text/javascript; charset=utf-8',
      modes: ['default', 'advanced'],
    });

    const seededKeys = AGENTS_SEEDED_CONFIGS.map((doc) => doc.key);
    expect(seededKeys).not.toEqual(expect.arrayContaining([
      '.pi/agent/agents/review-monitor.md',
      '.pi/agent/extensions/review-job-helpers.ts',
      '.pi/agent/extensions/review-jobs.ts',
      '.pi/agent/extensions/review-lane-guards.ts',
    ]));

  });

  it('preseeds work continuity, review push, and result handoff gates into every generated instruction surface', () => {
    const instructionKeys = [
      '.codex/AGENTS.md',
      '.gemini/GEMINI.md',
      '.copilot/copilot-instructions.md',
      '.config/opencode/AGENTS.md',
      '.pi/agent/AGENTS.md',
    ];

    const claudeRule = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/rules/engineering-constitution.md');
    expect(markdownHeadings(claudeRule?.content ?? '')).toEqual(expect.arrayContaining([
      'Work continuity',
      'Review push gate',
      'Review-result handoff gate',
      'CI-result handoff gate',
    ]));

    for (const key of instructionKeys) {
      const entries = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === key);
      const modes = entries.flatMap((entry) => entry.modes).sort();
      expect(modes, `${key} should have generated mode entries`).toEqual(['advanced', 'default']);
      for (const entry of entries) {
        expect(markdownHeadings(entry.content), `${key} ${entry.modes.join(',')} includes gate sections`).toEqual(expect.arrayContaining([
          'Work continuity',
          'Review push gate',
          'Review-result handoff gate',
          'CI-result handoff gate',
        ]));
      }
    }
  });

  it('Codex has skills but no agent definitions', () => {
    const codexDocs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.codex/'));
    const skills = codexDocs.filter((d) => d.key.includes('/skills/'));
    const agents = codexDocs.filter((d) => d.key.includes('/agents/'));
    expect(skills.length).toBeGreaterThan(0);
    expect(agents.length).toBe(0);
  });

  it('Copilot has agent definitions but no skills', () => {
    const copilotDocs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.copilot/'));
    const skills = copilotDocs.filter((d) => d.key.includes('/skills/'));
    const agents = copilotDocs.filter((d) => d.key.includes('/agents/'));
    expect(skills.length).toBe(0);
    expect(agents.length).toBeGreaterThan(0);
  });

  it('OpenCode has both skills and agent definitions', () => {
    for (const prefix of ['.config/opencode/']) {
      const docs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith(prefix));
      const skills = docs.filter((d) => d.key.includes('/skills/'));
      const agents = docs.filter((d) =>
        d.key.includes('/agents/') && !d.key.endsWith('AGENTS.md')
      );
      expect(skills.length, `${prefix} should have skills`).toBeGreaterThan(0);
      expect(agents.length, `${prefix} should have agents`).toBeGreaterThan(0);
    }
  });

  it('Antigravity (agy) has both skills and agent definitions under the .gemini global config dir', () => {
    const docs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.gemini/'));
    const skills = docs.filter((d) => d.key.startsWith('.gemini/skills/'));
    const agents = docs.filter((d) => d.key.startsWith('.gemini/agents/') && !d.key.endsWith('GEMINI.md'));
    expect(skills.length, '.gemini should have skills (global ~/.gemini/skills auto-load)').toBeGreaterThan(0);
    expect(agents.length, '.gemini should have agent definitions').toBeGreaterThan(0);
    // Claude-only skills are excluded from the transformed lane.
    expect(skills.map((d) => d.key)).not.toContain('.gemini/skills/consult-llm/SKILL.md');
  });

  it('Antigravity agents use Gemini-native tool names and ~/.gemini path rewrites', () => {
    const agents = AGENTS_SEEDED_CONFIGS.filter(
      (d) => d.key.startsWith('.gemini/agents/') && !d.key.endsWith('GEMINI.md')
    );
    const codeReviewer = agents.find((d) => d.key === '.gemini/agents/code-reviewer.md');
    expect(codeReviewer, '.gemini/agents/code-reviewer.md should exist').toBeTruthy();
    const toolsLine = codeReviewer!.content.match(/^tools:.*$/m)?.[0] ?? '';
    // Gemini CLI tool vocabulary: Read->read_file, Bash->run_shell_command, Glob->glob, etc.
    expect(toolsLine).toContain('read_file');
    expect(toolsLine).toContain('run_shell_command');
    expect(toolsLine).toContain('glob');
    // mcp__ tool names are dropped from the frontmatter tools list (no Gemini equivalent).
    expect(toolsLine).not.toContain('mcp__');
    // Model pin stripped so agy defaults to the active runtime model.
    expect(codeReviewer!.content).not.toContain('\nmodel:');
    // Paths rewritten from ~/.claude/ to ~/.gemini/.
    const gemini = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.gemini/GEMINI.md');
    expect(gemini!.content).not.toContain('~/.claude/');
  });

  it('REQ-BROWSER-004: the browser-e2e skill is seeded for Claude and Pi (both interactive), advanced mode', () => {
    // Claude drives the interactive surface (chrome-devtools): the skill must reach
    // .claude and name that surface, so the agent knows what tools to use.
    const claudeE2e = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.claude/skills/browser-e2e/SKILL.md');
    expect(claudeE2e).toBeDefined();
    expect(claudeE2e!.modes).toContain('advanced');
    expect(claudeE2e!.content).toContain('chrome-devtools');
    // The feature is semantic e2e (judgment), distinct from the browser-run fetch
    // fallback — the skill must position itself as a verify-by-judgment complement.
    expect(claudeE2e!.content.toLowerCase()).toContain('semantic');
    // Pi now has FULL parity: it drives the same chrome-devtools surface through the
    // pi-mcp-adapter (REQ-BROWSER-006), so its e2e skill must name chrome-devtools
    // (interactive) AND keep browser_markdown as the cheap read-only path.
    const piE2e = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/skills/browser-e2e/SKILL.md');
    expect(piE2e).toBeDefined();
    expect(piE2e!.modes).toContain('advanced');
    expect(piE2e!.content).toContain('chrome-devtools');
    expect(piE2e!.content).toContain('browser_markdown');
    // AC3: both skills scope to public/deployed targets (call out localhost as
    // unreachable) and keep deterministic invariants in CI.
    for (const e2e of [claudeE2e!, piE2e!]) {
      expect(e2e.content).toContain('localhost');
      expect(e2e.content).toContain('CI');
    }
  });

  it('REQ-BROWSER-005/006: the browser-run skill carries BOTH surfaces for each agent (cheap markdown + interactive chrome-devtools)', () => {
    // After symmetry: every agent has a cheap one-shot read surface
    // (browser_markdown/content/scrape) AND the interactive chrome-devtools surface.
    // The browser-run decision skill must name both so the agent picks the cheaper.
    const claudeRun = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.claude/skills/browser-run/SKILL.md');
    expect(claudeRun).toBeDefined();
    expect(claudeRun!.modes).toContain('advanced');
    expect(claudeRun!.content).toContain('browser_markdown');
    expect(claudeRun!.content).toContain('chrome-devtools');
    const piRun = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/skills/browser-run/SKILL.md');
    expect(piRun).toBeDefined();
    expect(piRun!.modes).toContain('advanced');
    expect(piRun!.content).toContain('browser_markdown');
    expect(piRun!.content).toContain('chrome-devtools');
    // REQ-005 AC4 / REQ-006 AC3: the skill frames an explicit decision order so the
    // agent reaches for the cheap read surface before the expensive interactive one.
    expect(claudeRun!.content).toContain('Decision order');
    expect(piRun!.content).toContain('Decision order');
  });

  it('REQ-AGENT-021: Pi has skills, native runtime extensions, and subagent definitions', () => {
    const piDocs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/'));
    const skills = piDocs.filter((d) => d.key.startsWith('.pi/agent/skills/'));
    const agents = piDocs.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const extensions = piDocs.filter((d) => d.key.startsWith('.pi/agent/extensions/'));
    const scripts = piDocs.filter((d) => d.key.startsWith('.pi/agent/scripts/'));
    expect(skills.length).toBeGreaterThan(0);
    expect(extensions.map((d) => d.key).sort()).toEqual([
      '.pi/agent/extensions/active-repo-memory.ts',
      '.pi/agent/extensions/browser-run-helpers.ts',
      '.pi/agent/extensions/browser-run.ts',
      '.pi/agent/extensions/codeflare-commands.ts',
      '.pi/agent/extensions/codeflare-pi.ts',
      '.pi/agent/extensions/commands-helpers.ts',
      '.pi/agent/extensions/graphify-helpers.ts',
      '.pi/agent/extensions/graphify-native.ts',
      '.pi/agent/extensions/guard-helpers.ts',
      '.pi/agent/extensions/local-statusline.ts',
      '.pi/agent/extensions/memory-vault-helpers.ts',
      '.pi/agent/extensions/memory-vault.ts',
      '.pi/agent/extensions/review-command.ts',
      '.pi/agent/extensions/review-enforcement.ts',
      '.pi/agent/extensions/review-helpers.ts',
      '.pi/agent/extensions/review-scope.ts',
      '.pi/agent/extensions/sdd-helpers.ts',
      '.pi/agent/extensions/startup-header.ts',
      '.pi/agent/extensions/vault-manifest-fs.ts',
    ]);
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/Explore.md');
    for (const reviewer of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      expect(agents.filter((doc) => doc.key === `.pi/agent/agents/${reviewer}.md`)).toHaveLength(1);
    }
    for (const skill of [
      'review-scope', 'spec-enforce', 'spec-enforce-ac', 'spec-enforce-truth',
      'doc-enforce', 'doc-enforce-lanes', 'doc-enforce-shape', 'doc-enforce-truth',
    ]) {
      expect(skills.filter((doc) => doc.key === `.pi/agent/skills/${skill}/SKILL.md`)).toHaveLength(1);
    }
    expect(skills.map((d) => d.key).filter((key) => key === '.pi/agent/skills/graphify/SKILL.md')).toHaveLength(1);
    expect(skills.map((d) => d.key)).toContain('.pi/agent/skills/review-scope/scripts/build-review-packet.mjs');
    for (const skill of ['spec-driven-development', 'sdd-init', 'sdd-clean']) {
      const doc = skills.find((d) => d.key === `.pi/agent/skills/${skill}/SKILL.md`);
      expect(doc, `REQ-AGENT-021 ${skill} skill`).toBeDefined();
      expect(doc!.content).toContain('Pi runtime compatibility');
      expect(doc!.content).toContain('graphify_query');
      expect(doc!.content).toContain('Agent');
    }
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/sdd-helpers.ts');
    expect(scripts.map((d) => d.key)).toContain('.pi/agent/scripts/safe-graphify-update.sh');
    expect(scripts.map((d) => d.key)).toContain('.pi/agent/scripts/build-graphify-ast.sh');
    expect(scripts.map((d) => d.key)).toContain('.pi/agent/scripts/build-graphify-architecture.sh');
    // Pi-native first-class residents: the review skill and codeflare-commands extension
    // are emitted directly (not transformed from Claude), so the Pi manifest -> seed pipeline
    // must surface them.
    expect(skills.map((d) => d.key)).toContain('.pi/agent/skills/review/SKILL.md');
    // Browser e2e (REQ-BROWSER-004): Pi gets its DEDICATED skill, emitted from the
    // Pi manifest, not the transformed Claude one (proof the line-489 native-skip
    // used the right source). Pi now has full parity — it drives chrome-devtools
    // through the pi-mcp-adapter (REQ-BROWSER-006) — so the skill must name BOTH
    // chrome-devtools (interactive) and browser_markdown (the cheap read path).
    const piBrowserE2e = skills.find((d) => d.key === '.pi/agent/skills/browser-e2e/SKILL.md');
    expect(piBrowserE2e).toBeDefined();
    expect(piBrowserE2e!.content).toContain('browser_markdown');
    expect(piBrowserE2e!.content).toContain('chrome-devtools');
    // The five Pi tool-extension skills ship a "when to use which tool" guide; the
    // manifest -> seed pipeline must surface each one (advisor is codeflare-authored
    // for the @juicesharp/rpiv-advisor extension, which ships no skill of its own).
    for (const skill of ['advisor', 'rpiv-ask-user-question', 'rpiv-todo', 'pi-web-access', 'pi-mcp-adapter']) {
      expect(skills.map((d) => d.key)).toContain(`.pi/agent/skills/${skill}/SKILL.md`);
    }
    const advisorSkill = skills.find((d) => d.key === '.pi/agent/skills/advisor/SKILL.md');
    expect(advisorSkill?.content).toContain('Only the user may invoke advisor');
    expect(advisorSkill?.content).toContain('must not run, simulate, or recommend that command unless asked');
    expect(advisorSkill?.content).not.toContain('when stuck, before substantive work, or before declaring done');
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/codeflare-commands.ts');
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/local-statusline.ts');
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/context-mode-runtime.ts');
    const codeReviewer = agents.find((d) => d.key === '.pi/agent/agents/code-reviewer.md');
    expect(frontmatter(codeReviewer?.content ?? '')).toMatchObject({
      tools: 'read, grep, bash, ctx_execute, graphify_query, graphify_explain, graphify_path',
      prompt_mode: 'replace',
      extensions: 'true',
    });
    expect(frontmatter(codeReviewer?.content ?? '')).not.toHaveProperty('skills');
    // Pi subagents crash when inherit_context is forced through frontmatter; foreground/background
    // defaults are left to the caller except for explicitly background-only agents.
    expect(codeReviewer?.content).not.toContain('inherit_context: true');
    expect(codeReviewer?.content).not.toContain('run_in_background: false');
    const explore = agents.find((d) => d.key === '.pi/agent/agents/Explore.md');
    const exploreToolsLine = explore?.content.match(/^tools:.*$/m)?.[0] ?? '';
    expect(explore?.content).not.toContain('\nmodel:');
    expect(exploreToolsLine).toBe('tools: read, bash, grep, find, ls, graphify_query, graphify_explain, graphify_path');
    expect(explore?.content).toContain('no hardcoded provider');
    for (const agent of agents) {
      expect(agent.content).not.toContain('\nmodel:');
    }
    const codeflarePi = extensions.find((d) => d.key === '.pi/agent/extensions/codeflare-pi.ts');
    expect(codeflarePi?.content).toContain('pi.registerCommand("ctx"');
    expect(codeflarePi?.content).toContain('context-mode is disabled');

  });

  it('REQ-AGENT-021: every Pi extension exports a default factory (Pi rejects a non-factory .ts at load)', () => {
    // Pi's extension scanner loads EVERY .ts under .pi/agent/extensions/ and throws
    // "Extension does not export a valid factory function" if a file has no default
    // export — even helper-only modules, which therefore ship a no-op default factory.
    // A named-export-only module (vault-manifest-fs.ts as first shipped) crashed Pi at
    // startup ("Failed to load extension ... valid factory function"). This guard catches
    // that before it ships; a syntax-only check (node --check) does NOT — it passed the
    // broken file. Verified live against pi 0.80.3 (the no-default copy reproduces the
    // error; adding the factory loads clean).
    const piExtensions = AGENTS_SEEDED_CONFIGS.filter(
      (d) => d.key.startsWith('.pi/agent/extensions/') && d.key.endsWith('.ts'),
    );
    expect(piExtensions.length).toBeGreaterThan(0);
    for (const ext of piExtensions) {
      expect(
        ext.content,
        `${ext.key} must export a default factory — Pi throws "does not export a valid factory function" otherwise`,
      ).toMatch(/export default (function|async function|\(|[A-Za-z_$])/);
    }
  });

  it('REQ-AGENT-030 / REQ-AGENT-050 / REQ-AGENT-051: Pi command extensions dispatch through both ctx and pi user-message APIs', () => {
    const commandExtensionKeys = [
      '.pi/agent/extensions/codeflare-pi.ts',
      '.pi/agent/extensions/codeflare-commands.ts',
      '.pi/agent/extensions/review-command.ts',
    ];
    const docs = AGENTS_SEEDED_CONFIGS.filter((d) => commandExtensionKeys.includes(d.key));
    expect(docs.map((d) => d.key).sort()).toEqual(commandExtensionKeys.sort());
    for (const doc of docs) {
      expect(doc.content, `${doc.key} must not assume ExtensionCommandContext has sendUserMessage`).not.toContain('ctx.sendUserMessage(');
      expect(doc.content, `${doc.key} must fall back to ExtensionAPI.sendUserMessage`).toContain('pi.sendUserMessage');
    }
  });

  it('REQ-AGENT-076 AC6: Pi context-mode runtime extension clears an inherited bridge-idle override so context-mode governs per-session', () => {
    const prev = process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
    try {
      process.env.CONTEXT_MODE_BRIDGE_IDLE_MS = '0';
      contextModeRuntime();
      expect(process.env.CONTEXT_MODE_BRIDGE_IDLE_MS).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
      else process.env.CONTEXT_MODE_BRIDGE_IDLE_MS = prev;
    }
  });

  it('Pi agents use Pi-native tool names and keep declared context-mode tools (not stripped, never mcp-prefixed)', () => {
    const agents = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const toolsLine = (content: string) => content.match(/^tools:.*$/m)?.[0] ?? '';
    for (const agent of agents) {
      // the Claude->Pi remap is complete: Pi agent frontmatter and body carry Pi-native names,
      // so subagents never try unavailable Claude MCP tool names at runtime.
      expect(toolsLine(agent.content)).not.toContain('mcp__');
      expect(agent.content).not.toContain('mcp__graphify__');
      expect(agent.content).not.toContain('mcp__context-mode__');
    }
    // an agent that declares context-mode tools upstream keeps them under Pi-native names,
    // so context-mode (when /ctx enables it) is usable instead of a dead-end redirect
    const codeReviewer = agents.find((d) => d.key === '.pi/agent/agents/code-reviewer.md');
    expect(toolsLine(codeReviewer?.content ?? '')).toContain('ctx_execute');
    expect(toolsLine(codeReviewer?.content ?? '')).toContain('ctx_batch_execute');
  });

  it('REQ-AGENT-025 / REQ-AGENT-043: Pi graphify clone triage resolves clone destinations and branches on graph state', () => {
    expect(cloneTargetPath('git clone https://github.com/o/r.git', '/home/user/workspace')).toBe('/home/user/workspace/r');
    expect(cloneTargetPath('git clone --branch main --depth 1 https://github.com/o/r.git', '/home/user/workspace')).toBe('/home/user/workspace/r');
    expect(cloneTargetPath('cd /tmp && git clone https://github.com/o/r.git custom-dir', '/home/user/workspace')).toBe('/tmp/custom-dir');
    expect(cloneTargetPath('gh repo clone o/r /tmp/r2', '/home/user/workspace')).toBe('/tmp/r2');
    expect(cloneTargetPath('owner=$(gh api user --jq .login)\ngh repo clone "$owner/codeflare" "$repo"', '/home/user/workspace', "Cloning into '/home/user/workspace/codeflare'...")).toBe('/home/user/workspace/codeflare');
    expect(cloneTargetPath('owner=$(gh api user --jq .login)\ngh repo clone "$owner/codeflare" "$repo"', '/home/user/workspace')).toBeUndefined();

    const missingGraphDirective = renderGraphifyCloneDirective(graphifyCloneAction('/repo', false));
    expect(missingGraphDirective).toContain('ask the user which graph action to take');
    expect(missingGraphDirective).toContain('Full repo AST-only build');
    expect(missingGraphDirective).toContain('Full repo semantic build');
    expect(missingGraphDirective).toContain('no graph action');
    expect(missingGraphDirective).toContain('Pi Agent subagents from this running session');
    const existingGraphDirective = renderGraphifyCloneDirective(graphifyCloneAction('/repo', true));
    expect(existingGraphDirective).toContain('Do not update the graph automatically');
    expect(existingGraphDirective).toContain('ask the user which graph action to take');
    expect(existingGraphDirective).toContain('safe-graphify-update.sh /repo');
    expect(existingGraphDirective).toContain('Full repo semantic refresh');
    expect(existingGraphDirective).toContain('Never run the AST update wrapper or a semantic refresh until the user has chosen');
    expect(existingGraphDirective).not.toContain('No graph action');

    expect(graphifyCloneAction('/repo', false)).toEqual({
      repo: '/repo',
      hasGraph: false,
      mode: 'missing-graph',
      choices: ['Full repo AST-only build', 'Full repo semantic build', 'skip'],
    });
    expect(graphifyCloneAction('/repo', true)).toEqual({
      repo: '/repo',
      hasGraph: true,
      mode: 'existing-graph',
      freshness: 'unknown',
      choices: ['use existing graph as-is', 'Full repo AST-only update', 'Full repo semantic refresh'],
    });
    // FIX 3: a stale graph carries freshness 'stale' and renders an explicit STALE lead.
    const staleAction = graphifyCloneAction('/repo', true, 'stale');
    expect(staleAction.freshness).toBe('stale');
    expect(renderGraphifyCloneDirective(staleAction)).toContain('STALE');
    expect(renderGraphifyCloneDirective(staleAction)).not.toContain('an existing graphify graph was found');
    expect(graphifyPromptMarker('/home/user/workspace/r', 'session-1')).toBe('/tmp/codeflare-graphify-prompted-session-1_home_user_workspace_r');
    expect(isFailedGraphifyToolExecution({ status: 'error' })).toBe(true);
    expect(isFailedGraphifyToolExecution({ isError: false })).toBe(false);
    expect(shouldHandleClonePrompt('git clone https://github.com/foo/bar /tmp/bar', false, 1)).toBe(false);
    expect(shouldHandleClonePrompt('gh repo clone foo/bar /tmp/bar', false, 2)).toBe(false);
    expect(shouldHandleClonePrompt('git clone https://github.com/foo/bar /tmp/bar', true, 0)).toBe(false);
    expect(shouldHandleClonePrompt('git clone https://github.com/foo/bar /tmp/bar', false, 0)).toBe(true);

    expect(restoreActiveRepoFromPersistedFiles(
      ['/missing-review-active', '/graphify-active'],
      (path) => {
        if (path === '/missing-review-active') throw new Error('missing');
        return '/home/user/workspace/codeflare\n';
      },
      (path) => path === '/home/user/workspace/codeflare',
    )).toBe('/home/user/workspace/codeflare');

    const decision = graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: false,
      findGitRoot: (path) => `${path}/.git-root`,
      hasGraph: (repo) => repo.endsWith('.git-root'),
      exists: () => true,
    });
    expect(decision).toEqual({
      repo: '/home/user/workspace/r/.git-root',
      marker: '/tmp/codeflare-graphify-prompted-session-1_home_user_workspace_r_.git-root',
      action: {
        repo: '/home/user/workspace/r/.git-root',
        hasGraph: true,
        mode: 'existing-graph',
        freshness: 'unknown',
        choices: ['use existing graph as-is', 'Full repo AST-only update', 'Full repo semantic refresh'],
      },
    });
    expect(graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: true,
      findGitRoot: () => undefined,
      hasGraph: () => false,
      exists: () => true,
    })).toBeUndefined();
    // FIX 3: a parsed-but-bogus destination that is not on disk yields no prompt.
    expect(graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git ,',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: false,
      findGitRoot: () => '/home/user/workspace/r',
      hasGraph: () => false,
      exists: () => false,
    })).toBeUndefined();
    // FIX 3: env-var-prefixed clone forms resolve their destination via ENV_PREFIX.
    expect(cloneTargetPath('BROWSER="" gh repo clone o/r', '/home/user/workspace')).toBe('/home/user/workspace/r');
    expect(cloneTargetPath('GIT_TERMINAL_PROMPT=0 git clone https://github.com/o/r.git', '/home/user/workspace')).toBe('/home/user/workspace/r');
    expect(cloneTargetPath('env BROWSER="" gh repo clone o/r', '/home/user/workspace')).toBe('/home/user/workspace/r');
    // FIX 3: a stale existing graph threads freshness through the decision action.
    const staleDecision = graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: false,
      findGitRoot: () => '/home/user/workspace/r',
      hasGraph: () => true,
      exists: () => true,
      freshness: () => 'stale',
    });
    expect(staleDecision?.action.freshness).toBe('stale');
  });

  it('REQ-AGENT-023: Pi native runtime assets expose first-party graphify-native tools (no MCP, no third-party wrapper)', () => {
    const keys = new Set(AGENTS_SEEDED_CONFIGS.map((doc) => doc.key));
    // Pi has no MCP client: graphify is a first-party native extension, never an MCP server.
    expect(keys.has('.pi/agent/extensions/graphify-native.ts')).toBe(true);
    expect(keys.has('.pi/agent/mcp.json')).toBe(false);
    expect(keys.has('.pi/agent/npm/package.json')).toBe(true);
    expect(keys.has('.pi/agent/npm/package-lock.json')).toBe(true);
    expect(keys.has('.pi/agent/skills/graphify/SKILL.md')).toBe(true);
    expect(keys.has('.pi/agent/scripts/safe-graphify-update.sh')).toBe(true);
    expect(keys.has('.pi/agent/scripts/build-graphify-ast.sh')).toBe(true);
    expect(keys.has('.pi/agent/scripts/build-graphify-architecture.sh')).toBe(true);
    expect(keys.has('.pi/agent/scripts/local-graphify-labels.sh')).toBe(true);
    // The third-party @gaodes/pi-graphify wrapper is gone from the Pi npm closure.
    const piPackage = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/npm/package.json');
    expect(piPackage?.content ?? '').not.toContain('@gaodes/pi-graphify');
    // graphify-native is ambient (default + advanced); the heavier graph-build scripts stay advanced-only.
    const graphifyNative = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/extensions/graphify-native.ts');
    expect(graphifyNative?.modes).toEqual(['default', 'advanced']);
    const graphifyHelpers = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/extensions/graphify-helpers.ts');
    expect(graphifyHelpers?.modes).toEqual(['default', 'advanced']);
    for (const key of [
      '.pi/agent/skills/graphify/SKILL.md',
      '.pi/agent/scripts/safe-graphify-update.sh',
      '.pi/agent/scripts/build-graphify-ast.sh',
      '.pi/agent/scripts/build-graphify-architecture.sh',
      '.pi/agent/scripts/local-graphify-labels.sh',
    ]) {
      const doc = AGENTS_SEEDED_CONFIGS.find((entry) => entry.key === key);
      expect(doc?.modes, `${key} should be advanced-only`).toEqual(['advanced']);
    }
  });

  it('REQ-AGENT-024 AC5-AC6 / REQ-AGENT-043: Pi graphify skill preserves durable graph artifacts and stays model-agnostic', () => {
    const skill = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/skills/graphify/SKILL.md');
    expect(skill?.content).toContain('build-graphify-ast.sh');
    expect(skill?.content).toContain('build-graphify-architecture.sh');
    expect(skill?.content).toContain('safe-graphify-update.sh');
    expect(skill?.content).toContain('Do not pass a model override');
    expect(skill?.content).toContain('running session model');
    expect(skill?.content).toContain('Pi main session agent');
    expect(skill?.content).toContain('local-graphify-labels.sh apply .');
    expect(skill?.content).toContain('existing community assignments');
    expect(skill?.content).not.toContain('graphify label . --backend=gemini');
    expect(skill?.content).not.toContain('--backend=gemini');
    expect(skill?.content).toContain('Do not commit caches, manifests, chunks, or `.graphify_*` intermediates other than `.graphify_labels.json`');
    expect(skill?.content).toContain('graphify-out/graph.json merge=graphify');
    expect(skill?.content).toContain('graphify-out/graph.json');
    expect(skill?.content).toContain('graphify-out/GRAPH_REPORT.md');
    expect(skill?.content).toContain('graphify-out/graph.html');
    expect(skill?.content).toContain('graphify-out/callflow.html');
  });

  // Pi as a first-class resident: the Pi manifest's prompts/* entries are emitted
  // as native runtime assets under .pi/agent/prompts/* (piNativeKey maps prompts/* ->
  // .pi/agent/prompts/*). These are the memory-capture and vault-extract subagent prompts.
  it('REQ-AGENT-023: Pi native prompt assets are seeded under .pi/agent/prompts/', () => {
    const prompts = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/prompts/'));
    const keys = prompts.map((d) => d.key).sort();
    expect(keys).toEqual([
      '.pi/agent/prompts/memory-agent-prompt.md',
      '.pi/agent/prompts/vault-extract-prompt.md',
    ]);
    // prompts/* maps to .pi/agent/prompts/* (not .claude/, not stripped) and the
    // bodies are non-empty markdown carried verbatim from the Pi preseed tree.
    for (const doc of prompts) {
      expect(doc.contentType).toBe('text/markdown; charset=utf-8');
      expect(doc.content.length).toBeGreaterThan(0);
      // advanced-only per the Pi manifest (memory/vault capture is a Pro-only delta).
      expect(doc.modes).toEqual(['advanced']);
    }
  });

  // REQ-AGENT-031 AC4: consult-llm is scoped to Claude + Pi ONLY. Claude gets it
  // from its manifest; Pi gets it as a native skill (pi/manifest.json) paired with
  // the pi-mcp-adapter lazy proxy. codex/opencode/antigravity never get
  // it (they have no consult-llm MCP server, so the skill would reference a missing
  // tool) - it stays in CLAUDE_ONLY_SKILLS, which excludes it from the transform lane.
  it('consult-llm skill is available to Claude and Pi only', () => {
    const consultKeys = AGENTS_SEEDED_CONFIGS
      .map((d) => d.key)
      .filter((k) => k.includes('consult-llm'))
      .sort();
    expect(consultKeys).toEqual([
      '.claude/skills/consult-llm/SKILL.md',
      '.pi/agent/skills/consult-llm/SKILL.md',
    ]);
  });

  // Pi-native and transformed Pi *.md documents (skills, prompts, agent definitions,
  // instructions) must not carry Claude model names: the Pi runtime supplies its own model,
  // and adaptAgentFrontmatter strips `model:` pins. Scoped to *.md only because the
  // model-name prose rule applies to authored docs, not to .ts extension source code.
  it('REQ-AGENT-007: Pi markdown documents contain no Claude model names', () => {
    const piMarkdown = AGENTS_SEEDED_CONFIGS.filter(
      (d) => d.key.startsWith('.pi/agent/') && d.key.endsWith('.md')
    );
    expect(piMarkdown.length).toBeGreaterThan(0);
    const modelName = /\b(sonnet|opus|haiku)\b/i;
    for (const doc of piMarkdown) {
      expect(modelName.test(doc.content), `${doc.key} should not name a Claude model`).toBe(false);
    }
  });

  // REQ-MEM-008 AC2 (manifest declares the memory plugin files) + AC3 (all advanced-only).
  // memory-capture-block.sh is the PreToolUse hard-block companion to memory-capture.sh
  // (UserPromptSubmit) - it prevents the assistant from skipping the deferred capture
  // by hard-blocking all other tool calls while .vars is undrained.
  it('codeflare-memory plugin files are advanced-only', () => {
    const pluginDocs = claudeDocs().filter((d) => d.key.includes('codeflare-memory'));
    const fileNames = pluginDocs.map((d) => d.key.split('/').pop()).sort();
    expect(fileNames).toEqual([
      'assert-iso-ts.sh',
      'memory-agent-prompt.md',
      'memory-capture-block.sh',
      'memory-capture.sh',
      'memory-context-inject.sh',
      'plugin.json',
      'prefilter-transcript.sh',
    ]);
    for (const doc of pluginDocs) {
      expect(doc.modes).toEqual(['advanced']);
    }
  });

  // REQ-MEM-008 AC7 (memory plugin files excluded from non-CC agents; no Codex/Copilot/OpenCode equivalents)
  it('codeflare-memory plugin is excluded from non-Claude agents', () => {
    const nonClaude = AGENTS_SEEDED_CONFIGS.filter((d) => !d.key.startsWith('.claude/'));
    for (const doc of nonClaude) {
      expect(doc.key).not.toContain('codeflare-memory');
    }
  });

  // REQ-MEM-008 AC4 (hook script delivered via plugin, NOT via hooks/ - registered via settings.json merge)
  it('no standalone memory hook files remain in hooks/ directory', () => {
    const memoryHooks = claudeDocs().filter(
      (d) => d.key.startsWith('.claude/hooks/memory')
    );
    expect(memoryHooks).toHaveLength(0);
  });

  it('non-Claude agent definitions without model support have no model field in frontmatter', () => {
    const nonClaudeAgents = AGENTS_SEEDED_CONFIGS.filter(
      (d) =>
        !d.key.startsWith('.claude/') &&
        !d.key.startsWith('.pi/agent/agents/') &&
        d.key.includes('/agents/') &&
        !d.key.endsWith('AGENTS.md') &&
        !d.key.endsWith('copilot-instructions.md')
    );
    for (const doc of nonClaudeAgents) {
      const fmMatch = doc.content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        expect(fmMatch[1]).not.toMatch(/^model:/m);
      }
    }
  });

  it('Copilot agent files use .agent.md extension', () => {
    const copilotAgents = AGENTS_SEEDED_CONFIGS.filter(
      (d) => d.key.startsWith('.copilot/agents/') && !d.key.endsWith('copilot-instructions.md')
    );
    for (const doc of copilotAgents) {
      expect(doc.key).toMatch(/\.agent\.md$/);
    }
  });

  it('no ~/.claude/ references in non-Claude document content', () => {
    const nonClaude = AGENTS_SEEDED_CONFIGS.filter((d) => !d.key.startsWith('.claude/'));
    for (const doc of nonClaude) {
      expect(doc.content).not.toContain('~/.claude/');
    }
  });

  it('Pi context-mode enforcement extension is not preseeded', () => {
    const keys = new Set(AGENTS_SEEDED_CONFIGS.map((d) => d.key));
    expect(keys.has('.pi/agent/extensions/context-mode-enforcement.ts')).toBe(false);
  });
});

describe('Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)', () => {
  it('REQ-MEM-001 AC4: captureTimestamp produces ISO-shaped timestamp with timezone', () => {
    const ts = captureTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    const tsUtc = captureTimestamp('UTC');
    expect(tsUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it('REQ-MEM-001 AC4: captureFilename includes session ID and timestamp', () => {
    const fn = captureFilename('test-session');
    expect(fn).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-test-session\.md$/);
  });

  it('REQ-MEM-001: sessionId sanitizes special characters to underscores', () => {
    expect(sessionId({ sessionManager: { getSessionId: () => 'abc-123' } })).toBe('abc-123');
    expect(sessionId({ sessionManager: { getSessionId: () => 'a/b:c d' } })).toBe('a_b_c_d');
    expect(sessionId({})).toMatch(/^\d+$/);
  });

  it('REQ-MEM-001: compactMessages extracts role and content from conversation', () => {
    const result = compactMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    expect(result).toContain('## user');
    expect(result).toContain('hello');
    expect(result).toContain('## assistant');
    expect(result).toContain('world');
  });

  it('REQ-MEM-001: compactMessages handles nested message shapes and drops non-string/array content', () => {
    expect(compactMessages([{ message: { role: 'user', content: 'nested' } }])).toContain('## user');
    // Object content is neither a string nor a text-block array, so the turn carries no text and is dropped.
    const dropped = compactMessages([{ role: 'user', content: { data: 'x'.repeat(10000) } }]);
    expect(dropped).toBe('');
  });

  it('REQ-MEM-001 AC2: real-user prompt counting matches Claude synthetic-wrapper filtering', () => {
    const messages = [
      { role: 'user', content: 'real prompt' },
      { role: 'user', content: '<task-notification>done</task-notification>' },
      { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] },
      { role: 'assistant', content: 'reply' },
    ];
    expect(messages.map(isRealUserPrompt)).toEqual([true, false, false, false]);
    expect(realUserPromptCount(messages)).toBe(1);
    expect(compactMessages(messages)).toContain('real prompt');
    expect(compactMessages(messages)).not.toContain('task-notification');
  });

  it('REQ-MEM-002 AC7: withCurrentPrompt counts the submitted prompt once for resume detection', () => {
    const prior = [{ role: 'user', content: 'older prompt' }, { role: 'assistant', content: 'older answer' }];
    const withCurrent = withCurrentPrompt(prior, 'current prompt');
    expect(realUserPromptCount(withCurrent)).toBe(2);
    expect(withCurrentPrompt(withCurrent, 'current prompt')).toHaveLength(withCurrent.length);
    expect(withCurrentPrompt(withCurrent, '<task-notification>x</task-notification>')).toHaveLength(withCurrent.length);
  });

  // compactMessages is the AD58 transcript prefilter (memory-vault-helpers.ts): keep user +
  // assistant TEXT only, drop tool_use / tool_result / thinking blocks, take the last 200
  // turns, cap each turn at 8000 chars. Tested directly as a pure function over fake message arrays.
  describe('REQ-MEM-001: compactMessages prefilter (AD58)', () => {
    it('drops tool_use / tool_result / thinking blocks but keeps the text block of the same turn', () => {
      const result = compactMessages([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'SECRET-REASONING-should-be-dropped' },
            { type: 'text', text: 'visible-assistant-reply' },
            { type: 'tool_use', name: 'Bash', input: { command: 'TOOL-USE-should-be-dropped' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'TOOL-RESULT-should-be-dropped' },
            { type: 'text', text: 'visible-user-followup' },
          ],
        },
      ]);
      expect(result).toContain('visible-assistant-reply');
      expect(result).toContain('visible-user-followup');
      expect(result).not.toContain('SECRET-REASONING-should-be-dropped');
      expect(result).not.toContain('TOOL-USE-should-be-dropped');
      expect(result).not.toContain('TOOL-RESULT-should-be-dropped');
    });

    it('drops a turn whose only blocks are tool_use / tool_result (no text survives)', () => {
      const result = compactMessages([
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'file bytes' }] },
      ]);
      expect(result).toBe('');
    });

    it('keeps only user and assistant turns, dropping other roles', () => {
      const result = compactMessages([
        { role: 'system', content: 'system-prompt-should-be-dropped' },
        { role: 'user', content: 'kept-user' },
        { role: 'tool', content: 'tool-role-should-be-dropped' },
        { role: 'assistant', content: 'kept-assistant' },
      ]);
      expect(result).toContain('## user');
      expect(result).toContain('kept-user');
      expect(result).toContain('## assistant');
      expect(result).toContain('kept-assistant');
      expect(result).not.toContain('system-prompt-should-be-dropped');
      expect(result).not.toContain('tool-role-should-be-dropped');
    });

    it('handles both string content and array-of-text-blocks content', () => {
      const result = compactMessages([
        { role: 'user', content: 'plain-string-content' },
        { role: 'assistant', content: [{ type: 'text', text: 'first-block' }, { type: 'text', text: 'second-block' }] },
      ]);
      expect(result).toContain('plain-string-content');
      // multiple text blocks in one turn are newline-joined into a single turn body
      expect(result).toContain('first-block');
      expect(result).toContain('second-block');
      expect(result.indexOf('first-block')).toBeLessThan(result.indexOf('second-block'));
    });

    it('caps output to the last 200 turns', () => {
      const messages = Array.from({ length: 250 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${i}`,
      }));
      const result = compactMessages(messages);
      const turnCount = result.split('\n\n').length;
      expect(turnCount).toBe(200);
      // the earliest 50 turns are dropped; the last 200 survive
      expect(result).not.toContain('turn-0\n');
      expect(result).not.toContain('turn-49\n');
      expect(result).toContain('turn-50');
      expect(result).toContain('turn-249');
    });

    it('truncates a single turn longer than 8000 chars to 8000 chars of body', () => {
      const result = compactMessages([{ role: 'user', content: 'a'.repeat(10000) }]);
      // body is "## user\n" (8 chars) + the truncated content
      const body = result.slice('## user\n'.length);
      expect(body.length).toBe(8000);
      expect(result.length).toBeLessThan(10000);
    });
  });

  it('REQ-MEM-015 AC1: memory-vault.ts uses flock for global graph merge', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('flock');
    expect(mv?.content).toContain('graphify-global.lock');
    expect(mv?.content).toContain('user_vault');
  });

  // parseSessionMessages reads Pi's durable on-disk session JSONL (the file Pi persists for
  // /resume) into the message objects compactMessages expects. This is the source that replaces
  // the volatile in-memory buffer that produced empty captures after a reload.
  describe('REQ-MEM-015: parseSessionMessages durable transcript source', () => {
    it('extracts message-entry payloads and drops session header / compaction / custom entries', () => {
      const jsonl = [
        JSON.stringify({ type: 'session', id: 'abc', cwd: '/x', timestamp: 't' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'real-user-turn' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'real-assistant-turn' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'tool_result', content: 'noise' }] } }),
        JSON.stringify({ type: 'compaction', summary: 'compaction-should-be-dropped' }),
        JSON.stringify({ type: 'custom', customType: 'x', data: {} }),
      ].join('\n');
      const messages = parseSessionMessages(jsonl);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
      // round-trips through compactMessages: user + assistant text kept, toolResult role dropped
      const transcript = compactMessages(messages);
      expect(transcript).toContain('real-user-turn');
      expect(transcript).toContain('real-assistant-turn');
      expect(transcript).not.toContain('noise');
      expect(transcript).not.toContain('compaction-should-be-dropped');
    });

    it('skips malformed lines and blank lines without throwing, returns [] for empty input', () => {
      expect(parseSessionMessages('')).toEqual([]);
      expect(parseSessionMessages('\n  \n')).toEqual([]);
      const jsonl = [
        '{ this is not json',
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'kept' } }),
        '',
      ].join('\n');
      const messages = parseSessionMessages(jsonl);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('kept');
    });
  });

  it('REQ-MEM-001: memory-vault.ts capture reads the durable on-disk session, not volatile state', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    // Durable source: capture pulls the transcript from the persisted session file Pi writes for /resume.
    expect(mv?.content).toContain('getSessionFile');
    expect(mv?.content).toContain('parseSessionMessagesHelper');
    expect(mv?.content).toContain('readSessionMessages');
    expect(mv?.content).toContain('realUserPromptCount');
    expect(mv?.content).toContain('withCurrentPrompt');
    // Skip-empty guard: a blank transcript must never produce a hollow "no substantive content" note.
    // The guard now lives in captureVars (`if (!transcript.trim()) return undefined;`); assert it
    // without pinning the return value so a later refactor of the bail value does not rebreak this.
    expect(mv?.content).toContain('if (!transcript.trim()) return');
  });

  it('REQ-VAULT-003 / REQ-VAULT-026: Pi vault indexing shares Claude content-hash detection + exclusions', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    // Shared ephemeral dedup marker (advancing it keeps the entrypoint daemon quiet).
    expect(mv?.content).toContain('vault-extract.last');
    expect(mv?.content).not.toContain('pi-vault-extract.last');
    // REQ-VAULT-026: change detection is the content-hash manifest, NOT mtimes —
    // the bundled fs layer must be wired in so a restored vault is not re-extracted.
    expect(mv?.content).toContain('vault-extract-manifest.json');
    expect(mv?.content).toContain('changedVaultFilesIn');
    expect(mv?.content).toContain('commitVaultManifestTo');
    // Shared exclusion set (bundled from memory-vault-helpers).
    expect(mv?.content).toContain('Raw/Sessions');
    expect(mv?.content).toContain('graphify-out');
    expect(mv?.content).toContain('.silverbullet');
    expect(mv?.content).toContain('Index.md');
    expect(mv?.content).toContain('README.md');
    expect(mv?.content).toContain('CONFIG.md');
    expect(mv?.content).toContain('STYLES.md');
  });

  it('REQ-MEM-001/REQ-VAULT-003: memory-vault handlers are inert inside subagent child sessions', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    // pi-subagents children always load the parent's extensions; without the guard,
    // the sendUserMessage("Agent(...)") fallback lands in a monitor child's transcript
    // and becomes that task's visible output. Every lifecycle handler must bail on
    // child sessions before doing any capture/extract/merge work.
    const guardCalls = mv?.content.match(/if \(isChildSession\(ctx\)\) return;/g) ?? [];
    expect(guardCalls.length).toBeGreaterThanOrEqual(3); // session_start, before_agent_start, agent_end
    // The detection prongs come from the pure helpers (Workers-pool testable).
    expect(mv?.content).toContain('isChildSessionHeader');
    expect(mv?.content).toContain('isChildSessionFirstLine');
  });

  it('REQ-MEM-002 AC3/AC4: shouldCapture matches Claude delta threshold semantics', () => {
    expect(MEMORY_EVERY_N_PROMPTS).toBe(15);
    expect(shouldCapture(14)).toBe(false);
    expect(shouldCapture(15)).toBe(true);
    expect(shouldCapture(16)).toBe(true);
    expect(shouldCapture(30)).toBe(true);
    expect(shouldCapture(0)).toBe(false);
  });

  it('REQ-MEM-002 AC2: isFirstMessage detects brand-new session (no counter, count=1)', () => {
    expect(isFirstMessage(false, 1)).toBe(true);
    expect(isFirstMessage(true, 1)).toBe(false);
    expect(isFirstMessage(false, 5)).toBe(false);
  });

  it('REQ-MEM-002 AC7: isResumedSession detects resumed session (no counter, count>1)', () => {
    expect(isResumedSession(false, 5)).toBe(true);
    expect(isResumedSession(false, 1)).toBe(false);
    expect(isResumedSession(true, 5)).toBe(false);
  });

  it('REQ-MEM-002: capture threshold counts only real user prompts', () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({ role: 'user', content: `prompt ${index}` }))
      .concat([
        { role: 'user', content: '<task-notification>synthetic</task-notification>' },
        { role: 'assistant', content: 'ok' },
      ]);

    const beforeThreshold = withCurrentPrompt(messages, '<task-notification>ignored</task-notification>');
    expect(realUserPromptCount(beforeThreshold)).toBe(14);
    expect(shouldCapture(realUserPromptCount(beforeThreshold))).toBe(false);

    const atThreshold = withCurrentPrompt(messages, 'prompt 14');
    expect(realUserPromptCount(atThreshold)).toBe(MEMORY_EVERY_N_PROMPTS);
    expect(shouldCapture(realUserPromptCount(atThreshold))).toBe(true);
    expect(MEMORY_CAPTURE_PENDING_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('REQ-MEM-002 AC6: Pi capture counter advances only after a capture note exists', () => {
    const prompt = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/prompts/memory-agent-prompt.md');
    const captureStep = prompt?.content.slice(prompt.content.indexOf('### 1.'), prompt.content.indexOf('### 2.')) ?? '';
    const noteExists = prompt?.content.indexOf('After the markdown capture file exists') ?? -1;
    const counterWrite = prompt?.content.indexOf('printf \'%s\' "<promptCount>" > "<counterFile>"') ?? -1;
    const varsDelete = prompt?.content.indexOf('rm -f "<VARS_FILE>"', counterWrite) ?? -1;

    expect(captureStep).not.toContain('rm -f "<VARS_FILE>"');
    expect(noteExists).toBeGreaterThan(0);
    expect(counterWrite).toBeGreaterThan(noteExists);
    expect(varsDelete).toBeGreaterThan(counterWrite);
  });

  it('REQ-MEM-014: Pi memory-capture is configured as a background subagent', () => {
    const agent = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/agents/memory-capture.md');
    expect(agent?.modes).toEqual(['advanced']);
    const frontmatter = Object.fromEntries(
      (agent?.content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
        .split('\n')
        .map((line) => line.split(/:\s*/, 2))
        .filter((parts) => parts.length === 2),
    );
    expect(frontmatter.run_in_background).toBe('true');
  });

  it('REQ-VAULT-003: Pi vars/in-flight sentinels are namespaced so the Claude vault-monitor daemon cannot wedge Pi', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    // The entrypoint vault-monitor daemon (Claude's producer) writes the
    // shared-namespace ~/.cache/codeflare-hooks/vault-extract.vars on any vault
    // change; under Pi nothing consumes it. Pi MUST read its OWN sentinels so
    // the daemon's orphaned file never makes vaultVarsPending() block forever.
    expect(mv?.content).toContain('vault-extract.pi.vars');
    expect(mv?.content).toContain('vault-extract.pi.in-flight');
    expect(mv?.content).toContain('VAULT_INFLIGHT');
    expect(mv?.content).toContain('VAULT_EXTRACT_INFLIGHT_TTL_MS');
    // Regression guard: Pi must NOT read the daemon's shared-namespace files.
    expect(mv?.content).not.toContain('"vault-extract.vars"');
    expect(mv?.content).not.toContain('"vault-extract.in-flight"');
    // The high-water marker stays SHARED (advancing it keeps the daemon quiet).
    expect(mv?.content).toContain('vault-extract.last');
    // Self-heal: a stale vars file past the in-flight TTL must clear, not wedge.
    expect(mv?.content).toContain('Date.now() - statSync(VAULT_VARS_FILE).mtimeMs > VAULT_EXTRACT_INFLIGHT_TTL_MS');
  });

  it('REQ-VAULT-004: memory-vault.ts publishes the cumulative vault graph to the global graph via flock-guarded graphify global add', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    // Serialised under the shared global-graph lock, tagged user_vault.
    expect(mv?.content).toContain('/tmp/graphify-global.lock');
    expect(mv?.content).toContain('user_vault');
    // The extension re-publishes the cumulative vault-graph.json (written by
    // merge-vault-graph.py), never a competing per-run graph.json.
    expect(mv?.content).toContain('vault-graph.json');
    // It is a pure trigger now: no in-process deterministic graph builder.
    expect(mv?.content).not.toContain('deterministicVaultGraph');
  });

  it('REQ-VAULT-003 AC7: Pi vault-extract prompt publishes the viz to Raw/Graphs', () => {
    const prompt = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/prompts/vault-extract-prompt.md');
    expect(prompt?.content).toContain('graphify cluster-only .');
    expect(prompt?.content).toContain('Raw/Graphs/vault-graph.html');
  });

  it('REQ-VAULT-016 / REQ-MEM-009: Pi vault-extract + memory prompts build the cumulative vault graph via the Pi-local merge-vault-graph.py', () => {
    const vault = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/prompts/vault-extract-prompt.md');
    const memory = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/prompts/memory-agent-prompt.md');
    for (const prompt of [vault, memory]) {
      // Self-contained in .pi: Pi must never reach into the Claude plugin tree.
      expect(prompt?.content).toContain('/home/user/.pi/agent/scripts/merge-vault-graph.py');
      expect(prompt?.content).not.toContain('.claude/plugins/codeflare-vault/scripts/merge-vault-graph.py');
      // Publish the CUMULATIVE vault-graph.json, never the per-run chunk/graph.json (REQ-MEM-009 AC3).
      expect(prompt?.content).toMatch(/graphify global add[\s\S]{0,160}vault-graph\.json[\s\S]{0,160}--as user_vault/);
    }
  });

  it('REQ-VAULT-007: Pi is self-contained - merge-vault-graph.py is preseeded into .pi/agent/scripts', () => {
    const piScript = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/scripts/merge-vault-graph.py');
    expect(piScript, 'merge-vault-graph.py must be preseeded for Pi').toBeTruthy();
    expect(piScript?.content).toContain('REQ-MEM-009');
    expect(piScript?.content).toContain('nx.compose');
  });

  it('REQ-AGENT-023 AC4: codeflare-pi.ts tolerates missing graph and reports present graph', () => {
    const cp = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/codeflare-pi.ts');
    expect(cp?.content).toContain('graphSummary');
    expect(cp?.content).toContain('Graphify repo graph available');
    expect(cp?.content).toContain('graphify-out');
    expect(cp?.content).toContain('fallbackGraphifyToolResult');
    expect(cp?.content).toContain('/home/user/workspace/graphify-out');
    expect(cp?.content).toContain('--graph');
  });

  it('REQ-AGENT-023 / REQ-AGENT-043: Pi graphify scripts split initial build from refresh and keep memory caps', () => {
    const updateScript = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/scripts/safe-graphify-update.sh');
    expect(updateScript?.content).toContain('ulimit -v');
    expect(updateScript?.content).toContain('GRAPHIFY_SAFE_RLIMIT_KB');
    expect(updateScript?.content).toContain('graphify update');
    expect(updateScript?.content).toContain('thin safety wrapper around upstream');

    const buildScript = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/scripts/build-graphify-ast.sh');
    expect(buildScript?.content).toContain('Graphify primitives only');
    expect(buildScript?.content).toContain('from graphify.detect import detect');
    expect(buildScript?.content).toContain('from graphify.build import build');
    expect(buildScript?.content).not.toContain('normalize_import_targets');
    expect(buildScript?.content).toContain('GRAPHIFY_VIZ_NODE_LIMIT');

    const architectureScript = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/scripts/build-graphify-architecture.sh');
    expect(architectureScript?.content).toContain('architecture-focused module graph build');
    expect(architectureScript?.content).toContain('GRAPHIFY_ARCH_KEEP_ISOLATES');
    expect(architectureScript?.content).toContain("'.graphify_scope'");
  });

  it('REQ-AGENT-049 AC1: PRESEED_CONTENT_HASH is a deterministic 16-char hex string', () => {
    expect(PRESEED_CONTENT_HASH).toMatch(/^[0-9a-f]{16}$/);
    const { createHash } = require('node:crypto');
    const sorted = [...AGENTS_SEEDED_CONFIGS].sort((a, b) => a.key.localeCompare(b.key));
    const recomputed = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
    expect(PRESEED_CONTENT_HASH).toBe(recomputed);
  });
});

describe('REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors) / REQ-AGENT-072', () => {
  function consultLlmSkill(key: string): string {
    const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === key);
    expect(doc, `${key} must be bundled in the seed`).toBeTruthy();
    return doc!.content;
  }

  // REQ-AGENT-067 AC2: when no model is named, the skill drives a single-select
  // dialog of four explicit choices (+ the tool's automatic "Other" write-in = five):
  // latest Gemini, latest OpenAI, both, and "list all available".
  it('AC5: Claude skill mandates an AskUserQuestion model dialog with the five choices', () => {
    const body = consultLlmSkill('.claude/skills/consult-llm/SKILL.md');
    expect(body).toContain('AskUserQuestion');
    expect(body).toMatch(/five/i);
    expect(body).toMatch(/Latest Google|Gemini/);
    expect(body).toMatch(/Latest OpenAI|GPT/);
    expect(body).toMatch(/\bboth\b/i);
    expect(body).toMatch(/list all available/i);
    expect(body).toMatch(/\bother\b/i);
  });

  // REQ-AGENT-067 AC4: "latest" is resolved by server-side selectors, never a
  // hardcoded model ID or live provider model-list fetch.
  it('AC5: both skills use the openai/gemini selectors and never curl a provider model list', () => {
    for (const key of ['.claude/skills/consult-llm/SKILL.md', '.pi/agent/skills/consult-llm/SKILL.md']) {
      const body = consultLlmSkill(key);
      expect(body, key).toContain('"openai"');
      expect(body, key).toContain('"gemini"');
      // Regression: the old skill curled the provider catalogs with the raw API key.
      expect(body, key).not.toContain('/v1/models');
      expect(body, key).not.toContain('/v1beta/models');
      expect(body, key).not.toContain('Authorization: Bearer');
      // Dialog is skipped when the user already named a model.
      expect(body.toLowerCase(), key).toContain('named a specific model');
    }
  });

  // REQ-AGENT-067 AC3 regression (consult-llm "List models" bug): the old skill told the agent to
  // "read the supported set from the consult_llm tool's model parameter" — but that
  // parameter only documents provider SELECTORS (gemini/openai/...), so the agent
  // presented selectors as "all available models". The fix reads concrete IDs from the
  // server startup log, scopes to Gemini + OpenAI, and never labels selectors as models.
  it('AC5: "list all" reads concrete model IDs from the server log, never presents selectors as models', () => {
    for (const key of ['.claude/skills/consult-llm/SKILL.md', '.pi/agent/skills/consult-llm/SKILL.md']) {
      const body = consultLlmSkill(key);
      // The broken instruction is gone.
      expect(body, key).not.toMatch(/read the supported set from the .?consult_llm.? tool's .?model.? parameter/i);
      // The authoritative concrete-ID source is the server startup log.
      expect(body, key).toContain('AVAILABLE MODELS');
      expect(body, key).toContain('mcp.log');
      // Selectors must never be presented as the model list.
      expect(body.toLowerCase(), key).toContain('never present that selector list');
      // Scoped to Gemini + OpenAI; the other provider families are excluded, not surfaced.
      expect(body, key).toMatch(/gemini-\*/);
      expect(body, key).toMatch(/gpt-\*/);
      expect(body.toLowerCase(), key).toContain('ignore any');
    }
  });

  it('REQ-AGENT-067 AC1/AC4: consult-llm skills keep explicit gate and Pi dialog contract', () => {
    const consultSkillKeys = AGENTS_SEEDED_CONFIGS
      .map((doc) => doc.key)
      .filter((key) => key.endsWith('/skills/consult-llm/SKILL.md'))
      .sort();
    expect(consultSkillKeys).toEqual([
      '.claude/skills/consult-llm/SKILL.md',
      '.pi/agent/skills/consult-llm/SKILL.md',
    ]);
    for (const key of consultSkillKeys) {
      const doc = AGENTS_SEEDED_CONFIGS.find((entry) => entry.key === key);
      expect([...(doc?.modes ?? [])].sort(), key).toEqual(['advanced', 'default']);
      expect(frontmatter(doc?.content ?? '').name).toBe('consult-llm');
      expect(markdownHeadings(doc?.content ?? '')).toEqual(expect.arrayContaining([
        'Hard gate — explicit user request only',
        'Step 1 — Choose the model',
        'Step 2 — Build the prompt and call',
      ]));
      const hardGate = markdownSection(doc?.content ?? '', 'Hard gate — explicit user request only');
      expect(hardGate).toContain('explicitly asks to consult external LLMs');
      expect(hardGate).toContain('Do not call `consult_llm`');
      expect(hardGate).toContain('session start');
      expect(hardGate).toContain('CI fixes');
    }

    const piSkill = AGENTS_SEEDED_CONFIGS.find((entry) => entry.key === '.pi/agent/skills/consult-llm/SKILL.md');
    expect(markdownHeadings(piSkill?.content ?? '')).toContain('Step 1 — Choose the model');
    expect(piSkill?.content.match(/`ask_user_question`/g)).toHaveLength(1);
    expect(piSkill?.content).not.toContain('AskUserQuestion');
  });
});

describe('REQ-AGENT-027 AC1 context-mode wired as a tool only (no Bash deny-gate)', () => {
  it('context-mode ships as a plugin/tool with no hooks config and no deny-gate script', () => {
    const ctxKeys = AGENTS_SEEDED_CONFIGS.map((d) => d.key).filter((k) => k.includes('context-mode'));
    expect(ctxKeys.some((k) => k.endsWith('.claude-plugin/plugin.json'))).toBe(true);
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(doc.key.endsWith('enforce-ctx-mode.sh'), `${doc.key} must not preseed the deny-gate script`).toBe(false);
      expect(
        doc.key.endsWith('context-mode/hooks/hooks.json'),
        `${doc.key} must not preseed a context-mode hooks config`
      ).toBe(false);
    }
  });
});

// Behavioral tests for the Pi-native extension logic: each imports a pi-package-free helper
// (guard-helpers, commands-helpers, memory-vault-helpers) and executes the real logic that the
// side-effectful extension modules compose - not source-string matching. The extension modules
// themselves import the Pi package / node:child_process and cannot load in the Workers test
// pool, so the executable logic lives in these helpers. Command registration (AC1) is the one
// exception: it is wiring inside codeflare-commands.ts, which cannot be loaded here, so it is
// asserted against the shipped extension content.

describe('Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)', () => {
  it('AC1: the extension registers exactly the debug, deploy, and brainstorm commands', () => {
    const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/codeflare-commands.ts');
    expect(doc, 'codeflare-commands.ts must be seeded').toBeTruthy();
    const registered = [...doc!.content.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(registered).toEqual(['brainstorm', 'debug', 'deploy']);
  });

  it('AC2: commandInstructions assembles the dispatched message as slash + workflow + user input', () => {
    const out = commandInstructions('/debug', DEBUG_WORKFLOW, 'my failing test');
    expect(out.startsWith('/debug\n')).toBe(true);
    expect(out).toContain(DEBUG_WORKFLOW);
    expect(out.endsWith('User input: my failing test')).toBe(true);
  });

  it('AC3: the assembled /debug instruction is root-cause-first and carries the 3-Fix Rule', () => {
    const out = commandInstructions('/debug', DEBUG_WORKFLOW, 'x');
    expect(out).toMatch(/Root Cause Investigation/i);
    expect(out).toMatch(/No fixes before root-cause/i);
    expect(out).toContain('3-Fix Rule');
  });

  it('AC4: /deploy defaults to integration and the assembled instruction runs push/stale-CI/monitor/deploy/verify', () => {
    expect(deployTarget('')).toBe('integration');
    expect(deployTarget('production')).toBe('production');
    const out = commandInstructions('/deploy', DEPLOY_WORKFLOW, deployTarget(''));
    expect(out).toContain('User input: integration');
    expect(out).toMatch(/Cancel stale CI/i);
    expect(out).toMatch(/Monitor CI/i);
    expect(out).toMatch(/git push/);
    expect(out).toMatch(/wrangler deploy/);
    expect(out).toMatch(/Verify the live URL/i);
  });

  it('AC5: the assembled /brainstorm instruction generates options with trade-offs and a recommendation', () => {
    const out = commandInstructions('/brainstorm', BRAINSTORM_WORKFLOW, 'an idea');
    expect(out).toMatch(/Generate options/i);
    expect(out).toMatch(/Trade-off/i);
    expect(out).toMatch(/Recommendation/i);
  });

  it('AC6: codeflare-commands.ts is delivered advanced-only through the seed pipeline (manifest mode-gate)', () => {
    // The mode-gate is the contract value: the generated seed must carry the
    // manifest's advanced-only gate for this extension, so Standard mode and
    // token-less deploys never receive it. Asserting the resolved modes (not
    // the manifest source text) proves the gate survived generation.
    const entries = AGENTS_SEEDED_CONFIGS.filter(
      (d) => d.key === '.pi/agent/extensions/codeflare-commands.ts',
    );
    expect(entries.length, 'codeflare-commands.ts must be seeded exactly once').toBe(1);
    const modes = [...entries[0].modes].sort();
    expect(modes).toEqual(['advanced']);
    expect(modes).not.toContain('default');
    // It must NOT leak into the default-mode key set (the gate's whole point).
    const defaultKeys = new Set(
      AGENTS_SEEDED_CONFIGS.filter((d) => d.modes.includes('default')).map((d) => d.key),
    );
    expect(defaultKeys.has('.pi/agent/extensions/codeflare-commands.ts')).toBe(false);
  });
});

describe('native /sdd hard gates / REQ-AGENT-021 AC5 (the native /sdd command enforces command-file hard gates before workflow dispatch)', () => {
  // sddCommandDecision is the pure gate logic codeflare-pi.ts dispatches on
  // (sddRepoState -> sddCommandDecision). It takes no runtime, so it runs in
  // the Workers pool. These assert the gate DECISIONS (kind + which path is
  // refused), not prose. If any gate were removed the matching case flips to
  // kind: "workflow" and the assertion fails.
  const clean: SddRepoState = { dirty: false, hasSdd: true, hasOpenInitTriage: false };

  it('bare /sdd returns help, never a workflow dispatch', () => {
    const d = sddCommandDecision('', clean);
    expect(d.kind).toBe('help');
  });

  it('an unknown subcommand returns help, not a workflow dispatch', () => {
    const d = sddCommandDecision('frobnicate', clean);
    expect(d.kind).toBe('help');
  });

  it('GATE: a dirty working tree is refused for every subcommand before dispatch', () => {
    const dirty: SddRepoState = { dirty: true, hasSdd: true, hasOpenInitTriage: true };
    for (const sub of ['init', 'edit', 'add', 'clean', 'mode']) {
      const d = sddCommandDecision(sub, dirty);
      expect(d.kind, `${sub} on a dirty tree must be refused`).toBe('error');
    }
  });

  it('GATE: /sdd clean and /sdd mode are refused when no sdd/ folder exists', () => {
    const noSdd: SddRepoState = { dirty: false, hasSdd: false, hasOpenInitTriage: false };
    expect(sddCommandDecision('clean', noSdd).kind).toBe('error');
    expect(sddCommandDecision('mode', noSdd).kind).toBe('error');
  });

  it('GATE: /sdd init is refused once sdd/ exists with no open init triage', () => {
    const initialized: SddRepoState = { dirty: false, hasSdd: true, hasOpenInitTriage: false };
    expect(sddCommandDecision('init', initialized).kind).toBe('error');
  });

  it('/sdd init is ALLOWED to resume when sdd/ exists but open init triage remains', () => {
    const resuming: SddRepoState = { dirty: false, hasSdd: true, hasOpenInitTriage: true };
    const d = sddCommandDecision('init', resuming);
    expect(d.kind).toBe('workflow');
    if (d.kind === 'workflow') {
      expect(d.subcommand).toBe('init');
      expect(d.skill).toBe('sdd-init');
    }
  });

  it('passes a clean, initialized repo through to the right skill per subcommand', () => {
    const cases: Array<[string, string, string]> = [
      ['edit storage', 'edit', 'spec-driven-development'],
      ['add billing', 'add', 'spec-driven-development'],
      ['clean --scope=all', 'clean', 'sdd-clean'],
      ['mode unleashed', 'mode', 'spec-driven-development'],
    ];
    for (const [args, sub, skill] of cases) {
      const d = sddCommandDecision(args, clean);
      expect(d.kind, `${args} should dispatch`).toBe('workflow');
      if (d.kind === 'workflow') {
        expect(d.subcommand).toBe(sub);
        expect(d.skill).toBe(skill);
        expect(d.normalizedCommand).toBe(`/sdd ${args}`);
      }
    }
  });
});

describe('Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)', () => {
  // guard-helpers holds the executable guard logic that codeflare-pi.ts composes; it has no
  // node:child_process dependency, so it runs in the Workers test pool (codeflare-pi.ts cannot).
  it('AC1: attribution fires across git commit/merge/tag/notes and gh pr/issue/release', () => {
    const trailer = '\n\nCo-Authored-By: Bot <bot@example.com>';
    for (const base of ['git commit -m "x"', 'git merge feature', 'git tag v1 -m "x"', 'git notes add -m "x"', 'gh pr create --body "x"', 'gh issue create --body "x"', 'gh release create v1 --notes "x"']) {
      expect(attributionBlockReason(`${base}${trailer}`), base).toBeTruthy();
    }
  });

  it('AC2: matches the six attribution signatures including the Pi superset (brain emoji + ChatGPT)', () => {
    for (const sig of ['Co-Authored-By: x <x@y>', 'noreply@anthropic.com', 'Generated with Claude Code', '🤖 generated', '🧠 thought', 'made by ChatGPT']) {
      expect(attributionBlockReason(`git commit -m "msg ${sig}"`), sig).toBeTruthy();
    }
  });

  it('AC3: bare Claude product names and preseed/agents/claude paths are not false positives', () => {
    expect(attributionBlockReason('git add preseed/agents/claude/skills/review/SKILL.md')).toBeUndefined();
    expect(attributionBlockReason('git commit -m "Claude Code parity for Pi"')).toBeUndefined();
  });

  it('AC4: detects the package-manager verbs plus the standalone tool set, and allows the rest', () => {
    for (const cmd of ['npm run build', 'pnpm test', 'yarn lint', 'bun run typecheck', 'npm run dev', 'pytest -q', 'vitest run', 'go test ./...', 'cargo test', 'tsc -p .', 'eslint .', 'oxlint', 'prettier -w .', 'wrangler dev']) {
      expect(isLocalBuildCommand(cmd), cmd).toBe(true);
    }
    expect(isLocalBuildCommand('git status')).toBe(false);
    expect(isLocalBuildCommand('npm run deploy')).toBe(false);
  });

  it('AC5: the /tmp/local-build-bypass sentinel is consumed once, then the guard re-blocks', () => {
    let present = true;
    const fs = { existsSync: () => present, unlinkSync: () => { present = false; } };
    expect(localBuildBlockReason('npm run build', fs)).toBeUndefined();  // sentinel present -> consumed, allowed
    expect(present).toBe(false);                                          // consume-on-use deleted it
    expect(localBuildBlockReason('npm run build', fs)).toMatch(/create \/tmp\/local-build-bypass/);  // re-blocks once gone
  });

  it('AC5: a non-build command is never blocked regardless of the sentinel', () => {
    const fs = { existsSync: () => false, unlinkSync: () => { throw new Error('should not be called'); } };
    expect(localBuildBlockReason('git status', fs)).toBeUndefined();
  });

});

describe('Reviewer agents can access their enforce policy', () => {
  // Claude invokes enforce skills through its Skill tool. Pi has no equivalent tool;
  // its generated reviewer system prompts embed the canonical policy documents.
  const CLAUDE_REVIEWERS = ['spec-reviewer', 'doc-updater', 'code-reviewer', 'tdd-guide'];

  it('every Claude reviewer/guide agent grants the Skill tool so its enforce skill is invocable', () => {
    for (const name of CLAUDE_REVIEWERS) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc, `.claude/agents/${name}.md should be seeded`).toBeTruthy();
      const toolsLine = doc!.content.match(/^tools:.*$/m)?.[0] ?? '';
      expect(toolsLine, `${name} must list the Skill tool`).toContain('"Skill"');
    }
  });

  it('transformed runtimes never inherit the Claude-only Skill tool', () => {
    const piCr = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/agents/code-reviewer.md');
    expect(piCr).toBeTruthy();
    const piFrontmatter = frontmatter(piCr!.content);
    expect(piFrontmatter.tools.split(/,\s*/)).not.toContain('Skill');
    expect(piFrontmatter).not.toHaveProperty('skills');
    const gemCr = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.gemini/agents/code-reviewer.md');
    expect(gemCr, '.gemini/agents/code-reviewer.md should be seeded').toBeTruthy();
    const gemTools = gemCr!.content.match(/^tools:.*$/m)?.[0] ?? '';
    expect(gemTools).not.toContain('Skill');
  });
});

describe('Pi memory model-fidelity lever / REQ-MEM-014 AC5/AC6 (buildSpawnOptions applies the model only when set; no hardcoded model)', () => {
  it('applies the model option only when a model argument is provided', () => {
    expect(buildSpawnOptions('Capture session memory', 'higher-fidelity-model').model).toBe('higher-fidelity-model');
    expect('model' in buildSpawnOptions('Capture session memory', undefined)).toBe(false);
  });

  it('passes no model when CODEFLARE_MEMORY_MODEL is unset (no hardcoded default)', () => {
    const saved = process.env.CODEFLARE_MEMORY_MODEL;
    delete process.env.CODEFLARE_MEMORY_MODEL;
    try {
      expect('model' in buildSpawnOptions('Extract Vault graph changes', process.env.CODEFLARE_MEMORY_MODEL)).toBe(false);
    } finally {
      if (saved !== undefined) process.env.CODEFLARE_MEMORY_MODEL = saved;
    }
  });

  it('always carries the description, inheritContext:false, and background service options', () => {
    const opts = buildSpawnOptions('Capture resumed session memory', 'm');
    expect(opts.description).toBe('Capture resumed session memory');
    expect(opts.inheritContext).toBe(false);
    expect(opts.foreground).toBe(false);
  });
});
