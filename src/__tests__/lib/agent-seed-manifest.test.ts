import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { cloneTargetPath, graphifyCloneAction, graphifyClonePromptDecision, graphifyPromptMarker, isFailedToolExecution as isFailedGraphifyToolExecution } from '../../../preseed/agents/pi/extensions/graphify-helpers';
import { bypassAckHeadForStatus, classifyReviewFiles, classifyReviewHead, createBoundedOnceTracker, createReadyOnceTracker, extractBackgroundAgentId, isFailedToolExecution, isPrBoundaryCommand, prCreateBoundaryBase, reusablePendingReview, selectReviewBase } from '../../../preseed/agents/pi/extensions/review-helpers';
import { actionableReviewCount, allDurableReviewLanesComplete, countReviewSeverities, durableReviewAckReady, durableReviewEligibleLanes, durableReviewInitialLanes, durableReviewJobDir, durableReviewMessageKey, durableReviewRecommendation, durableReviewResultModel, durableReviewStatusSegments, durableReviewSummaryModel, extractReviewFindings, formatMergedReviewSummary, laneExtensionSources, mergedReviewSummaryModel, recoverDurableReviewLaneState, requestReviewAutofixForRows, reviewAutofixModeFromUserMessages, sendReviewAutofixRequest } from '../../../preseed/agents/pi/extensions/review-job-helpers';
import { buildSpawnOptions, captureFilename, captureTimestamp, compactMessages, isFirstMessage, isRealUserPrompt, isResumedSession, MEMORY_EVERY_N_PROMPTS, parseSessionMessages, realUserPromptCount, sessionId, shouldCapture, stableId, titleFor, withCurrentPrompt } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';
import { attributionBlockReason, isLocalBuildCommand, localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';
import { DEBUG_WORKFLOW, DEPLOY_WORKFLOW, BRAINSTORM_WORKFLOW, commandInstructions, deployTarget } from '../../../preseed/agents/pi/extensions/commands-helpers';

/**
 * Validates invariants of the generated agent seed configs.
 *
 * The generator script (generate-agent-seed.mjs) reads manifest.json and the
 * preseed file tree at build time, validates bidirectional consistency, and
 * embeds the result into AGENTS_SEEDED_CONFIGS. These tests verify the
 * generated output's runtime invariants without filesystem access (which
 * isn't available in the Workers vitest pool).
 */

const VALID_KEY_PREFIXES = ['.claude/', '.codex/', '.copilot/', '.config/opencode/', '.pi/agent/'];

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
    expect(keys.has('.copilot/copilot-instructions.md')).toBe(true);
    expect(keys.has('.config/opencode/AGENTS.md')).toBe(true);
    expect(keys.has('.pi/agent/AGENTS.md')).toBe(true);
  });

  it('instructions files appear twice (one per mode, different content)', () => {
    const instructionKeys = [
      '.codex/AGENTS.md',
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

  it('Pi has skills, native runtime extensions, and subagent definitions', () => {
    const piDocs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.pi/agent/'));
    const skills = piDocs.filter((d) => d.key.startsWith('.pi/agent/skills/'));
    const agents = piDocs.filter((d) => d.key.startsWith('.pi/agent/agents/') && !d.key.endsWith('AGENTS.md'));
    const extensions = piDocs.filter((d) => d.key.startsWith('.pi/agent/extensions/'));
    const scripts = piDocs.filter((d) => d.key.startsWith('.pi/agent/scripts/'));
    expect(skills.length).toBeGreaterThan(0);
    expect(extensions.map((d) => d.key).sort()).toEqual([
      '.pi/agent/extensions/codeflare-commands.ts',
      '.pi/agent/extensions/codeflare-pi.ts',
      '.pi/agent/extensions/commands-helpers.ts',
      '.pi/agent/extensions/graphify-helpers.ts',
      '.pi/agent/extensions/guard-helpers.ts',
      '.pi/agent/extensions/memory-vault-helpers.ts',
      '.pi/agent/extensions/memory-vault.ts',
      '.pi/agent/extensions/review-command.ts',
      '.pi/agent/extensions/review-enforcement.ts',
      '.pi/agent/extensions/review-helpers.ts',
      '.pi/agent/extensions/review-job-helpers.ts',
      '.pi/agent/extensions/review-jobs.ts',
      '.pi/agent/extensions/sdd-helpers.ts',
      '.pi/agent/extensions/startup-header.ts',
    ]);
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/code-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/spec-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/doc-updater.md');
    expect(skills.map((d) => d.key).filter((key) => key === '.pi/agent/skills/graphify/SKILL.md')).toHaveLength(1);
    expect(scripts.map((d) => d.key)).toContain('.pi/agent/scripts/safe-graphify-update.sh');
    // Pi-native first-class residents: the review skill and codeflare-commands extension
    // are emitted directly (not transformed from Claude), so the Pi manifest -> seed pipeline
    // must surface them.
    expect(skills.map((d) => d.key)).toContain('.pi/agent/skills/review/SKILL.md');
    expect(extensions.map((d) => d.key)).toContain('.pi/agent/extensions/codeflare-commands.ts');
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
    for (const agent of agents) {
      expect(agent.content).not.toContain('\nmodel:');
    }
    const codeflarePi = extensions.find((d) => d.key === '.pi/agent/extensions/codeflare-pi.ts');
    expect(codeflarePi?.content).toContain('pi.registerCommand("ctx"');
    expect(codeflarePi?.content).toContain('context-mode is disabled');

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

    expect(graphifyCloneAction('/repo', false)).toEqual({
      repo: '/repo',
      hasGraph: false,
      mode: 'missing-graph',
      choices: ['AST-only build', 'Full semantic + AST build', 'skip'],
    });
    expect(graphifyCloneAction('/repo', true)).toEqual({
      repo: '/repo',
      hasGraph: true,
      mode: 'existing-graph',
      choices: ['check freshness', 'AST-only update', 'Full semantic + AST refresh', 'skip'],
    });
    expect(graphifyPromptMarker('/home/user/workspace/r', 'session-1')).toBe('/tmp/codeflare-graphify-prompted-session-1_home_user_workspace_r');
    expect(isFailedGraphifyToolExecution({ status: 'error' })).toBe(true);
    expect(isFailedGraphifyToolExecution({ isError: false })).toBe(false);

    const decision = graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: false,
      findGitRoot: (path) => `${path}/.git-root`,
      hasGraph: (repo) => repo.endsWith('.git-root'),
    });
    expect(decision).toEqual({
      repo: '/home/user/workspace/r/.git-root',
      marker: '/tmp/codeflare-graphify-prompted-session-1_home_user_workspace_r_.git-root',
      action: {
        repo: '/home/user/workspace/r/.git-root',
        hasGraph: true,
        mode: 'existing-graph',
        choices: ['check freshness', 'AST-only update', 'Full semantic + AST refresh', 'skip'],
      },
    });
    expect(graphifyClonePromptDecision({
      command: 'git clone https://github.com/o/r.git',
      cwd: '/home/user/workspace',
      sessionId: 'session-1',
      failed: true,
      findGitRoot: () => undefined,
      hasGraph: () => false,
    })).toBeUndefined();
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
    expect(isPrBoundaryCommand('gh pr edit 12 --title metadata-only')).toBe(false);
    expect(isPrBoundaryCommand('gh pr view --json number')).toBe(false);
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

  it('REQ-AGENT-040: durable Pi review jobs sequence spec before docs and ack only after every lane completes', () => {
    const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
    expect(durableReviewInitialLanes(lanes)).toEqual(['code-reviewer', 'spec-reviewer']);
    expect(durableReviewEligibleLanes({
      lanes,
      completed: ['code-reviewer'],
      running: [],
      requestedAt: {},
      now: 1000,
      retryMs: 60_000,
    })).toEqual(['spec-reviewer']);
    expect(durableReviewEligibleLanes({
      lanes,
      completed: ['code-reviewer', 'spec-reviewer'],
      running: [],
      requestedAt: {},
      now: 1000,
      retryMs: 60_000,
    })).toEqual(['doc-updater']);
    expect(allDurableReviewLanesComplete(lanes, ['code-reviewer', 'spec-reviewer'])).toBe(false);
    expect(allDurableReviewLanesComplete(lanes, ['code-reviewer', 'spec-reviewer', 'doc-updater'])).toBe(true);
  });

  it('REQ-AGENT-040 / REQ-AGENT-054: durable Pi review job recovery does not treat orphaned persisted running state as active and keeps failed lanes unacked', () => {
    expect(recoverDurableReviewLaneState({
      lane: 'code-reviewer',
      current: { lane: 'code-reviewer', status: 'failed', startedAt: 5, completedAt: 6, error: 'timeout' },
      resultExists: false,
      activeInMemory: false,
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
    expect(recoverDurableReviewLaneState({
      lane: 'code-reviewer',
      current: { lane: 'code-reviewer', status: 'running', startedAt: 10, transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/code-reviewer.jsonl' },
      resultExists: false,
      activeInMemory: false,
    })).toEqual({
      lane: 'code-reviewer',
      status: 'pending',
      startedAt: 10,
      transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/code-reviewer.jsonl',
    });
    expect(recoverDurableReviewLaneState({
      lane: 'spec-reviewer',
      current: { lane: 'spec-reviewer', status: 'running', startedAt: 20 },
      resultExists: false,
      activeInMemory: true,
    })).toEqual({ lane: 'spec-reviewer', status: 'running', startedAt: 20 });
    expect(recoverDurableReviewLaneState({
      lane: 'spec-reviewer',
      current: { lane: 'spec-reviewer', status: 'completed', startedAt: 20, completedAt: 30, transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/spec-reviewer.jsonl' },
      resultExists: false,
      activeInMemory: false,
    })).toEqual({
      lane: 'spec-reviewer',
      status: 'pending',
      startedAt: 20,
      completedAt: 30,
      transcriptPath: '/repo/.git/codeflare-review-jobs/head/transcripts/spec-reviewer.jsonl',
    });
    expect(recoverDurableReviewLaneState({
      lane: 'doc-updater',
      current: { lane: 'doc-updater', status: 'running', startedAt: 30 },
      resultExists: true,
      resultPath: '/repo/.git/sdd-review-results/head/doc-updater.md',
      activeInMemory: false,
    })).toEqual({
      lane: 'doc-updater',
      status: 'completed',
      startedAt: 30,
      resultPath: '/repo/.git/sdd-review-results/head/doc-updater.md',
    });
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

  it('REQ-AGENT-053: hidden autofix requests send one follow-up only for actionable findings and only after marker claim', () => {
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const sender = { sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) };

    sendReviewAutofixRequest(sender, '/repo/codeflare', 'abc123');
    expect(sent).toEqual([
      {
        message: {
          customType: 'codeflare-review-autofix-request',
          content: [
            'Fix legitimate PR-boundary review findings for codeflare at abc123.',
            'Use the merged review summary immediately above as the actionable finding list.',
            'If the user has explicitly said not to automatically fix/implement this round, or to wait for GO/approval, do not edit, commit, or push; present the findings and wait for their command.',
            'Otherwise, fix all legitimate MEDIUM, HIGH, and CRITICAL findings only.',
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
      claim: () => true,
    })).toBe(true);
    expect(sent).toHaveLength(1);

    sent.length = 0;
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 0, medium: 0, low: 1 } }],
      claim: () => true,
    })).toBe(false);
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      claim: () => false,
    })).toBe(false);
    expect(requestReviewAutofixForRows({
      sender,
      repo: '/repo/codeflare',
      head: 'abc123',
      rows: [{ counts: { critical: 0, high: 1, medium: 0, low: 0 } }],
      suppress: true,
      claim: () => true,
    })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('REQ-AGENT-053: review autofix follows the latest explicit user auto/manual directive', () => {
    expect(reviewAutofixModeFromUserMessages(['do not auto fix next round', 'review summary arrived'])).toBe('manual');
    expect(reviewAutofixModeFromUserMessages(['do not automatically implement', 'GO, implement findings'])).toBe('auto');
    expect(reviewAutofixModeFromUserMessages(['ordinary review discussion'])).toBe('unset');
  });

  it('REQ-AGENT-053: durable Pi review severity helpers identify actionable findings for the fix loop', () => {
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
  });

  it('REQ-AGENT-040: durable Pi review job paths are under .git and result paths stay on the existing review surface', () => {
    expect(durableReviewJobDir('/repo', 'abc123')).toBe('/repo/.git/codeflare-review-jobs/abc123');
  });

  it('REQ-AGENT-053 AC8: durable review lanes load graphify always, context-mode only when enabled, never subagents', () => {
    const enabledCtx = [
      'npm:@gaodes/pi-graphify@0.2.2',
      'npm:@gotgenes/pi-subagents@7.8.1',
      'npm:context-mode@1.0.151',
    ];
    // graphify always; context-mode enabled (bare string); subagents never.
    expect(laneExtensionSources(enabledCtx)).toEqual([
      'npm:@gaodes/pi-graphify@0.2.2',
      'npm:context-mode@1.0.151',
    ]);

    const disabledCtx = [
      'npm:@gaodes/pi-graphify@0.2.2',
      'npm:@gotgenes/pi-subagents@7.8.1',
      { source: 'npm:context-mode@1.0.151', extensions: [], skills: [] },
    ];
    // context-mode in disabled filter form -> only graphify.
    expect(laneExtensionSources(disabledCtx)).toEqual(['npm:@gaodes/pi-graphify@0.2.2']);

    // object graphify entry without an extensions filter is still enabled.
    expect(laneExtensionSources([{ source: 'npm:@gaodes/pi-graphify@0.2.2' }])).toEqual([
      'npm:@gaodes/pi-graphify@0.2.2',
    ]);

    // empty / unrelated packages -> nothing.
    expect(laneExtensionSources([])).toEqual([]);
    expect(laneExtensionSources(['npm:@gotgenes/pi-subagents@7.8.1', '', { source: '' }])).toEqual([]);
  });

  it('REQ-AGENT-055 AC4-AC5: Pi review enforcement selects the unreviewed incremental review base', () => {
    const previous = {
      head: 'old-head',
      reviewBase: 'first-unreviewed-base',
      lanes: ['code-reviewer', 'spec-reviewer'],
      completed: ['code-reviewer'],
    };
    expect(reusablePendingReview(previous, 'new-head', (ancestor, current) => ancestor === 'old-head' && current === 'new-head')).toBe(previous);
    expect(selectReviewBase({ previous, lastAck: 'last-ack', previousRemoteHead: 'remote-prev' })).toBe('first-unreviewed-base');
    expect(selectReviewBase({
      previous: { ...previous, reviewBase: undefined },
      lastAck: 'last-ack',
      previousRemoteHead: 'remote-prev',
    })).toBeUndefined();
    expect(selectReviewBase({
      previous: { ...previous, completed: ['code-reviewer', 'spec-reviewer'] },
      lastAck: 'last-ack',
      previousRemoteHead: 'remote-prev',
    })).toBe('old-head');
    expect(reusablePendingReview(previous, 'rebased-head', () => false)).toBeUndefined();
    // A remote-tracking reflog entry alone is not evidence that the prior PR contents were reviewed.
    // Without an ack or completed previous review, keep reviewBase undefined so the next review covers the full PR diff.
    expect(selectReviewBase({ previous: undefined, lastAck: undefined, previousRemoteHead: 'remote-prev' })).toBeUndefined();
  });

  it('REQ-AGENT-023: Pi native runtime assets include graphify package, MCP config, and skill override', () => {
    const keys = new Set(AGENTS_SEEDED_CONFIGS.map((doc) => doc.key));
    expect(keys.has('.pi/agent/mcp.json')).toBe(true);
    expect(keys.has('.pi/agent/npm/package.json')).toBe(true);
    expect(keys.has('.pi/agent/npm/package-lock.json')).toBe(true);
    expect(keys.has('.pi/agent/skills/graphify/SKILL.md')).toBe(true);
    expect(keys.has('.pi/agent/scripts/safe-graphify-update.sh')).toBe(true);
    const piPackage = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.pi/agent/npm/package.json');
    expect(piPackage?.content).toContain('"@gaodes/pi-graphify": "0.2.2"');
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

  it('consult-llm skill is excluded from all non-Claude agents', () => {
    const nonClaude = AGENTS_SEEDED_CONFIGS.filter((d) => !d.key.startsWith('.claude/'));
    for (const doc of nonClaude) {
      expect(doc.key).not.toContain('consult-llm');
    }
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

  it('REQ-VAULT-003: stableId produces deterministic SHA-256 vault IDs', () => {
    const a = stableId('test/path.md');
    expect(a).toBe(stableId('test/path.md'));
    expect(a).not.toBe(stableId('other/path.md'));
    expect(a).toMatch(/^vault:[0-9a-f]{24}$/);
  });

  it('REQ-VAULT-003: memory-vault.ts has Claude-compatible in-flight sentinel to prevent double extraction', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('VAULT_INFLIGHT');
    expect(mv?.content).toContain('vault-extract.in-flight');
    expect(mv?.content).toContain('VAULT_EXTRACT_INFLIGHT_TTL_MS');
  });

  it('REQ-VAULT-004: titleFor extracts first heading or falls back to filename', () => {
    expect(titleFor('/vault/Notes/test.md', '# My Title\nsome content')).toBe('My Title');
    expect(titleFor('/vault/Notes/test.md', 'no heading here')).toBe('test.md');
    expect(titleFor('/vault/Docs/report.pdf', '')).toBe('report.pdf');
  });

  it('REQ-VAULT-004: memory-vault.ts extracts wikilink concept nodes and non-text document nodes', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('concept:');
    expect(mv?.content).toContain('mentions');
    expect(mv?.content).toContain('"document"');
    expect(mv?.content).toContain('isText ? "note" : "document"');
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

  it('REQ-AGENT-023: Pi safe-graphify-update.sh includes RLIMIT_AS memory cap', () => {
    const script = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/scripts/safe-graphify-update.sh');
    expect(script?.content).toContain('ulimit -v');
    expect(script?.content).toContain('GRAPHIFY_SAFE_RLIMIT_KB');
  });

  it('REQ-AGENT-049 AC1: PRESEED_CONTENT_HASH is a deterministic 16-char hex string', () => {
    expect(PRESEED_CONTENT_HASH).toMatch(/^[0-9a-f]{16}$/);
    const { createHash } = require('node:crypto');
    const sorted = [...AGENTS_SEEDED_CONFIGS].sort((a, b) => a.key.localeCompare(b.key));
    const recomputed = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
    expect(PRESEED_CONTENT_HASH).toBe(recomputed);
  });
});

describe('REQ-AGENT-031 consult-llm invocation behaviour (provider dialog + latest-flagship model)', () => {
  function consultLlmSkill(): string {
    const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.claude/skills/consult-llm/SKILL.md');
    expect(doc, 'consult-llm SKILL.md must be bundled in the Claude seed').toBeTruthy();
    return doc!.content;
  }

  it('AC4: skill mandates an AskUserQuestion provider dialog naming OpenAI + Gemini', () => {
    const body = consultLlmSkill();
    expect(body).toContain('AskUserQuestion');
    expect(body).toMatch(/OpenAI/);
    expect(body).toMatch(/Gemini/);
    expect(body).toMatch(/provider/i);
  });

  it('AC5: skill requires an explicit latest-flagship model and forbids the MCP server default', () => {
    const body = consultLlmSkill();
    expect(body.toLowerCase()).toContain('latest flagship');
    expect(body).toContain('/v1/models');
    expect(body).toContain('/v1beta/models');
    expect(body.toLowerCase()).toMatch(/never rely on the .*default|never the (mcp )?server default|never let the call fall back/);
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
