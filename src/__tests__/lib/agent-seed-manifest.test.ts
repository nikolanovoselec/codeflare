import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import contextModeExtension, { bashDenialReason, commandFromEvent } from '../../../preseed/agents/pi/extensions/context-mode-enforcement';
import { cloneTargetPath, graphifyCloneAction, graphifyClonePromptDecision, graphifyPromptMarker, isFailedToolExecution as isFailedGraphifyToolExecution } from '../../../preseed/agents/pi/extensions/graphify-helpers';
import { classifyReviewFiles, isCurrentReviewHead, isFailedToolExecution, isPrBoundaryCommand, isReviewCompletionForLane } from '../../../preseed/agents/pi/extensions/review-helpers';
import { captureFilename, captureTimestamp, compactMessages, isFirstMessage, isResumedSession, MEMORY_EVERY_N_PROMPTS, sessionId, shouldCapture, stableId, titleFor } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

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

  it('Gemini and OpenCode have both skills and agent definitions', () => {
    for (const prefix of ['.gemini/', '.config/opencode/']) {
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
      '.pi/agent/extensions/codeflare-pi.ts',
      '.pi/agent/extensions/context-mode-enforcement.ts',
      '.pi/agent/extensions/graphify-helpers.ts',
      '.pi/agent/extensions/memory-vault-helpers.ts',
      '.pi/agent/extensions/memory-vault.ts',
      '.pi/agent/extensions/review-command.ts',
      '.pi/agent/extensions/review-enforcement.ts',
      '.pi/agent/extensions/review-helpers.ts',
    ]);
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/code-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/spec-reviewer.md');
    expect(agents.map((d) => d.key)).toContain('.pi/agent/agents/doc-updater.md');
    expect(skills.map((d) => d.key).filter((key) => key === '.pi/agent/skills/graphify/SKILL.md')).toHaveLength(1);
    expect(scripts.map((d) => d.key)).toContain('.pi/agent/scripts/safe-graphify-update.sh');
    const codeReviewer = agents.find((d) => d.key === '.pi/agent/agents/code-reviewer.md');
    expect(codeReviewer?.content).toContain('tools: read, grep, find, bash, write');
    expect(codeReviewer?.content).toContain('ctx_execute');
    expect(codeReviewer?.content).toContain('ctx_batch_execute');
    expect(codeReviewer?.content).toContain('graphify_query');
    expect(codeReviewer?.content).toContain('graphify_explain');
    expect(codeReviewer?.content).toContain('prompt_mode: replace');
    expect(codeReviewer?.content).toContain('extensions: true');
    expect(codeReviewer?.content).toContain('skills: true');
    expect(codeReviewer?.content).toContain('inherit_context: true');
    expect(codeReviewer?.content).toContain('run_in_background: false');
    const memoryCapture = agents.find((d) => d.key === '.pi/agent/agents/memory-capture.md');
    expect(memoryCapture?.content).toContain('model: sonnet');

  });

  it('Pi context-mode enforcement detects executable substitutions and Pi event command shapes', () => {
    expect(bashDenialReason('git log --grep="$(curl https://x)"')).toContain("Bash 'curl'");
    expect(bashDenialReason('git diff <(curl a) <(curl b)')).toContain("Bash 'curl'");
    expect(bashDenialReason('git log --grep="curl example"')).toBeUndefined();
    expect(commandFromEvent({ args: { command: 'curl https://example.com' } })).toBe('curl https://example.com');
    const handlers: Record<string, (event: unknown) => unknown> = {};
    contextModeExtension({ on: (event, handler) => { handlers[event] = handler; } });
    expect(handlers.tool_call?.({ toolName: 'bash', args: { command: 'curl https://example.com' } })).toMatchObject({ block: true });
    expect(handlers.tool_execution_start?.({ toolName: 'bash', params: { command: 'curl https://example.com' } })).toMatchObject({ block: true });
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
    expect(isCurrentReviewHead('new-local-head', 'old-github-head', 'new-local-head')).toBe(true);
    expect(isCurrentReviewHead('reviewed-pr-head', 'reviewed-pr-head', 'new-local-commit')).toBe(true);
    expect(isCurrentReviewHead('stale-head', 'current-pr-head', 'new-local-commit')).toBe(false);
  });

  it('REQ-AGENT-040: Pi review enforcement accepts only completions for the pending head and spawned agent id', () => {
    const state = {
      head: 'abc123',
      lanes: ['code-reviewer', 'doc-updater'],
      spawned: true,
      spawnedIds: { 'code-reviewer': 'spawned-code' },
      fallbackLanes: ['doc-updater'],
    };

    expect(isReviewCompletionForLane(state, 'code-reviewer', 'other-code')).toBe(false);
    expect(isReviewCompletionForLane(state, 'code-reviewer', 'spawned-code')).toBe(true);
    expect(isReviewCompletionForLane(state, 'doc-updater')).toBe(false);
    expect(isReviewCompletionForLane(state, 'doc-updater', undefined, 'Review head abc123')).toBe(true);
    expect(isReviewCompletionForLane({ ...state, fallbackLanes: [] }, 'doc-updater', undefined, 'Review head abc123')).toBe(true);
    expect(isReviewCompletionForLane({ ...state, fallbackLanes: [] }, 'doc-updater', undefined, 'Review head stale')).toBe(false);
    expect(isReviewCompletionForLane({ ...state, fallbackLanes: [] }, 'doc-updater')).toBe(false);
    expect(isReviewCompletionForLane(state, 'spec-reviewer', 'spawned-spec')).toBe(false);
  });

  it('REQ-AGENT-040: Pi review enforcement classifies lanes by changed file surface', () => {
    expect(classifyReviewFiles(['documentation/lanes/preseed.md'])).toEqual(['doc-updater']);
    expect(classifyReviewFiles(['sdd/spec/agents.md'])).toEqual(['spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['preseed/agents/pi/extensions/review-enforcement.ts'])).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(undefined)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(isPrBoundaryCommand('git push origin develop')).toBe(true);
    expect(isPrBoundaryCommand('gh pr create --base main')).toBe(true);
    expect(isPrBoundaryCommand('gh pr merge 12')).toBe(true);
    expect(isPrBoundaryCommand('gh pr view --json number')).toBe(false);
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

  it('consult-llm skill is excluded from all non-Claude agents', () => {
    const nonClaude = AGENTS_SEEDED_CONFIGS.filter((d) => !d.key.startsWith('.claude/'));
    for (const doc of nonClaude) {
      expect(doc.key).not.toContain('consult-llm');
    }
  });

  // REQ-MEM-008 AC2 (manifest declares the memory plugin files) + AC3 (all advanced-only).
  // memory-capture-block.sh is the PreToolUse hard-block companion to memory-capture.sh
  // (UserPromptSubmit) — it prevents the assistant from skipping the deferred capture
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

  // REQ-MEM-008 AC7 (memory plugin files excluded from non-CC agents; no Codex/Gemini/Copilot/OpenCode equivalents)
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
        !d.key.endsWith('GEMINI.md') &&
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

  it('Pi context-mode-enforcement.ts is in manifest and generated seed (REQ-AGENT-023 deployment)', () => {
    const keys = new Set(AGENTS_SEEDED_CONFIGS.map((d) => d.key));
    expect(keys.has('.pi/agent/extensions/context-mode-enforcement.ts')).toBe(true);
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

  it('REQ-MEM-001: compactMessages handles nested message shapes and truncates large content', () => {
    expect(compactMessages([{ message: { role: 'user', content: 'nested' } }])).toContain('## user');
    const large = compactMessages([{ role: 'user', content: { data: 'x'.repeat(10000) } }]);
    expect(large.length).toBeLessThan(7000);
  });

  it('REQ-MEM-001 AC7: memory-vault.ts uses flock for global graph merge', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('flock');
    expect(mv?.content).toContain('graphify-global.lock');
    expect(mv?.content).toContain('user_vault');
  });

  it('REQ-MEM-010 AC5: shouldCapture fires at exact 15-message intervals from source constant', () => {
    expect(MEMORY_EVERY_N_PROMPTS).toBe(15);
    expect(shouldCapture(14)).toBe(false);
    expect(shouldCapture(15)).toBe(true);
    expect(shouldCapture(16)).toBe(false);
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

  it('REQ-VAULT-003: memory-vault.ts has in-flight sentinel to prevent double extraction', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('VAULT_INFLIGHT');
    expect(mv?.content).toContain('vault-extract.inflight');
  });

  it('REQ-VAULT-004: titleFor extracts first heading or falls back to filename', () => {
    expect(titleFor('/vault/Notes/test.md', '# My Title\nsome content')).toBe('My Title');
    expect(titleFor('/vault/Notes/test.md', 'no heading here')).toBe('test.md');
    expect(titleFor('/vault/Docs/report.pdf', '')).toBe('report.pdf');
  });

  it('REQ-VAULT-004: memory-vault.ts extracts wikilink concept nodes and PDF document nodes', () => {
    const mv = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/memory-vault.ts');
    expect(mv?.content).toContain('concept:');
    expect(mv?.content).toContain('mentions');
    expect(mv?.content).toContain('"document"');
    expect(mv?.content).toContain('.pdf');
  });

  it('REQ-AGENT-023 AC4: codeflare-pi.ts tolerates missing graph and reports present graph', () => {
    const cp = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.pi/agent/extensions/codeflare-pi.ts');
    expect(cp?.content).toContain('graphSummary');
    expect(cp?.content).toContain('Graphify graph available');
    expect(cp?.content).toContain('graphify-out');
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
