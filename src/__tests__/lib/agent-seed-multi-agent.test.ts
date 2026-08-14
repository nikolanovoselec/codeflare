import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';
import { cloneTargetPath, graphifyCloneAction, graphifyClonePromptDecision, graphifyPromptMarker, isFailedToolExecution as isFailedGraphifyToolExecution, renderGraphifyCloneDirective } from '../../../preseed/agents/pi/extensions/graphify-helpers';
import { handleContextModeCommand, restoreActiveRepoFromPersistedFiles, shouldHandleClonePrompt, type PiSettings } from '../../../preseed/agents/pi/extensions/codeflare-pi';
import { CONTEXT_MODE_DISABLED_PACKAGE, CONTEXT_MODE_ENABLED_PACKAGE, attachConfiguredContextMode, attachContextModeToForeground, clearInheritedContextModeBridgeIdleOverride } from '../../../preseed/agents/pi/extensions/context-mode-runtime';

/**
 * Validates invariants of the generated agent seed configs.
 *
 * The generator script (generate-agent-seed.mjs) reads manifest.json and the
 * preseed file tree at build time, validates bidirectional consistency, and
 * embeds the result into AGENTS_SEEDED_CONFIGS. These tests verify the
 * generated output's runtime invariants without filesystem access (which
 * isn't available in the Workers vitest pool).
 */

function claudeDocs() {
  return AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key.startsWith('.claude/'));
}

function markdownHeadings(content: string): string[] {
  return [...content.matchAll(/^##+\s+(.+)$/gm)].map((match) => match[1]);
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

describe('multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)', () => {
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

  it('REQ-AGENT-139 AC7: optimized documentation templates reach Claude and Pi seeds', () => {
    const relativePaths = [
      'skills/sdd-init/references/render-documentation-templates.mjs',
      'skills/spec-driven-development/references/templates/documentation-security.md',
      'skills/spec-driven-development/references/templates/documentation-observability.md',
      'skills/spec-driven-development/references/templates/documentation-troubleshooting.md',
      'skills/spec-driven-development/references/templates/documentation-project-lane.md',
    ];

    for (const relativePath of relativePaths) {
      const claude = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === `.claude/${relativePath}`);
      const pi = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === `.pi/agent/${relativePath}`);
      expect(claude?.modes).toEqual(['advanced']);
      expect(pi?.modes).toEqual(['advanced']);
      expect(pi?.content).toBe(claude?.content);
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

  it('REQ-AGENT-085 AC1/AC2: generated reviewers expose only direct Bash evidence execution', () => {
    const reviewerTools = Object.fromEntries(
      ['code-reviewer', 'spec-reviewer', 'doc-updater'].map((reviewer) => {
        const document = AGENTS_SEEDED_CONFIGS.find(
          (entry) => entry.key === `.pi/agent/agents/${reviewer}.md`,
        );
        return [reviewer, frontmatter(document?.content ?? '').tools.split(/,\s*/)];
      }),
    );

    for (const tools of Object.values(reviewerTools)) {
      expect(tools).toEqual(['bash']);
      expect(tools).not.toContain('ctx_execute');
      expect(tools).not.toContain('ctx_batch_execute');
    }
  });

  it('REQ-AGENT-087: generated reviewers use provider-neutral medium thinking', () => {
    for (const reviewer of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const document = AGENTS_SEEDED_CONFIGS.find(
        (entry) => entry.key === `.pi/agent/agents/${reviewer}.md`,
      );
      expect(frontmatter(document?.content ?? '').thinking).toBe('medium');
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

  it('preseeds runtime-appropriate continuity, push, and result handoff gates', () => {
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
        // The engineering constitution (source of the gate sections) ships
        // advanced-only (manifest.json), so default-mode docs carry no gates;
        // Pi's compact context merges them into one 'Review and CI gates'
        // section present in both modes (REQ-AGENT-095/097).
        const requiredHeadings = key === '.pi/agent/AGENTS.md'
          ? ['Work continuity', 'Review and CI gates']
          : entry.modes.includes('advanced')
            ? ['Work continuity', 'Review push gate', 'Review-result handoff gate', 'CI-result handoff gate']
            : [];
        if (requiredHeadings.length === 0) continue;
        expect(markdownHeadings(entry.content), `${key} ${entry.modes.join(',')} includes gate sections`)
          .toEqual(expect.arrayContaining(requiredHeadings));
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

  it('REQ-AGENT-101: transformed reviewers get a retrieval pointer, never a dangling embed claim', () => {
    // The strip removes policy the transformed runtimes do not carry. If it
    // removed the payload but left the prose, the prompt would promise embedded
    // policy, deliver none, and forbid retrieving it -- worse than either
    // choice. Assert the pointer resolves to that runtime's real skills path
    // and that no raw directive survives anywhere in the seed.
    const gem = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.gemini/agents/doc-updater.md');
    expect(gem).toBeTruthy();
    expect(gem!.content).toContain('cat ~/.gemini/skills/<name>/SKILL.md');
    expect(gem!.content).not.toContain('@include-skill');
    expect(gem!.content).not.toContain('nothing further to retrieve');

    // copilot receives no skill files, so it must name no skills path at all.
    const cop = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.copilot/agents/doc-updater.agent.md');
    expect(cop).toBeTruthy();
    expect(cop!.content).not.toContain('SKILL.md');
    expect(cop!.content).not.toContain('@include-skill');

    expect(AGENTS_SEEDED_CONFIGS.filter((d) => d.content.includes('@include-skill'))).toHaveLength(0);
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
    // Derive the expectation from the Claude source rather than pinning a
    // literal list: the mapping is the contract, so this keeps holding when the
    // Claude toolset changes and still fails if the transform stops mapping.
    const GEMINI_TOOL_MAP: Record<string, string> = {
      Read: 'read_file',
      Write: 'write_file',
      Edit: 'replace',
      Bash: 'run_shell_command',
      Grep: 'search_file_content',
      Glob: 'glob',
    };
    const claudeSource = AGENTS_SEEDED_CONFIGS.find(
      (d) => d.key === '.claude/agents/code-reviewer.md'
    );
    const claudeTools = JSON.parse(
      claudeSource!.content.match(/^tools:\s*(\[.*\])$/m)![1]
    ) as string[];
    const geminiTools = JSON.parse(
      codeReviewer!.content.match(/^tools:\s*(\[.*\])$/m)![1]
    ) as string[];
    expect(geminiTools).toEqual([
      ...new Set(
        claudeTools
          .filter((t) => t !== 'Skill' && !t.startsWith('mcp__'))
          .map((t) => GEMINI_TOOL_MAP[t] ?? t)
      ),
    ]);
    // Capability anchors, so a degenerate or empty mapping cannot pass the
    // differential above: the evidence transport must survive the transform,
    // and no Claude-side name may leak through unmapped.
    expect(geminiTools).toContain('run_shell_command');
    expect(geminiTools).not.toContain('Bash');
    expect(geminiTools).not.toContain('Skill');
    // mcp__ tool names are dropped from the frontmatter tools list (no Gemini equivalent).
    expect(geminiTools.filter((t) => t.startsWith('mcp__'))).toHaveLength(0);
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
      '.pi/agent/extensions/capability-helpers.ts',
      '.pi/agent/extensions/capability.ts',
      '.pi/agent/extensions/codeflare-commands.ts',
      '.pi/agent/extensions/codeflare-pi.ts',
      '.pi/agent/extensions/commands-helpers.ts',
      '.pi/agent/extensions/context-mode-runtime.ts',
      '.pi/agent/extensions/graphify-helpers.ts',
      '.pi/agent/extensions/graphify-native.ts',
      '.pi/agent/extensions/guard-helpers.ts',
      '.pi/agent/extensions/local-statusline.ts',
      '.pi/agent/extensions/memory-inject-helpers.ts',
      '.pi/agent/extensions/memory-inject.ts',
      '.pi/agent/extensions/memory-vault-helpers.ts',
      '.pi/agent/extensions/memory-vault.ts',
      '.pi/agent/extensions/native-notifications.ts',
      '.pi/agent/extensions/post-compaction-recall-helpers.ts',
      '.pi/agent/extensions/post-compaction-recall.ts',
      '.pi/agent/extensions/review-command.ts',
      '.pi/agent/extensions/review-enforcement.ts',
      '.pi/agent/extensions/review-helpers.ts',
      '.pi/agent/extensions/review-scope.ts',
      '.pi/agent/extensions/review-tool-guard.ts',
      '.pi/agent/extensions/sdd-helpers.ts',
      '.pi/agent/extensions/sidebar-approval.ts',
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
    expect(skills.map((d) => d.key)).toContain('.pi/agent/skills/review/scripts/resolve-project-root.mjs');
    for (const skill of ['spec-driven-development', 'sdd-init', 'sdd-clean']) {
      const doc = skills.find((d) => d.key === `.pi/agent/skills/${skill}/SKILL.md`);
      expect(doc, `REQ-AGENT-021 ${skill} skill`).toBeDefined();
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
    for (const skill of ['advisor', 'rpiv-ask-user-question', 'rpiv-todo', 'pi-web-access', 'pi-mcp-adapter', 'librarian']) {
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
    // REQ-AGENT-085: generated reviewers expose only direct Bash evidence
    // execution (the richer tool set predates the reviewer-economics change).
    expect(frontmatter(codeReviewer?.content ?? '')).toMatchObject({
      tools: 'bash',
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

  it('REQ-AGENT-115 AC3: librarian skill ships in both Pi modes', () => {
    const librarianSkill = AGENTS_SEEDED_CONFIGS.find(
      (doc) => doc.key === '.pi/agent/skills/librarian/SKILL.md',
    );
    expect(librarianSkill?.modes).toEqual(['default', 'advanced']);
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

  it('REQ-AGENT-076 AC7: Pi context-mode runtime extension clears an inherited bridge-idle override so context-mode governs per-session', () => {
    const prev = process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
    try {
      process.env.CONTEXT_MODE_BRIDGE_IDLE_MS = '0';
      clearInheritedContextModeBridgeIdleOverride();
      expect(process.env.CONTEXT_MODE_BRIDGE_IDLE_MS).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
      else process.env.CONTEXT_MODE_BRIDGE_IDLE_MS = prev;
    }
  });

  it('REQ-AGENT-076 AC2: /ctx reloads Pi into the selected state', async () => {
    let settings: PiSettings = { packages: ['npm:user-package@1.0.0'] };
    const store = {
      read: () => settings,
      write: (next: PiSettings) => { settings = next; },
    };
    let reloads = 0;
    const ctx = {
      sessionManager: { getCwd: () => '/repo' },
      ui: { notify() {} },
      waitForIdle: async () => {},
      reload: async () => { reloads += 1; },
    };

    let initialized = 0;
    const initialize = async () => { initialized += 1; };

    await handleContextModeCommand('off', ctx, store);
    expect(settings.packages).toContainEqual({ ...CONTEXT_MODE_DISABLED_PACKAGE, extensions: [], skills: [] });
    expect(settings.packages).toContain('npm:user-package@1.0.0');
    await expect(attachConfiguredContextMode(settings, {}, { on() {} }, initialize)).resolves.toBe(false);
    expect(initialized).toBe(0);

    await handleContextModeCommand('on', ctx, store);
    expect(settings.packages).toContainEqual({ ...CONTEXT_MODE_ENABLED_PACKAGE, extensions: [] });
    expect(settings.packages).toContain('npm:user-package@1.0.0');
    await expect(attachConfiguredContextMode(settings, {}, { on() {} }, initialize)).resolves.toBe(true);
    expect(initialized).toBe(1);
    expect(reloads).toBe(2);
  });

  it('REQ-AGENT-089 AC1: one process owner rejects child context-mode initialization', async () => {
    const ownerRegistry: { owner?: symbol } = {};
    const rootPi = { on() {} };
    const childPi = { on() {} };
    let attachCount = 0;
    const initialize = async () => { attachCount += 1; };

    await expect(attachContextModeToForeground(ownerRegistry, rootPi, initialize)).resolves.toBe(true);
    await expect(attachContextModeToForeground(ownerRegistry, childPi, initialize)).resolves.toBe(false);
    expect(attachCount).toBe(1);
  });

  it('REQ-AGENT-089 AC2: owner shutdown permits context-mode reattachment', async () => {
    const ownerRegistry: { owner?: symbol } = {};
    const shutdownHandlers: Array<() => void | Promise<void>> = [];
    const pi = {
      on(event: string, handler: () => void | Promise<void>) {
        if (event === 'session_shutdown') shutdownHandlers.push(handler);
      },
    };
    let attachCount = 0;
    const initialize = async () => { attachCount += 1; };

    await expect(attachContextModeToForeground(ownerRegistry, pi, initialize)).resolves.toBe(true);
    await shutdownHandlers[0]?.();
    await expect(attachContextModeToForeground(ownerRegistry, pi, initialize)).resolves.toBe(true);
    expect(attachCount).toBe(2);
  });

  it('Pi agents use Pi-native tool names without Claude MCP aliases', () => {
    const agents = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const toolsLine = (content: string) => content.match(/^tools:.*$/m)?.[0] ?? '';
    for (const agent of agents) {
      // the Claude->Pi remap is complete: Pi agent frontmatter and body carry Pi-native names,
      // so subagents never try unavailable Claude MCP tool names at runtime.
      expect(toolsLine(agent.content)).not.toContain('mcp__');
      expect(agent.content).not.toContain('mcp__graphify__');
      expect(agent.content).not.toContain('mcp__context-mode__');
    }
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

  // REQ-AGENT-031 AC5: consult-llm is scoped to Claude + Pi ONLY. Claude gets it
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
  // The hard-block companion was removed with AD124: nothing blocks tool calls
  // for capture any more. assert-iso-ts.sh stays, but its caller moved from the
  // agent prompt to memory-capture.sh, which arms the request with the
  // timestamp the helper resolves and asserts.
  it('codeflare-memory plugin files are advanced-only', () => {
    const pluginDocs = claudeDocs().filter((d) => d.key.includes('codeflare-memory'));
    const fileNames = pluginDocs.map((d) => d.key.split('/').pop()).sort();
    expect(fileNames).toEqual([
      'assert-iso-ts.sh',
      'build-memory-graph.py',
      'memory-agent-prompt.md',
      'memory-capture.sh',
      'memory-context-inject.sh',
      'plugin.json',
      'post-compaction-recall.sh',
      'prefilter-transcript.sh',
      'publish-memory-capture.sh',
      'run-memory-capture.sh',
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
