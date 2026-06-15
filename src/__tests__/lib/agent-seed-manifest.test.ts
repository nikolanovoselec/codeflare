import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { cloneTargetPath, graphifyCloneAction, graphifyClonePromptDecision, graphifyPromptMarker, isFailedToolExecution as isFailedGraphifyToolExecution, renderGraphifyCloneDirective } from '../../../preseed/agents/pi/extensions/graphify-helpers';
import { bypassAckHeadForStatus, classifyReviewFiles, classifyReviewHead, commandTextFromEvent, createBoundedOnceTracker, createReadyOnceTracker, cwdFromBoundaryCommand, extractBackgroundAgentId, isFailedToolExecution, isPrBoundaryCommand, prCreateBoundaryBase, reusablePendingReview, selectReviewBase } from '../../../preseed/agents/pi/extensions/review-helpers';
import { actionableReviewCount, allDurableReviewLanesComplete, announcementReconcileDecision, compactDurableReviewStatus, countReviewSeverities, durableReviewAckReady, durableReviewEligibleLanes, durableReviewInitialLanes, durableReviewJobDir, durableReviewMessageKey, durableReviewRecommendation, durableReviewResultModel, durableReviewStatusSegments, durableReviewSummaryModel, extractReviewFindings, formatMergedReviewSummary, laneExtensionSources, mergedReviewSummaryModel, reapLaneDecision, recoverDurableReviewLaneState, requestReviewAutofixForRows, reviewAnnouncementNonce, reviewAutofixModeFromUserMessages, reviewAutofixRequest, sendReviewAutofixRequest, shouldAttemptAnnouncement, shouldCheckOpenPrReconciliation, shouldReconcileOpenPr, summarizeLaneTranscript, type OpenPrReconcileInput } from '../../../preseed/agents/pi/extensions/review-job-helpers';
import { buildSpawnOptions, captureFilename, captureTimestamp, compactMessages, isFirstMessage, isRealUserPrompt, isResumedSession, MEMORY_EVERY_N_PROMPTS, parseSessionMessages, realUserPromptCount, sessionId, shouldCapture, withCurrentPrompt } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';
import { LOCAL_BUILD_BYPASS, attributionBlockReason, isLocalBuildCommand, localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';
import { reviewLaneBlockReason, reviewScopeBlockReason } from '../../../preseed/agents/pi/extensions/review-lane-guards';
import { DEBUG_WORKFLOW, DEPLOY_WORKFLOW, BRAINSTORM_WORKFLOW, commandInstructions, deployTarget } from '../../../preseed/agents/pi/extensions/commands-helpers';
import { shouldHandleClonePrompt } from '../../../preseed/agents/pi/extensions/codeflare-pi';
import localStatuslineExtension from '../../../preseed/agents/pi/extensions/local-statusline';

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

  it('Pi has skills, native runtime extensions, and subagent definitions', () => {
    const piDocs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/'));
    const skills = piDocs.filter((d) => d.key.startsWith('.pi/agent/skills/'));
    const agents = piDocs.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const extensions = piDocs.filter((d) => d.key.startsWith('.pi/agent/extensions/'));
    const scripts = piDocs.filter((d) => d.key.startsWith('.pi/agent/scripts/'));
    expect(skills.length).toBeGreaterThan(0);
    expect(extensions.map((d) => d.key).sort()).toEqual([
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
      '.pi/agent/extensions/review-job-helpers.ts',
      '.pi/agent/extensions/review-jobs.ts',
      '.pi/agent/extensions/review-lane-guards.ts',
      '.pi/agent/extensions/sdd-helpers.ts',
      '.pi/agent/extensions/startup-header.ts',
    ]);
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/Explore.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/code-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/spec-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/doc-updater.md');
    expect(skills.map((d) => d.key).filter((key) => key === '.pi/agent/skills/graphify/SKILL.md')).toHaveLength(1);
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
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/codeflare-commands.ts');
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/local-statusline.ts');
    const codeReviewer = agents.find((d) => d.key === '.pi/agent/agents/code-reviewer.md');
    expect(codeReviewer?.content).toContain('tools: read, grep, find, bash, write');
    // context-mode helper tools are kept (Pi-native names), inert when context-mode is off
    expect(codeReviewer?.content).toContain('ctx_execute');
    expect(codeReviewer?.content).toContain('ctx_batch_execute');
    expect(codeReviewer?.content).toContain('graphify_query');
    expect(codeReviewer?.content).toContain('graphify_explain');
    expect(codeReviewer?.content).toContain('prompt_mode: replace');
    expect(codeReviewer?.content).toContain('extensions: true');
    expect(codeReviewer?.content).toContain('skills: true');
    expect(codeReviewer?.content).toContain('inherit_context: true');
    expect(codeReviewer?.content).toContain('run_in_background: false');
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

  it('REQ-AGENT-056: Pi local statusline renders model effort and preserves extension statuses', () => {
    const handlers = new Map<string, Function>();
    let footerFactory: Function | undefined;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Function[] = [];
    const clearedIntervals: unknown[] = [];
    globalThis.setInterval = ((handler: Function) => {
      intervals.push(handler);
      return intervals.length;
    }) as never;
    globalThis.clearInterval = ((handle: unknown) => {
      clearedIntervals.push(handle);
    }) as never;
    const pi = {
      getThinkingLevel: () => 'xhigh',
      on: (event: string, handler: Function) => handlers.set(event, handler),
    };
    const ctx = {
      hasUI: true,
      model: { id: 'gpt-5.5' },
      cwd: '/tmp',
      sessionManager: { getCwd: () => '/tmp' },
      getContextUsage: () => ({ percent: 42 }),
      ui: { setFooter: (factory: Function) => { footerFactory = factory; } },
    };

    try {
      localStatuslineExtension(pi as never);
      handlers.get('session_start')?.({}, ctx);

      let renders = 0;
      const component = footerFactory?.(
        { requestRender: () => { renders += 1; } },
        { fg: (_name: string, text: string) => text },
        {
          onBranchChange: () => () => undefined,
          getExtensionStatuses: () => new Map([['codeflare-review', 'Review code | spec | docs']]),
        },
      );
      const lines = component.render(120);

      expect(lines[0]).toContain('42%');
      expect(lines[0]).toContain('gpt-5.5:xhigh');
      expect(lines[1]).toBe('Review code | spec | docs');
      expect(intervals).toHaveLength(1);
      intervals[0]();
      expect(renders).toBe(1);
      component.dispose();
      expect(clearedIntervals).toEqual([1]);

      const ansiComponent = footerFactory?.(
        { requestRender: () => undefined },
        { fg: (_name: string, text: string) => text },
        {
          onBranchChange: () => () => undefined,
          getExtensionStatuses: () => new Map([['codeflare-review', 'Review \x1b[32mcode\x1b[0m | \x1b[33mspec\x1b[0m | docs']]),
        },
      );
      const ansiLines = ansiComponent.render(20);
      expect(ansiLines[1].replace(/\x1b\[[0-9;]*m/g, '')).toBe('Review code | spec…');
      expect(ansiLines[1]).toContain('\x1b[32mcode\x1b[0m');
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
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

  it('Pi agents use Pi-native tool names and keep declared context-mode tools (not stripped, never mcp-prefixed)', () => {
    const agents = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const toolsLine = (content: string) => content.match(/^tools:.*$/m)?.[0] ?? '';
    for (const agent of agents) {
      // the Claude->Pi remap is complete: the tools line carries Pi-native names, no mcp__ prefixes
      expect(toolsLine(agent.content)).not.toContain('mcp__');
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

  it('REQ-AGENT-036: Pi review enforcement ignores failed PR-boundary tool results and tolerates GitHub PR-head lag', () => {
    expect(isFailedToolExecution({ isError: true })).toBe(true);
    expect(isFailedToolExecution({ status: 'error' })).toBe(true);
    expect(isFailedToolExecution({ isError: false, status: 'success' })).toBe(false);
    expect(prCreateBoundaryBase('gh pr create --base main')).toBe('main');
    expect(prCreateBoundaryBase('gh pr create -B master')).toBe('master');
    expect(prCreateBoundaryBase('gh pr create --base "main"')).toBe('main');
    expect(prCreateBoundaryBase("gh pr create -B 'master'")).toBe('master');
    // A just-created PR can be temporarily invisible to `gh pr view`; without a known base,
    // fail open to the protected default so review enforcement still arms for local HEAD.
    expect(prCreateBoundaryBase('gh pr create --title test')).toBe('main');
    expect(prCreateBoundaryBase('gh pr create --base develop')).toBeUndefined();
    expect(prCreateBoundaryBase('gh pr create --base "develop"')).toBeUndefined();
  });

  it('REQ-AGENT-055 AC1-AC3: review head classification separates stale, unreadable, and advanced PR heads', () => {
    // Local HEAD still at the reviewed head -> current, even if GitHub lags or gh fails.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h1', prOpenAtBase: false, prHead: undefined, prQueryFailed: true })).toBe('current');
    // PR is open at main and still names the pending head -> current.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: true, prHead: 'h1', prQueryFailed: false })).toBe('current');
    // PR is open but now names a different unrelated head, and local moved on too -> definitively stale.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: true, prHead: 'h2', prQueryFailed: false })).toBe('stale');
    // PR head advanced along the same branch -> advanced, so the review window rolls forward instead of being discarded.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: true, prHead: 'h2', prQueryFailed: false, prHeadDescendsFromPending: true })).toBe('advanced');
    // A readable PR head is authoritative; an unrelated PR head stays stale even if local HEAD descends from the pending head.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h3', prOpenAtBase: true, prHead: 'h2', prQueryFailed: false, localHeadDescendsFromPending: true })).toBe('stale');
    // PR is no longer open at main (closed/merged/retargeted) and local moved on -> stale.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: false, prHead: undefined, prQueryFailed: false })).toBe('stale');
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: false, prHead: undefined, prQueryFailed: false, localHeadDescendsFromPending: true })).toBe('stale');
    // failure #13: gh pr view failed and local moved on; the PR may still be open at h1.
    // This MUST be "unknown" (preserve pending, retry), never "stale" -- discarding here
    // would drop the merge gate and leave the reviewed head un-acked.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: 'h2', prOpenAtBase: false, prHead: undefined, prQueryFailed: true })).toBe('unknown');
    // gh failed and local HEAD is also unreadable -> still unknown, not stale.
    expect(classifyReviewHead({ pendingHead: 'h1', localHead: undefined, prOpenAtBase: false, prHead: undefined, prQueryFailed: true })).toBe('unknown');
  });

  it('REQ-AGENT-041 / REQ-AGENT-055: Pi review bypass acknowledges only the current live PR head', () => {
    expect(bypassAckHeadForStatus({ status: 'current', pendingHead: 'h1' })).toBe('h1');
    expect(bypassAckHeadForStatus({ status: 'advanced', pendingHead: 'h1', currentHead: 'h2' })).toBe('h2');
    expect(bypassAckHeadForStatus({ status: 'advanced', pendingHead: 'h1' })).toBeUndefined();
    expect(bypassAckHeadForStatus({ status: 'stale', pendingHead: 'h1', currentHead: 'h2' })).toBeUndefined();
    expect(bypassAckHeadForStatus({ status: 'unknown', pendingHead: 'h1', currentHead: 'h2' })).toBeUndefined();
  });

  it('REQ-AGENT-040: Pi review enforcement extracts visible background Agent IDs for pending lanes', () => {
    expect(extractBackgroundAgentId({ details: { agentId: 'abc12345-1234-abc' } })).toBe('abc12345-1234-abc');
    expect(extractBackgroundAgentId({
      content: [{ type: 'text', text: 'Agent started in background.\nAgent ID: def67890-4321-cba\nType: code-reviewer' }],
    })).toBe('def67890-4321-cba');
    expect(extractBackgroundAgentId({
      content: [{ type: 'text', text: 'Agent started in background.\nAgent ID: 1386d8ec-28ca-48e7-9abc-0123456789ab\nType: code-reviewer' }],
    })).toBe('1386d8ec-28ca-48e7-9abc-0123456789ab');
    expect(extractBackgroundAgentId({ content: [{ type: 'text', text: 'No agent id here' }] })).toBeUndefined();
  });

  it('REQ-AGENT-040: Pi review enforcement classifies lanes by changed file surface', () => {
    expect(classifyReviewFiles(['documentation/lanes/preseed.md'])).toEqual(['doc-updater']);
    expect(classifyReviewFiles(['sdd/spec/agents.md'])).toEqual(['spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['preseed/agents/pi/extensions/review-enforcement.ts'])).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(undefined)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);

  });

  it('REQ-AGENT-036: Pi PR-boundary command detection covers head-moving surfaces and ignores metadata-only PR commands', () => {
    expect(isPrBoundaryCommand('git push origin develop')).toBe(true);
    expect(isPrBoundaryCommand('git -C /repo/codeflare push origin develop')).toBe(true);
    expect(isPrBoundaryCommand('gh repo sync owner/repo')).toBe(true);
    expect(isPrBoundaryCommand('gh pr create --base main')).toBe(true);
    expect(isPrBoundaryCommand('gh pr merge 12')).toBe(true);
    expect(isPrBoundaryCommand('gh pr update-branch 12')).toBe(true);
    expect(isPrBoundaryCommand('gh pr edit 12 --base main')).toBe(true);
    expect(isPrBoundaryCommand('cd /repo/codeflare && gh pr create --base main')).toBe(true);
    expect(isPrBoundaryCommand('cd /repo/codeflare && gh pr edit 12 --base main')).toBe(true);
    expect(isPrBoundaryCommand('cd /repo/codeflare\ngit push origin develop')).toBe(true);
    expect(cwdFromBoundaryCommand('cd /repo/codeflare\ngit push origin develop')).toBe('/repo/codeflare');
    expect(cwdFromBoundaryCommand('cd /repo/codeflare && gh pr edit 12 --base main')).toBe('/repo/codeflare');
    expect(cwdFromBoundaryCommand('cd "/repo/with space" && gh pr create --base main')).toBe('/repo/with space');
    expect(cwdFromBoundaryCommand('git -C /repo/codeflare push origin develop')).toBe('/repo/codeflare');
    const batchedDependabotCommand = 'cd /home/user/workspace/codeflare\nset -euo pipefail\ngit status --short --branch\ngit add package.json package-lock.json\ngit commit -m "chore: merge dependabot dependency bumps"\ngit push origin develop\nfor pr in 487 489 490 491; do\n  gh pr close "$pr" --delete-branch --comment "Merged into develop via batched dependency update commit to resolve overlapping package-lock conflicts." || true\ndone';
    expect(isPrBoundaryCommand(batchedDependabotCommand)).toBe(true);
    expect(cwdFromBoundaryCommand(batchedDependabotCommand)).toBe('/home/user/workspace/codeflare');
    expect(commandTextFromEvent({ toolCall: { input: { command: batchedDependabotCommand } } })).toBe(batchedDependabotCommand);
    expect(commandTextFromEvent({ input: { command: 'git status' }, toolCall: { arguments: { command: batchedDependabotCommand } } })).toBe(batchedDependabotCommand);
    // FIX 2: commandTextFromEvent is shell-only. ctx_execute code counts only when language is
    // "shell"; a non-shell body is ignored so a source literal can't false-fire the boundary, the
    // legacy .script shape yields nothing, and a ctx_batch surfaces its boundary command.
    expect(commandTextFromEvent({ input: { language: 'shell', code: 'gh pr create --base main' } })).toBe('gh pr create --base main');
    expect(commandTextFromEvent({ input: { language: 'javascript', code: "const cmd = 'git push origin main'" } })).toBe('');
    expect(commandTextFromEvent({ input: { script: 'git push origin develop' } })).toBe('');
    expect(commandTextFromEvent({ input: { commands: [{ command: 'ls' }, { command: 'git push origin develop' }] } })).toBe('git push origin develop');
    expect(isPrBoundaryCommand('rg -n "gh pr create --base main" preseed/agents/pi/extensions/review-enforcement.ts')).toBe(false);
    expect(isPrBoundaryCommand("printf '%s' 'git push origin develop'")).toBe(false);
    expect(isPrBoundaryCommand('gh pr edit 12 --base develop')).toBe(false);
    expect(isPrBoundaryCommand('gh pr edit 12 --title metadata-only')).toBe(false);
    expect(isPrBoundaryCommand('gh pr view --json number')).toBe(false);
  });

  it('REQ-AGENT-036 / REQ-AGENT-058: missed-boundary recovery reconciles only a real open enforced unacked PR, never from passive branch existence', () => {
    // Behavioral: exercise the lifecycle gate plus the PR-state decision. A lifecycle tick may
    // query GitHub only for an active SDD repo with no pending window and no throttle. After that,
    // the one PR shape that reconciles is a real open, non-draft, enforced PR with an unacked head
    // and no window/breaker. Passive branch existence and already-handled heads must not reconcile.
    expect(shouldCheckOpenPrReconciliation({
      activeRun: true, hasRepo: true, sddProject: true, pendingSameRepo: false, throttled: false,
    }).check).toBe(true);
    expect(shouldCheckOpenPrReconciliation({
      activeRun: true, hasRepo: true, sddProject: true, pendingSameRepo: true, throttled: false,
    }).check).toBe(false);
    expect(shouldCheckOpenPrReconciliation({
      activeRun: true, hasRepo: true, sddProject: false, pendingSameRepo: false, throttled: false,
    }).check).toBe(false);

    const realOpenPr: OpenPrReconcileInput = {
      prOpen: true, prDraft: false, enforced: true, head: 'abc123',
      acked: false, hasReviewJob: false, reviewActive: false, breakerOpen: false,
    };
    expect(shouldReconcileOpenPr(realOpenPr).reconcile).toBe(true);
    expect(shouldReconcileOpenPr({ ...realOpenPr, prOpen: false }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...realOpenPr, enforced: false }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...realOpenPr, acked: true }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...realOpenPr, hasReviewJob: true }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...realOpenPr, breakerOpen: true }).reconcile).toBe(false);
  });

  it('REQ-AGENT-040: Pi review enforcement dedupes paired terminal events and evicts old ids', () => {
    const shouldProcess = createBoundedOnceTracker(2);
    expect(shouldProcess('tool-1')).toBe(true);
    expect(shouldProcess('tool-1')).toBe(false);
    expect(shouldProcess('tool-2')).toBe(true);
    expect(shouldProcess('tool-3')).toBe(true);
    expect(shouldProcess('tool-1')).toBe(true);
    expect(shouldProcess(undefined)).toBe(true);
  });

  it('REQ-AGENT-040: Pi review enforcement only consumes a terminal event id after command context is ready', () => {
    const shouldProcess = createReadyOnceTracker(2);
    expect(shouldProcess('tool-1', false)).toBe(false);
    expect(shouldProcess('tool-1', true)).toBe(true);
    expect(shouldProcess('tool-1', true)).toBe(false);
    expect(shouldProcess('tool-2', true)).toBe(true);
    expect(shouldProcess('tool-3', true)).toBe(true);
    expect(shouldProcess('tool-1', true)).toBe(true);
  });

  it('REQ-AGENT-040: durable Pi review jobs dispatch all report-only lanes in parallel and ack only after every lane completes', () => {
    const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
    // All required lanes dispatch in the initial wave — doc-updater no longer waits for spec-reviewer.
    expect(durableReviewInitialLanes(lanes)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    // With only code-reviewer done, BOTH spec-reviewer and doc-updater are eligible (no ordering gate).
    expect(durableReviewEligibleLanes({
      lanes,
      completed: ['code-reviewer'],
      running: [],
      requestedAt: {},
      now: 1000,
      retryMs: 60_000,
    })).toEqual(['spec-reviewer', 'doc-updater']);
    // doc-updater is eligible WHILE spec-reviewer is still running (proves no spec→doc gate);
    // a running lane is not re-dispatched.
    expect(durableReviewEligibleLanes({
      lanes,
      completed: ['code-reviewer'],
      running: ['spec-reviewer'],
      requestedAt: {},
      now: 1000,
      retryMs: 60_000,
    })).toEqual(['doc-updater']);
    expect(allDurableReviewLanesComplete(lanes, ['code-reviewer', 'spec-reviewer'])).toBe(false);
    expect(allDurableReviewLanesComplete(lanes, ['code-reviewer', 'spec-reviewer', 'doc-updater'])).toBe(true);
  });

  it('REQ-AGENT-061: idle reaper helpers advance completed lanes to exact-head summary and autofix', () => {
    const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
    expect(durableReviewEligibleLanes({
      lanes,
      completed: ['code-reviewer', 'spec-reviewer'],
      running: [],
      requestedAt: {},
      now: 1000,
      retryMs: 60_000,
    })).toEqual(['doc-updater']);
    expect(durableReviewAckReady({ lanes, resultLanes: ['code-reviewer', 'spec-reviewer'] })).toBe(false);
    expect(durableReviewAckReady({ lanes, resultLanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'] })).toBe(true);

    const summary = formatMergedReviewSummary({
      repoName: 'codeflare',
      head: 'abc123',
      records: [{ lane: 'code-reviewer', path: '/tmp/code.md', text: '[HIGH] fix me', counts: { critical: 0, high: 1, medium: 0, low: 0 }, recommendation: 'fix' }],
    });
    expect(summary).toContain('PR-boundary review acknowledged for codeflare at abc123.');
    expect(summary).toContain('| HIGH | 1 | warn |');

    const sent: Array<{ message: { details?: unknown }; options: unknown }> = [];
    expect(requestReviewAutofixForRows({
      sender: { sendMessage: (message: { details?: unknown }, options: unknown) => sent.push({ message, options }) },
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      reviewComplete: true,
      claim: () => true,
    })).toBe(true);
    expect(sent).toEqual([{ message: expect.objectContaining({ details: { repo: '/repo/codeflare', head: 'abc123' } }), options: { triggerTurn: true, deliverAs: 'followUp' } }]);
  });

  it('REQ-AGENT-054: durable lane recovery reflects disk status (result wins; running is preserved for the reaper; completed-without-result reopens; failed stays unacked)', () => {
    // Failed lane with no result → preserved verbatim, and stays unacked.
    expect(recoverDurableReviewLaneState({
      lane: 'code-reviewer',
      current: { lane: 'code-reviewer', status: 'failed', startedAt: 5, completedAt: 6, error: 'timeout' },
      resultExists: false,
    })).toEqual({
      lane: 'code-reviewer',
      status: 'failed',
      startedAt: 5,
      completedAt: 6,
      error: 'timeout',
    });
    expect(allDurableReviewLanesComplete(['code-reviewer'], [])).toBe(false);
    expect(durableReviewAckReady({ lanes: ['code-reviewer'], resultLanes: [] })).toBe(false);
    expect(durableReviewAckReady({ lanes: ['code-reviewer'], resultLanes: ['code-reviewer'] })).toBe(true);
    // Running lane with no result → PRESERVED as running (incl. pid). Lanes are
    // detached child processes; the running → completed/failed transition is owned by
    // the reaper (reapLaneDecision), which checks child-process liveness. Recovery
    // must NOT reset running → pending here — that reset caused re-spawn churn when a
    // spawning session exited and a later session re-read the job (REQ-AGENT-058).
    expect(recoverDurableReviewLaneState({
      lane: 'code-reviewer',
      current: { lane: 'code-reviewer', status: 'running', startedAt: 10, pid: 4242, transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/code-reviewer.jsonl' },
      resultExists: false,
    })).toEqual({
      lane: 'code-reviewer',
      status: 'running',
      startedAt: 10,
      pid: 4242,
      transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/code-reviewer.jsonl',
    });
    // Completed record but the result file is gone (manual clean / corruption) →
    // reopened as pending so the lane can run again.
    expect(recoverDurableReviewLaneState({
      lane: 'spec-reviewer',
      current: { lane: 'spec-reviewer', status: 'completed', startedAt: 20, completedAt: 30, transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/spec-reviewer.jsonl' },
      resultExists: false,
    })).toEqual({
      lane: 'spec-reviewer',
      status: 'pending',
      startedAt: 20,
      completedAt: 30,
      transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/spec-reviewer.jsonl',
    });
    // Result file exists → completed is authoritative, even over a 'running' record.
    expect(recoverDurableReviewLaneState({
      lane: 'doc-updater',
      current: { lane: 'doc-updater', status: 'running', startedAt: 30 },
      resultExists: true,
      resultPath: '/repo/.git/sdd-review-results/head/doc-updater.md',
    })).toEqual({
      lane: 'doc-updater',
      status: 'completed',
      startedAt: 30,
      resultPath: '/repo/.git/sdd-review-results/head/doc-updater.md',
    });
  });

  it('REQ-AGENT-054: summarizeLaneTranscript distils a child pi --mode json stream into reaper facts', () => {
    const lines = [
      JSON.stringify({ type: 'session' }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'Task: review' } }),
      'this is not json — partial flush, must be skipped',
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '## Findings\n[HIGH] bug' }], stopReason: 'stop' } }),
      JSON.stringify({ type: 'agent_end' }),
      '',
    ];
    expect(summarizeLaneTranscript(lines)).toEqual({
      agentEnded: true,
      finalText: '## Findings\n[HIGH] bug',
      stopReason: 'stop',
      errored: false,
    });
    // No assistant output yet, no agent_end → nothing usable.
    expect(summarizeLaneTranscript([JSON.stringify({ type: 'agent_start' })])).toEqual({
      agentEnded: false,
      finalText: '',
      stopReason: undefined,
      errored: false,
    });
  });

  it('REQ-AGENT-054: reapLaneDecision is the running → completed/failed authority (agent_end completes; usable result survives a missing terminal line; dead/over-budget fails; only over-budget-while-alive kills)', () => {
    const baseTranscript = { agentEnded: false, finalText: '', stopReason: undefined as string | undefined, errored: false };
    // agent_end + usable text → complete (the child is already gone; never kill).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: { agentEnded: true, finalText: 'findings', stopReason: 'stop', errored: false }, hasPid: true, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'complete', finalText: 'findings' });
    // agent_end but the model errored → fail WITHOUT kill (the run already finished).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: { agentEnded: true, finalText: '', stopReason: 'error', errored: true }, hasPid: true, pidAlive: true, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'fail', reason: 'lane finished without a usable result (stopReason=error, errored)', kill: false });
    // Child gone, NO agent_end, but a usable final message was flushed → keep it (don't
    // discard a real review over a missing terminal line).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: { agentEnded: false, finalText: 'findings', stopReason: 'stop', errored: false }, hasPid: true, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'complete', finalText: 'findings' });
    // Child gone with no agent_end and no usable output → crashed; fail (no kill).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: baseTranscript, hasPid: true, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'fail', reason: 'lane process exited before producing a result', kill: false });
    // Verified-alive, over budget → reclaim (the ONLY kill path).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: baseTranscript, hasPid: true, pidAlive: true, startedAt: 0, now: 120_000, timeoutMs: 60_000 }))
      .toEqual({ action: 'fail', reason: 'lane exceeded 60000ms budget', kill: true });
    // Alive, within budget, no agent_end → keep waiting.
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: baseTranscript, hasPid: true, pidAlive: true, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'none' });
    // Already settled (result exists, or not running) → never reaped again.
    expect(reapLaneDecision({ status: 'running', resultExists: true, transcript: { agentEnded: true, finalText: 'x', stopReason: 'stop', errored: false }, hasPid: true, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'none' });
    expect(reapLaneDecision({ status: 'failed', resultExists: false, transcript: baseTranscript, hasPid: false, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 60_000 }))
      .toEqual({ action: 'none' });
  });

  it('REQ-AGENT-054: durable lane orchestration is retry-aware (transient error + retry completes; a willRetry attempt-end never settles a lane; a failed lane self-heals)', () => {
    // The exact field failure: a spec-reviewer lane hit a transient WebSocket error, pi
    // auto-retried IN-PROCESS, and the retry produced a clean final report — but the old
    // summarizer set agentEnded on the willRetry=true attempt-end and kept `errored` sticky,
    // so the reaper failed the lane ~112s in (before the retry) and never recovered it.
    const retried = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'WebSocket error' } }),
      JSON.stringify({ type: 'agent_end', willRetry: true }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '## Findings\n[HIGH] real' }], stopReason: 'stop' } }),
      JSON.stringify({ type: 'agent_end', willRetry: false }),
    ];
    // Retryable error then a clean final message → terminal, clean, usable (errored not sticky).
    expect(summarizeLaneTranscript(retried)).toEqual({ agentEnded: true, finalText: '## Findings\n[HIGH] real', stopReason: 'stop', errored: false });

    // Mid-retry snapshot (error + willRetry=true on disk, retry not done): nothing terminal, the
    // failed attempt's verdict is discarded so it cannot prematurely fail the lane.
    const midRetry = retried.slice(0, 3);
    expect(summarizeLaneTranscript(midRetry)).toEqual({ agentEnded: false, finalText: '', stopReason: undefined, errored: false });
    // While the child is still alive within budget, the reaper keeps it running (no premature fail).
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: summarizeLaneTranscript(midRetry), hasPid: true, pidAlive: true, startedAt: 0, now: 112_000, timeoutMs: 900_000 }))
      .toEqual({ action: 'none' });
    // Once the retry has flushed its terminal report, the reaper completes with the retry's text.
    expect(reapLaneDecision({ status: 'running', resultExists: false, transcript: summarizeLaneTranscript(retried), hasPid: true, pidAlive: false, startedAt: 0, now: 200_000, timeoutMs: 900_000 }))
      .toEqual({ action: 'complete', finalText: '## Findings\n[HIGH] real' });

    // A TERMINAL agent_end (willRetry=false) that still errored stays a fail — never healed.
    const terminalError = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error', errorMessage: 'gave up' } }),
      JSON.stringify({ type: 'agent_end', willRetry: false }),
    ];
    expect(summarizeLaneTranscript(terminalError)).toEqual({ agentEnded: true, finalText: '', stopReason: 'error', errored: true });

    // Self-heal: a lane an earlier (buggy/raced) reaper marked `failed`, whose transcript now
    // holds a terminal clean usable result and has no result file, recovers to complete.
    expect(reapLaneDecision({ status: 'failed', resultExists: false, transcript: summarizeLaneTranscript(retried), hasPid: true, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 900_000 }))
      .toEqual({ action: 'complete', finalText: '## Findings\n[HIGH] real' });
    // A genuinely-failed lane (no terminal usable result) is NOT resurrected.
    expect(reapLaneDecision({ status: 'failed', resultExists: false, transcript: summarizeLaneTranscript(terminalError), hasPid: false, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 900_000 }))
      .toEqual({ action: 'none' });
    // A failed lane that already wrote a result file is left settled (no double-write).
    expect(reapLaneDecision({ status: 'failed', resultExists: true, transcript: summarizeLaneTranscript(retried), hasPid: false, pidAlive: false, startedAt: 0, now: 1000, timeoutMs: 900_000 }))
      .toEqual({ action: 'none' });
  });

  it('REQ-AGENT-053: durable Pi review results derive structured severity state from findings', () => {
    const model = durableReviewResultModel(
      { repo: '/repo/codeflare', head: 'abc123456789', prNumber: 443 },
      'spec-reviewer',
      '[HIGH] stale rule\n[LOW] wording nit\n\n## Review Summary\nold table'
    );
    expect(model).toMatchObject({
      repoName: 'codeflare',
      head: 'abc123456789',
      prNumber: 443,
      lane: 'spec-reviewer',
      counts: { critical: 0, high: 1, medium: 0, low: 1 },
      recommendation: 'fix',
    });
  });

  it('REQ-AGENT-053: durable Pi review announcements use a stable per-lane dedupe key', () => {
    expect(durableReviewMessageKey({ customType: 'pr-boundary-review-result', repo: '/repo', head: 'abc', lane: 'code-reviewer', path: '/repo/.git/sdd-review-results/abc/code-reviewer.md' }))
      .toBe(durableReviewMessageKey({ customType: 'pr-boundary-review-result', repo: '/repo', head: 'abc', lane: 'code-reviewer', path: '/repo/.git/sdd-review-results/abc/code-reviewer.md' }));
    expect(durableReviewMessageKey({ customType: 'pr-boundary-review-result', repo: '/repo', head: 'abc', lane: 'code-reviewer', path: '/repo/.git/sdd-review-results/abc/code-reviewer.md' }))
      .not.toBe(durableReviewMessageKey({ customType: 'pr-boundary-review-result', repo: '/repo', head: 'abc', lane: 'spec-reviewer', path: '/repo/.git/sdd-review-results/abc/spec-reviewer.md' }));
  });

  it('REQ-AGENT-053: durable Pi review summary model reports table columns, per-lane counts, and fix recommendation', () => {
    const summary = durableReviewSummaryModel([
      { lane: 'code-reviewer', path: '/tmp/code.md', counts: { critical: 0, high: 1, medium: 0, low: 0 }, recommendation: 'fix' },
      { lane: 'doc-updater', path: '/tmp/docs.md', counts: { critical: 0, high: 0, medium: 0, low: 0 }, recommendation: 'none' },
    ]);
    expect(summary).toEqual({
      columns: ['Lane', 'Findings document', 'Critical', 'High', 'Medium', 'Low', 'Recommendation'],
      rows: [
        { lane: 'code-reviewer', path: '/tmp/code.md', counts: { critical: 0, high: 1, medium: 0, low: 0 }, recommendation: 'fix' },
        { lane: 'doc-updater', path: '/tmp/docs.md', counts: { critical: 0, high: 0, medium: 0, low: 0 }, recommendation: 'none' },
      ],
      actionable: 1,
      recommendation: 'automatically fix 1 actionable MEDIUM/HIGH/CRITICAL finding(s), commit, and push only the fix diff',
    });
  });

  it('REQ-AGENT-053: merged Pi review summaries model actionable findings without per-lane document links', () => {
    const codeText = [
      '# PR-boundary code-reviewer',
      '',
      '## Findings',
      '',
      '[MEDIUM] Summary fallback notification is filtered out',
      'File: `preseed/agents/pi/extensions/review-enforcement.ts:465`',
      '',
      'Issue: Duplicate-toast filtering also catches the summary fallback.',
      '',
      'Fix: Allow the explicit fallback summary notification through.',
      '',
      '```ts',
      '[HIGH] inside a code fence is an example, not a separate finding',
      '```',
      '',
      '## Review Summary',
      '',
      '| Severity | Count | Status |',
      '|----------|-------|--------|',
      '| MEDIUM | 1 | info |',
    ].join('\n');
    const docsText = '# PR-boundary doc-updater\n\n## Findings\n\nNo findings.\n';

    expect(extractReviewFindings('code-reviewer', codeText)).toEqual([
      {
        lane: 'code-reviewer',
        severity: 'MEDIUM',
        title: 'Summary fallback notification is filtered out',
        file: 'preseed/agents/pi/extensions/review-enforcement.ts:465',
        issue: 'Duplicate-toast filtering also catches the summary fallback.',
        fix: 'Allow the explicit fallback summary notification through.',
      },
    ]);
    expect(extractReviewFindings('doc-updater', docsText)).toEqual([]);
    const codeCounts = countReviewSeverities(codeText);
    const docCounts = countReviewSeverities(docsText);
    expect(codeCounts).toEqual({ critical: 0, high: 0, medium: 1, low: 0 });
    expect(docCounts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });

    const records = [
      { lane: 'code-reviewer', path: '/tmp/code-reviewer.md', text: codeText, counts: codeCounts, recommendation: durableReviewRecommendation(codeCounts) },
      { lane: 'doc-updater', path: '/tmp/doc-updater.md', text: docsText, counts: docCounts, recommendation: durableReviewRecommendation(docCounts) },
    ];
    expect(mergedReviewSummaryModel({
      repoName: 'codeflare',
      head: '6769bca06f843a50e2d991563afc58498fd7cf81',
      records,
    })).toEqual({
      repoName: 'codeflare',
      head: '6769bca06f843a50e2d991563afc58498fd7cf81',
      headShort: '6769bca06f84',
      counts: { critical: 0, high: 0, medium: 1, low: 0 },
      findings: [
        {
          lane: 'code-reviewer',
          severity: 'MEDIUM',
          title: 'Summary fallback notification is filtered out',
          file: 'preseed/agents/pi/extensions/review-enforcement.ts:465',
          issue: 'Duplicate-toast filtering also catches the summary fallback.',
          fix: 'Allow the explicit fallback summary notification through.',
        },
      ],
      recommendation: 'automatically fix 1 actionable MEDIUM/HIGH/CRITICAL finding(s), commit, and push only the fix diff',
    });
    const escapedSummary = formatMergedReviewSummary({
      repoName: 'codeflare',
      head: '6769bca06f843a50e2d991563afc58498fd7cf81',
      records: [
        {
          lane: 'code-reviewer',
          path: '/tmp/code-reviewer.md',
          text: '[HIGH] Pipe and backslash\nFile: `a|b\\c.ts`\nFix: Replace `x|y\\z` safely.',
          counts: { critical: 0, high: 1, medium: 0, low: 0 },
          recommendation: 'fix',
        },
      ],
    });
    expect(escapedSummary).toContain('a\\|b\\\\c.ts');
    expect(escapedSummary).toContain('Replace x\\|y\\\\z safely.');
  });

  it('REQ-AGENT-053: a lane severity tally block is not counted or parsed as findings', () => {
    // The doc-updater lane prints an inline "CRITICAL: 0 / HIGH: 2 / ..." tally above its real
    // findings. Those lines start with a severity word but are counts, not findings; the merger
    // must skip them so the count stays honest and no phantom CRITICAL flips the verdict to block.
    const docsText = [
      '# PR-boundary doc-updater',
      '',
      '## Findings',
      '',
      'doc-updater report — autonomy: auto; scope: `a..b` for `documentation/ sdd/`',
      '',
      'CRITICAL: 0 (none)',
      'HIGH: 2 (ADR ledger, preseed docs)',
      'MEDIUM: 1 (lane classifier docs)',
      'LOW: 0 (none)',
      'Auto-fixed: 0 (report-only; no files modified)',
      '',
      '[HIGH] ADR ledger is stale after the detached-lane changes',
      'File: `documentation/decisions/README.md:1137`',
      'Issue: AD64 still describes in-process lanes.',
      'Fix: Mark AD64 superseded and add AD76.',
      '',
      '[HIGH] Preseed docs cite removed lane symbols',
      'File: `documentation/lanes/preseed.md:415`',
      'Issue: createAgentSession no longer exists.',
      'Fix: Describe spawnDurableLane instead.',
      '',
      '[MEDIUM] Lane-classifier docs omit generated-only auto-ack',
      'File: `documentation/lanes/preseed.md:499`',
      'Issue: The no-lane auto-ack behavior is undocumented.',
      'Fix: Document the generated-only auto-ack.',
    ].join('\n');

    // Tally lines must not inflate the counts (was 1C/3H/2M/1L before the fix).
    expect(countReviewSeverities(docsText)).toEqual({ critical: 0, high: 2, medium: 1, low: 0 });
    // And must not appear as phantom ": 0" / ": 2" findings (was 7 entries before the fix).
    expect(extractReviewFindings('doc-updater', docsText)).toEqual([
      {
        lane: 'doc-updater',
        severity: 'HIGH',
        title: 'ADR ledger is stale after the detached-lane changes',
        file: 'documentation/decisions/README.md:1137',
        issue: 'AD64 still describes in-process lanes.',
        fix: 'Mark AD64 superseded and add AD76.',
      },
      {
        lane: 'doc-updater',
        severity: 'HIGH',
        title: 'Preseed docs cite removed lane symbols',
        file: 'documentation/lanes/preseed.md:415',
        issue: 'createAgentSession no longer exists.',
        fix: 'Describe spawnDurableLane instead.',
      },
      {
        lane: 'doc-updater',
        severity: 'MEDIUM',
        title: 'Lane-classifier docs omit generated-only auto-ack',
        file: 'documentation/lanes/preseed.md:499',
        issue: 'The no-lane auto-ack behavior is undocumented.',
        fix: 'Document the generated-only auto-ack.',
      },
    ]);

    // Merged: no phantom CRITICAL, totals match the real findings, verdict is not "block".
    const docCounts = countReviewSeverities(docsText);
    const merged = mergedReviewSummaryModel({
      repoName: 'codeflare',
      head: '6769bca06f843a50e2d991563afc58498fd7cf81',
      records: [
        { lane: 'doc-updater', path: '/tmp/doc-updater.md', text: docsText, counts: docCounts, recommendation: durableReviewRecommendation(docCounts) },
      ],
    });
    expect(merged.counts).toEqual({ critical: 0, high: 2, medium: 1, low: 0 });
    expect(merged.findings).toHaveLength(3);
  });

  it('REQ-AGENT-053: the finding extractor ignores a BARE-PROSE severity word, matching the counter', () => {
    // The counter requires a decorated label ([HIGH]/**HIGH**/HIGH:); the extractor must do the same, or
    // the merged summary lists a phantom finding the count table reports as 0 (and autofix can chase it).
    const prose = [
      '## Findings',
      '',
      'Critical to the design is keeping the cache bounded.',
      'High-level summary: the change is low risk.',
      'Medium-term we should revisit this.',
      '',
      '- [HIGH] Unbounded cache growth',
      'File: `src/cache.ts:12`',
      'Issue: entries are never evicted.',
      'Fix: add an LRU bound.',
    ].join('\n');
    // Only the decorated [HIGH] line is a finding; the three bare-prose sentences are not.
    const findings = extractReviewFindings('code-reviewer', prose);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'HIGH', title: 'Unbounded cache growth' });
    // The extractor and the counter agree: one HIGH, zero phantom CRITICAL/MEDIUM.
    expect(countReviewSeverities(prose)).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });

    // Decoration must be ANCHORED to the LEADING severity word, not merely present somewhere on the line.
    // A leading bare severity word with a DECORATED label elsewhere on the same line is NOT a finding —
    // a line-wide decoration test would wrongly emit one here while the counter stays 0 (the lockstep gap).
    const divergent = '## Findings\nHIGH risk because a separate [LOW] item is tagged elsewhere';
    expect(extractReviewFindings('code-reviewer', divergent)).toHaveLength(0);
    expect(countReviewSeverities(divergent)).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });

    // Empty-title lockstep: a decorated label with no inline title (`**CRITICAL**` alone) is COUNTED by the
    // counter, so the extractor must surface it too — with a placeholder title — rather than silently drop a
    // counted severity. A line-wide `(.+?)` title group would fail to match the bare label (0 findings) while
    // the counter reports 1, re-opening the drift in the under-count direction.
    const bareLabel = ['## Findings', '**CRITICAL**', 'File: `src/parser.ts:88`', 'Issue: Unbounded recursion.', 'Fix: add a depth guard.'].join('\n');
    const bareFindings = extractReviewFindings('code-reviewer', bareLabel);
    expect(bareFindings).toHaveLength(1);
    expect(bareFindings[0]).toMatchObject({ severity: 'CRITICAL', title: '(untitled)', file: 'src/parser.ts:88' });
    expect(countReviewSeverities(bareLabel)).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
  });

  it('REQ-AGENT-059: hidden autofix requests send one follow-up only for actionable findings and only after marker claim', () => {
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const sender = { sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) };

    sendReviewAutofixRequest(sender, '/repo/codeflare', 'abc123');
    expect(sent).toEqual([
      {
        message: {
          customType: 'codeflare-review-autofix-request',
          content: [
            'Fix legitimate PR-boundary review findings for codeflare at abc123.',
            'Use the merged review summary immediately above as the actionable finding list; do not fix from partial lane results.',
            'Before editing, committing, or pushing, verify the review job for this exact head is complete and every required lane has a result file.',
            'If any required review lane is still running, pending, missing, or unknown, do not edit, commit, or push; wait for the final merged review summary.',
            'If the user has explicitly said not to automatically fix/implement this round, or to wait for GO/approval, do not edit, commit, or push; present the findings and wait for their command.',
            'Otherwise, fix all legitimate MEDIUM, HIGH, and CRITICAL findings only.',
            'A finding\'s age is never a reason to skip it: fix every legitimate finding whether it is newly introduced or pre-existing, in this diff or adjacent. Do not exclude, defer, or ask about a legitimate finding because it pre-dates this change — legitimacy is the only criterion.',
            'Do not rerun or start CI monitoring unless explicitly asked or a merge/deploy gate requires it.',
            'Commit the fix as a new commit and push to the same branch; do not amend or rewrite history.',
          ].join('\n'),
          display: false,
          details: { repo: '/repo/codeflare', head: 'abc123' },
        },
        options: { triggerTurn: true, deliverAs: 'followUp' },
      },
    ]);

    sent.length = 0;
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 0, medium: 1, low: 0 } }],
      reviewComplete: true,
      claim: () => true,
    })).toBe(true);
    expect(sent).toHaveLength(1);

    sent.length = 0;
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 0, medium: 0, low: 1 } }],
      reviewComplete: true,
      claim: () => true,
    })).toBe(false);
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      reviewComplete: true,
      claim: () => false,
    })).toBe(false);
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      reviewComplete: true,
      suppress: true,
      claim: () => true,
    })).toBe(false);
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      reviewComplete: false,
      claim: () => true,
    })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('REQ-AGENT-059: review autofix follows the latest explicit user auto/manual directive', () => {
    expect(reviewAutofixModeFromUserMessages(['do not auto fix next round', 'review summary arrived'])).toBe('manual');
    expect(reviewAutofixModeFromUserMessages(['do not automatically implement', 'GO, implement findings'])).toBe('auto');
    expect(reviewAutofixModeFromUserMessages(['ordinary review discussion'])).toBe('unset');
  });

  it('REQ-AGENT-062: announcement nonce is deterministic and transcript-scannable, and never collides across kind/stamp', () => {
    expect(reviewAnnouncementNonce('summary', 'abcdef1234567890', 1700)).toBe('cf-review-summary:abcdef123456:1700');
    expect(reviewAnnouncementNonce('autofix', 'abcdef1234567890', 1700)).toBe('cf-review-autofix:abcdef123456:1700');
    expect(reviewAnnouncementNonce('summary', 'h', 1)).not.toBe(reviewAnnouncementNonce('autofix', 'h', 1));
    expect(reviewAnnouncementNonce('summary', 'h', 1)).not.toBe(reviewAnnouncementNonce('summary', 'h', 2));
  });

  it('REQ-AGENT-062: shouldAttemptAnnouncement sends pending once, retries attempted only past the delay and under the cap, never terminal', () => {
    const base = { attempts: 0, lastAttemptAt: undefined as number | undefined, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000 };
    expect(shouldAttemptAnnouncement({ ...base, status: 'pending' })).toBe(true);
    expect(shouldAttemptAnnouncement({ ...base, status: 'visible' })).toBe(false);
    expect(shouldAttemptAnnouncement({ ...base, status: 'failed' })).toBe(false);
    // attempted, within the retry delay → wait (do not double-send before verification can run)
    expect(shouldAttemptAnnouncement({ status: 'attempted', attempts: 1, lastAttemptAt: 90_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000 })).toBe(false);
    // attempted, past the retry delay AND under the cap → retry
    expect(shouldAttemptAnnouncement({ status: 'attempted', attempts: 1, lastAttemptAt: 50_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000 })).toBe(true);
    // attempted, at the cap → never again
    expect(shouldAttemptAnnouncement({ status: 'attempted', attempts: 3, lastAttemptAt: 0, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000 })).toBe(false);
  });

  it('REQ-AGENT-062: announcementReconcileDecision proves delivery by the transcript nonce, fails only after the cap+window, else keeps retrying', () => {
    const base = { kind: 'summary' as const, attempts: 1, lastAttemptAt: 50_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000 };
    // nonce in the transcript → delivered, regardless of prior status
    expect(announcementReconcileDecision({ ...base, status: 'attempted', nonceFound: true })).toBe('visible');
    expect(announcementReconcileDecision({ ...base, status: 'pending', nonceFound: true })).toBe('visible');
    // attempted, nonce absent, under the cap → keep (emit retries it)
    expect(announcementReconcileDecision({ ...base, status: 'attempted', nonceFound: false })).toBe('keep');
    // attempted, nonce absent, at the cap with the final window elapsed → failed (→ /review-results notice)
    expect(announcementReconcileDecision({ kind: 'summary', status: 'attempted', attempts: 3, lastAttemptAt: 50_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false })).toBe('failed');
    // attempted, nonce absent, at the cap but still within the final window → keep (let the last send land)
    expect(announcementReconcileDecision({ kind: 'summary', status: 'attempted', attempts: 3, lastAttemptAt: 95_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false })).toBe('keep');
    // pending (never attempted) → nothing to reconcile yet
    expect(announcementReconcileDecision({ ...base, status: 'pending', nonceFound: false })).toBe('keep');
  });

  it('REQ-AGENT-062: announcementReconcileDecision age backstop escalates a never-attempted (idle-deferred) summary so /review-results stays reachable', () => {
    const base = { kind: 'summary' as const, attempts: 0, now: 700_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false, maxAgeMs: 600_000 };
    // pending forever (idle-gated send never fired → 0 attempts), older than maxAgeMs → failed (age backstop)
    expect(announcementReconcileDecision({ ...base, status: 'pending', createdAt: 0 })).toBe('failed');
    // same record still within maxAgeMs → keep (don't penalise a normal in-flight wait for the next idle tick)
    expect(announcementReconcileDecision({ ...base, status: 'pending', createdAt: 200_000 })).toBe('keep');
    // proof of delivery still wins over age (nonce found on the very tick it would have aged out)
    expect(announcementReconcileDecision({ ...base, status: 'pending', createdAt: 0, nonceFound: true })).toBe('visible');
    // no maxAgeMs/createdAt supplied → age branch inert, behaves exactly as before
    expect(announcementReconcileDecision({ kind: 'summary', status: 'pending', attempts: 0, now: 700_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false })).toBe('keep');
  });

  it('REQ-AGENT-062: the age backstop is summary-only — an autofix announcement never ages out at attempts:0 (aging it would expire the fix turn before it ever fired)', () => {
    const aged = { attempts: 0, now: 700_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false, maxAgeMs: 600_000, createdAt: 0, status: 'pending' as const };
    // summary at this age escalates so the /review-results fallback stays reachable...
    expect(announcementReconcileDecision({ ...aged, kind: 'summary' })).toBe('failed');
    // ...but autofix is EXEMPT: stays 'keep' so a later live tick can still fire the fix/commit/push turn
    expect(announcementReconcileDecision({ ...aged, kind: 'autofix' })).toBe('keep');
    // autofix still fails honestly via the attempt cap (3 real attempts, final window elapsed), never on age alone
    expect(announcementReconcileDecision({ kind: 'autofix', status: 'attempted', attempts: 3, lastAttemptAt: 50_000, now: 100_000, maxAttempts: 3, retryDelayMs: 30_000, nonceFound: false, createdAt: 0, maxAgeMs: 600_000 })).toBe('failed');
    // proof of delivery wins for autofix too, regardless of age
    expect(announcementReconcileDecision({ ...aged, kind: 'autofix', nonceFound: true })).toBe('visible');
  });

  it('REQ-AGENT-062: the autofix request carries the delivery nonce only when supplied (so the SM can verify it landed)', () => {
    const withNonce = reviewAutofixRequest('/repo', 'deadbeef', 'cf-review-autofix:deadbeef:9');
    expect(withNonce.message.content).toContain('cf-review-autofix:deadbeef:9');
    expect(withNonce.message.details).toEqual({ repo: '/repo', head: 'deadbeef', nonce: 'cf-review-autofix:deadbeef:9' });
    const withoutNonce = reviewAutofixRequest('/repo', 'deadbeef');
    expect(withoutNonce.message.content).not.toContain('cf-review-delivery');
    expect(withoutNonce.message.details).toEqual({ repo: '/repo', head: 'deadbeef' });
  });

  it('REQ-AGENT-059: durable Pi review severity helpers identify actionable findings for the fix loop', () => {
    const counts = countReviewSeverities('[CRITICAL] broken\n[HIGH] risky\n[MEDIUM] incomplete\n[LOW] typo');
    expect(counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
    expect(actionableReviewCount(counts)).toBe(3);
    expect(durableReviewRecommendation(counts)).toBe('fix');
    expect(durableReviewRecommendation({ critical: 0, high: 0, medium: 0, low: 1 })).toBe('review');
    expect(durableReviewRecommendation({ critical: 0, high: 0, medium: 0, low: 0 })).toBe('none');
  });

  it('REQ-AGENT-053: durable Pi review status derives lane states for mobile footers', () => {
    expect(durableReviewStatusSegments({
      lanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
      completed: ['code-reviewer'],
      running: ['spec-reviewer'],
    })).toEqual([
      { lane: 'code-reviewer', label: 'code', state: 'completed' },
      { lane: 'spec-reviewer', label: 'spec', state: 'running' },
      { lane: 'doc-updater', label: 'docs', state: 'pending' },
    ]);
    expect(durableReviewStatusSegments({
      lanes: ['doc-updater'],
      completed: [],
      running: ['doc-updater'],
    })).toEqual([{ lane: 'doc-updater', label: 'docs', state: 'running' }]);
    expect(compactDurableReviewStatus({
      head: 'a505655780ea430ef4a82fe5d8b04e58835c3ed5',
      lanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
      completed: ['code-reviewer'],
      running: ['spec-reviewer'],
    })).toBe('Review code | spec | docs');
  });

  it('REQ-AGENT-040: durable Pi review job paths are under .git and result paths stay on the existing review surface', () => {
    expect(durableReviewJobDir('/repo', 'abc123')).toBe('/repo/.git/codeflare-review-jobs/abc123');
  });

  it('REQ-AGENT-060 AC6: durable review lanes load context-mode only when enabled, never subagents; graphify is a first-party local extension, not a package', () => {
    const enabledCtx = [
      'npm:@gotgenes/pi-subagents@14.0.1',
      'npm:context-mode@1.0.151',
    ];
    // context-mode enabled (bare string); subagents never. Graphify is no longer pulled from
    // npm: it is the first-party graphify-native.ts local extension the lane runner loads directly.
    expect(laneExtensionSources(enabledCtx)).toEqual(['npm:context-mode@1.0.151']);

    const disabledCtx = [
      'npm:@gotgenes/pi-subagents@14.0.1',
      { source: 'npm:context-mode@1.0.151', extensions: [], skills: [] },
    ];
    // context-mode in disabled filter form -> nothing additive loads.
    expect(laneExtensionSources(disabledCtx)).toEqual([]);

    // The third-party @gaodes graphify wrapper is no longer a package source and is never loaded.
    expect(laneExtensionSources(['npm:@gaodes/pi-graphify@0.2.2'])).toEqual([]);

    // empty / unrelated packages -> nothing.
    expect(laneExtensionSources([])).toEqual([]);
    expect(laneExtensionSources(['npm:@gotgenes/pi-subagents@14.0.1', '', { source: '' }])).toEqual([]);
  });

  it('REQ-AGENT-055 AC4-AC5: Pi review enforcement selects the unreviewed incremental review base', () => {
    const previous = {
      head: 'old-head',
      reviewBase: 'first-unreviewed-base',
      lanes: ['code-reviewer', 'spec-reviewer'],
      completed: ['code-reviewer'],
    };
    expect(reusablePendingReview(previous, 'new-head', (ancestor, current) => ancestor === 'old-head' && current === 'new-head')).toBe(previous);
    expect(selectReviewBase({ previous, lastAck: 'last-ack' })).toBe('first-unreviewed-base');
    expect(selectReviewBase({
      previous: { ...previous, reviewBase: undefined },
      lastAck: 'last-ack',
    })).toBeUndefined();
    expect(selectReviewBase({
      previous: { ...previous, completed: ['code-reviewer', 'spec-reviewer'] },
      lastAck: 'last-ack',
    })).toBe('old-head');
    expect(reusablePendingReview(previous, 'rebased-head', () => false)).toBeUndefined();
    // Without an ack or a completed previous review proving the prior PR contents were already
    // covered, keep reviewBase undefined so the next review covers the full PR diff (REQ-AGENT-055 AC5).
    expect(selectReviewBase({ previous: undefined, lastAck: undefined })).toBeUndefined();
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
  // the pi-mcp-adapter directTools promotion. codex/opencode/antigravity never get
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

  it('REQ-MEM-002 AC6: withCurrentPrompt counts the submitted prompt once for resume detection', () => {
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

  it('REQ-MEM-001 AC7: memory-vault.ts uses flock for global graph merge', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('flock');
    expect(mv?.content).toContain('graphify-global.lock');
    expect(mv?.content).toContain('user_vault');
  });

  // parseSessionMessages reads Pi's durable on-disk session JSONL (the file Pi persists for
  // /resume) into the message objects compactMessages expects. This is the source that replaces
  // the volatile in-memory buffer that produced empty captures after a reload.
  describe('REQ-MEM-001: parseSessionMessages durable transcript source', () => {
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

  it('REQ-VAULT-003: Pi vault indexing shares Claude marker semantics and exclusions', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('vault-extract.last');
    expect(mv?.content).not.toContain('pi-vault-extract.last');
    expect(mv?.content).toContain('statSync(VAULT_MARKER_FILE).mtimeMs');
    expect(mv?.content).toContain('Raw/Sessions');
    expect(mv?.content).toContain('graphify-out');
    expect(mv?.content).toContain('.silverbullet');
    expect(mv?.content).toContain('Index.md');
    expect(mv?.content).toContain('README.md');
    expect(mv?.content).toContain('CONFIG.md');
    expect(mv?.content).toContain('STYLES.md');
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

  it('REQ-MEM-002 AC6: isResumedSession detects resumed session (no counter, count>1)', () => {
    expect(isResumedSession(false, 5)).toBe(true);
    expect(isResumedSession(false, 1)).toBe(false);
    expect(isResumedSession(true, 5)).toBe(false);
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

describe('REQ-AGENT-031 consult-llm invocation behaviour (5-choice model dialog + server-side selectors)', () => {
  function consultLlmSkill(key: string): string {
    const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === key);
    expect(doc, `${key} must be bundled in the seed`).toBeTruthy();
    return doc!.content;
  }

  // AC5: when no model is named, the skill drives a single-select dialog of four
  // explicit choices (+ the tool's automatic "Other" write-in = five): latest
  // Gemini, latest OpenAI, both, and "list all available".
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

  // AC5: "latest" is resolved by the server-side selectors, never a hardcoded model
  // ID and never a live provider model-list fetch - the isolation-breaking curl that
  // leaked the raw provider key is gone from both the Claude and Pi skills.
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

  // AC5 regression (consult-llm "List models" bug): the old skill told the agent to
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

  // AC4: the Pi skill mirrors the Claude one but drives Pi's ask_user_question tool.
  it('AC4: Pi skill mirrors the dialog using ask_user_question (not AskUserQuestion)', () => {
    const body = consultLlmSkill('.pi/agent/skills/consult-llm/SKILL.md');
    expect(body).toContain('ask_user_question');
    expect(body).not.toContain('AskUserQuestion');
    expect(body).toMatch(/five/i);
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

  it('REQ-AGENT-060 AC7: detached review lanes never consume the local-build bypass sentinel', () => {
    const hadSentinel = existsSync(LOCAL_BUILD_BYPASS);
    writeFileSync(LOCAL_BUILD_BYPASS, '', 'utf8');
    try {
      expect(reviewLaneBlockReason('npm run build')).toMatch(/create \/tmp\/local-build-bypass/);
      expect(existsSync(LOCAL_BUILD_BYPASS)).toBe(true);
      expect(reviewLaneBlockReason('git diff origin/main...HEAD')).toBeUndefined();
    } finally {
      if (hadSentinel) writeFileSync(LOCAL_BUILD_BYPASS, '', 'utf8');
      else rmSync(LOCAL_BUILD_BYPASS, { force: true });
    }
  });
});

describe('Incremental review scope confinement / REQ-AGENT-040 AC8 (reviewer defs + enforce skills scope-agnostic) + REQ-AGENT-060 AC8 (lane guard enforces the incremental window)', () => {
  const scope = { base: 'abc1234', head: 'def5678', baseRef: 'main' };

  it('REQ-AGENT-060 AC8: with no acked base (first review) the scope guard blocks nothing — full PR is the intended scope', () => {
    expect(reviewScopeBlockReason('git diff origin/main...HEAD', {})).toBeUndefined();
    expect(reviewScopeBlockReason('gh pr diff', {})).toBeUndefined();
  });

  it('REQ-AGENT-060 AC8: with an acked base, full-PR diff commands are blocked (three-dot, two-dot, non-origin base, gh pr diff)', () => {
    expect(reviewScopeBlockReason('git diff origin/main...HEAD', scope)).toMatch(/incremental review mode/);
    expect(reviewScopeBlockReason('git diff origin/main..HEAD', scope)).toMatch(/incremental review mode/);     // two-dot form
    expect(reviewScopeBlockReason('git diff origin/develop...HEAD', { ...scope, baseRef: 'develop' })).toMatch(/incremental review mode/);
    expect(reviewScopeBlockReason('git diff main...HEAD', scope)).toMatch(/incremental review mode/);           // no origin/ prefix
    expect(reviewScopeBlockReason('git diff develop..HEAD', scope)).toMatch(/incremental review mode/);          // bare base branch, two-dot
    expect(reviewScopeBlockReason('git diff feature/x...HEAD', { ...scope, baseRef: 'feature/x' })).toMatch(/incremental review mode/); // arbitrary base ref
    expect(reviewScopeBlockReason('gh pr diff', scope)).toMatch(/incremental review mode/);
    expect(reviewScopeBlockReason('gh pr diff 207', scope)).toMatch(/incremental review mode/);
  });

  it('REQ-AGENT-060 AC8: the incremental-window commands and ordinary inspection are allowed', () => {
    expect(reviewScopeBlockReason('git diff abc1234 def5678', scope)).toBeUndefined();
    expect(reviewScopeBlockReason('git diff --name-only abc1234 def5678', scope)).toBeUndefined();
    expect(reviewScopeBlockReason('git diff abc1234 def5678 -- src/index.ts', scope)).toBeUndefined();
    expect(reviewScopeBlockReason('git diff abc1234..def5678', scope)).toBeUndefined();
    expect(reviewScopeBlockReason('git status', scope)).toBeUndefined();
    expect(reviewScopeBlockReason('cat src/index.ts', scope)).toBeUndefined();
  });

  it('REQ-AGENT-040 AC8: the seeded reviewer agent defs are scope-agnostic (honor an explicit window, keep the full-diff default)', () => {
    for (const suffix of ['agents/code-reviewer.md', 'agents/spec-reviewer.md', 'agents/doc-updater.md']) {
      const docs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.endsWith(suffix));
      expect(docs.length, `expected at least one seeded ${suffix}`).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.content, `${doc.key} should honor an explicit incremental window`).toMatch(/nothing wider/);
        expect(doc.content, `${doc.key} should keep the full-diff default`).toMatch(/origin\/main\.\.\.HEAD|full change set/i);
      }
    }
  });
});

describe('Pi memory model-fidelity lever / REQ-MEM-014 AC5 (buildSpawnOptions applies the model only when set; no hardcoded model)', () => {
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

  it('always carries the description and inheritContext:false base options', () => {
    const opts = buildSpawnOptions('Capture resumed session memory', 'm');
    expect(opts.description).toBe('Capture resumed session memory');
    expect(opts.inheritContext).toBe(false);
  });
});
