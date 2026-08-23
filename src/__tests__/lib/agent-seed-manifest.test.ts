import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, RETIRED_PRESEED_KEYS } from '../../lib/agent-seed.generated';
import { attributionBlockReason, isLocalBuildCommand, isManagedSafeLocalCheckCommand, localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';
import { DEBUG_WORKFLOW, DEPLOY_WORKFLOW, BRAINSTORM_WORKFLOW, commandInstructions, deployTarget } from '../../../preseed/agents/pi/extensions/commands-helpers';
import { sddCommandDecision, type SddRepoState } from '../../../preseed/agents/pi/extensions/sdd-helpers';

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

describe('REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)', () => {
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
      // consult-llm is Pro-only: manifest.json pins both agents' skills to
      // ['advanced'] (this assertion previously expected default+advanced and
      // never ran — the file was one of the silently-dead collection-crash
      // casualties the old grep guard masked).
      expect([...(doc?.modes ?? [])].sort(), key).toEqual(['advanced']);
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
    for (const cmd of ['npm run build', 'pnpm test', 'yarn lint', 'bun run typecheck', 'npm run dev', 'pytest -q', 'vitest run', 'go test ./...', 'cargo test', 'tsc -p .', 'eslint .', 'oxlint', 'biome check .', './node_modules/.bin/biome check .', 'npx biome check .', 'npx @biomejs/biome check .', "npx --call 'biome check .'", "npx --call='biome check .'", "npx -c 'biome check .'", 'node --check script.mjs', 'prettier -w .', 'wrangler dev']) {
      expect(isLocalBuildCommand(cmd), cmd).toBe(true);
    }
    expect(isLocalBuildCommand('git status')).toBe(false);
    expect(isLocalBuildCommand('npm run deploy')).toBe(false);
    expect(isLocalBuildCommand('rg biome package.json')).toBe(false);
    expect(isLocalBuildCommand("echo 'node --check'")).toBe(false);
    expect(isLocalBuildCommand('git commit -m "document biome and node --check"')).toBe(false);
  });

  it('AC4: ignores blocked tool names inside heredoc payloads but still checks commands after them', () => {
    const noteWrite = [
      "cat > /tmp/note.md <<'EOF'",
      'The failing path was vitest.workers.config.ts.',
      'The old command was npm test.',
      'EOF',
      'graphify global add graph.json --as user_vault',
    ].join('\n');
    expect(isLocalBuildCommand(noteWrite)).toBe(false);
    expect(isLocalBuildCommand(`${noteWrite}\nvitest run`)).toBe(true);
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

  it('REQ-AGENT-157 AC1: allows only a managed safe-check wrapper invocation with an optional leading cd', () => {
    const pi = 'node ~/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs oxlint src';
    const claude = 'node "$HOME/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs" eslint .';
    expect(isManagedSafeLocalCheckCommand(pi)).toBe(true);
    expect(isManagedSafeLocalCheckCommand(claude)).toBe(true);
    expect(isManagedSafeLocalCheckCommand(`cd /workspace/repo && ${pi}`)).toBe(true);
    for (const separator of [';', '||', '&', '\n']) {
      expect(isManagedSafeLocalCheckCommand(`cd /workspace/repo${separator}${pi}`), separator).toBe(false);
    }
    expect(isManagedSafeLocalCheckCommand(`cd /workspace/repo && ${pi} && npm test`)).toBe(false);
    expect(isManagedSafeLocalCheckCommand(`${pi} && npm test`)).toBe(false);
    expect(isManagedSafeLocalCheckCommand(`${pi} > lint.log`)).toBe(false);
    expect(isManagedSafeLocalCheckCommand('node ./scripts/safe-local-check.mjs oxlint src')).toBe(false);
  });

  it('REQ-AGENT-157 AC2: the managed wrapper bypasses the local-lint block without consuming the user sentinel', () => {
    let consumed = false;
    const fs = { existsSync: () => true, unlinkSync: () => { consumed = true; } };
    const command = 'node ~/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs oxlint src';
    expect(localBuildBlockReason(command, fs)).toBeUndefined();
    expect(consumed).toBe(false);
    expect(localBuildBlockReason('oxlint src', { existsSync: () => false, unlinkSync: () => undefined }))
      .toMatch(/safe-local-checks/);
    expect(localBuildBlockReason(`${command} > lint.log`, { existsSync: () => false, unlinkSync: () => undefined }))
      .toMatch(/safe-local-checks/);
    const syntax = 'node ~/.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs syntax script.mjs';
    expect(localBuildBlockReason(`${syntax} > syntax.log`, { existsSync: () => false, unlinkSync: () => undefined }))
      .toMatch(/safe-local-checks/);
    expect(localBuildBlockReason(`${syntax} && printf done`, { existsSync: () => false, unlinkSync: () => undefined }))
      .toMatch(/safe-local-checks/);
  });

  it('REQ-AGENT-157 AC3: seeds one managed safe-check skill and wrapper for each runtime and mode', () => {
    const capabilities = new Map([
      ['.claude/skills/safe-local-checks/SKILL.md', 'text/markdown; charset=utf-8'],
      ['.claude/skills/safe-local-checks/scripts/safe-local-check.mjs', 'text/javascript; charset=utf-8'],
      ['.pi/agent/skills/safe-local-checks/SKILL.md', 'text/markdown; charset=utf-8'],
      ['.pi/agent/skills/safe-local-checks/scripts/safe-local-check.mjs', 'text/javascript; charset=utf-8'],
    ]);
    for (const [key, contentType] of capabilities) {
      const documents = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === key);
      expect(documents).toHaveLength(1);
      expect(documents[0]?.contentType).toBe(contentType);
      expect(documents[0]?.modes).toEqual(['default', 'advanced']);
    }
  });

  it('REQ-AGENT-157 AC3: permanently loaded policy stays bounded', () => {
    const claudeRules = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === '.claude/rules/no-local-builds.md');
    const piInstructions = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === '.pi/agent/AGENTS.md');
    expect(claudeRules).toHaveLength(1);
    expect(claudeRules[0]?.content.length).toBeLessThan(400);
    expect(piInstructions).toHaveLength(2);
    for (const instructions of piInstructions) {
      const permanentlyLoadedPolicy = instructions.content.split('\n## Skills\n')[0] ?? '';
      expect(permanentlyLoadedPolicy.length).toBeLessThan(4_500);
    }
  });

});

describe('Retired preseed keys', () => {
  it('never lists a key the current build still seeds', () => {
    // Seed cleanup derives its delete list from the generated set, so a file
    // dropped from the manifest is never queued for deletion and survives in
    // the bucket beside whatever replaced it. RETIRED_PRESEED_KEYS closes that
    // gap, which makes the inverse the dangerous mistake: a path listed as
    // retired while still live would be deleted immediately after being
    // written. This is the assertion that catches it.
    const live = new Set(AGENTS_SEEDED_CONFIGS.map((doc) => doc.key));
    for (const key of RETIRED_PRESEED_KEYS) {
      expect(live.has(key), `${key} is retired but still in the generated seed`).toBe(false);
    }
  });

  it('retires the legacy ~/.claude/hooks/ copies the seed no longer owns', () => {
    // Two mechanisms reclaim a dropped file: the stale-marker sweep, which needs
    // the object to still carry a marker, and this list. A file the container
    // wrote itself and rclone carried to R2 has no marker and was never a seeded
    // key, so the sweep cannot see it and the walk that compiled this list could
    // not have found it - enumeration is the only route left. The two
    // enforce-ctx-mode.sh copies are that pair: one was a real seeded key, the
    // legacy hooks/ copy never was and outlived it.
    expect(RETIRED_PRESEED_KEYS).toContain('.claude/hooks/enforce-ctx-mode.sh');
    expect(RETIRED_PRESEED_KEYS).toContain(
      '.claude/plugins/context-mode/scripts/enforce-ctx-mode.sh',
    );
    // Retiring by name is only safe while the build seeds nothing into that
    // directory - a new hooks/ key would be written and then deleted by name.
    const liveHooks = AGENTS_SEEDED_CONFIGS.filter((doc) =>
      doc.key.startsWith('.claude/hooks/'),
    ).map((doc) => doc.key);
    expect(liveHooks).toEqual([]);
  });

  it('lists the rules absorbed into the engineering constitution', () => {
    // Their content now ships inside the constitution; leaving the standalone
    // copies in the bucket would deliver the same policy twice.
    for (const key of [
      '.claude/rules/karpathy.md',
      '.claude/rules/common/coding-style.md',
      '.claude/rules/graph-first.md',
    ]) {
      expect(RETIRED_PRESEED_KEYS).toContain(key);
    }
    const constitution = AGENTS_SEEDED_CONFIGS.find(
      (doc) => doc.key === '.claude/rules/engineering-constitution.md',
    );
    // Assert a load-bearing sentence from each absorbed rule, not the heading:
    // emptying a section to a bare heading while the standalone rule keeps
    // being deleted from every bucket is exactly the policy loss this guards.
    expect(constitution!.content).toMatch(/^## Working principles$/m);
    expect(constitution!.content).toMatch(/Don't assume and don't hide confusion/);
    expect(constitution!.content).toMatch(/^## Coding concretes$/m);
    expect(constitution!.content).toMatch(/Never set a field to `undefined`/);
    expect(constitution!.content).toMatch(/^## Graph first$/m);
    expect(constitution!.content).toMatch(/graphify-out\/graph\.json/);
  });
});

describe('Reviewer agents can access their enforce policy', () => {
  // The PR reviewers carry their policy instead of fetching it. An agent holding
  // the Skill tool is handed a listing of every installed skill before it starts
  // and spends a turn fetching what it already needed, which is what made a lane
  // cost as much on a diff it owned nothing in as on one it did. tdd-guide is a
  // working agent, not a PR lane, and still discovers skills at runtime.
  // Spine only for the lanes whose conditional policy is large: spec-reviewer and
  // doc-updater `cat` theirs when the condition fires, so carrying 20 KB inline
  // would charge every run for the rare case. code-reviewer is the exception --
  // tdd-enforce is its ONLY conditional policy, and its document states the lane
  // has none to fetch, so a `cat` there would be a bug rather than a capability.
  const LANE_SKILLS: Record<string, string[]> = {
    'code-reviewer': ['review-scope', 'tdd-enforce', 'code-review-checklist'],
    'spec-reviewer': ['review-scope', 'spec-enforce', 'spec-enforce-ac', 'spec-enforce-truth'],
    'doc-updater': ['review-scope', 'doc-enforce', 'doc-enforce-lanes'],
  };

  it('every Claude PR reviewer embeds its lane policy instead of discovering it', () => {
    for (const [name, skills] of Object.entries(LANE_SKILLS)) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc, `.claude/agents/${name}.md should be seeded`).toBeTruthy();
      const embedded = [...doc!.content.matchAll(/<embedded-skill name="([^"]+)">/g)].map((m) => m[1]);
      expect(embedded, `${name} must embed exactly its lane policy`).toEqual(skills);
      // Body identity, not a delimiter probe: embedding is now the sole
      // policy-delivery path for these lanes, so a truncated or stale body is
      // exactly the regression that matters. Same check the Pi tree already has.
      for (const skill of skills) {
        const source = AGENTS_SEEDED_CONFIGS.find(
          (d) => d.key === `.claude/skills/${skill}/SKILL.md`,
        );
        expect(source, `${skill} must be seeded for Claude`).toBeTruthy();
        const body = doc!.content.match(
          new RegExp(`<embedded-skill name="${skill}">\\n([\\s\\S]*?)</embedded-skill>`),
        )?.[1];
        expect(body, `${name} embedded ${skill} must match the seeded skill byte-for-byte`).toBe(
          source!.content,
        );
      }
    }
  });

  it('tdd-guide still reaches its enforce skill through the Skill tool', () => {
    const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.claude/agents/tdd-guide.md');
    expect(doc).toBeTruthy();
    expect(JSON.parse(frontmatter(doc!.content).tools) as string[]).toContain('Skill');
  });

  // Carry what fires on almost every run; fetch what usually does not. The
  // split is by FIRE RATE, not by whether a policy is nominally conditional:
  // spec-enforce-ac is conditional on ACs being touched, and a spec diff
  // touches ACs nearly every time, so it is carried.
  //
  // This reverses an earlier measurement recorded here, and the reversal is the
  // point. On 2026-07-26 (8d9635a) embedding spec-enforce-ac + -truth took the
  // spec lane 10 turns -> 16. Post-eac3d97 it takes 6 -> 1, reproduced on two
  // different fresh ranges. Both numbers were honest; eac3d97 landed in between
  // and fixed a reference resolver that ran 283s against a 60s bound on one
  // transport, so the lane had been dripping to rebuild evidence it never
  // received. Re-measure after any change to what a lane is handed -- a policy
  // sizing rule is only valid against the evidence pipeline it was measured on.
  //
  // Both halves are asserted, because the fetch is the half that fails silently:
  // a policy that is neither embedded nor reachable is enforcement quietly lost.
  it('REQ-AGENT-105: large conditional policy is fetched, small always-applicable policy is embedded', () => {
    // What is still fetched: inert unless a canonical-shape file is in scope,
    // and only when an Implemented REQ's docs are touched. doc-enforce-lanes
    // left this list because it runs per file in the diff -- it always fires.
    const CONDITIONAL = ['doc-enforce-shape', 'doc-enforce-truth'];
    for (const name of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc, `.claude/agents/${name}.md should be seeded`).toBeTruthy();
      for (const conditional of CONDITIONAL) {
        expect(
          doc!.content.includes(`# ${conditional}`) || doc!.content.includes(`name: ${conditional}`),
          `${name} must not embed the large conditional policy ${conditional}`,
        ).toBe(false);
      }
    }
    for (const conditional of CONDITIONAL) {
      expect(
        AGENTS_SEEDED_CONFIGS.some((d) => d.key === `.claude/skills/${conditional}/SKILL.md`),
        `${conditional} is fetched at runtime, so it must be seeded at the path the prompt names`,
      ).toBe(true);
    }
    // The prompts resolve the config dir rather than hardcoding ~/.claude: under
    // CLAUDE_CONFIG_DIR a hardcoded cat fails and the lane runs with no
    // enforcement layer at all, which is silent rather than loud.
    // Only a lane that still fetches something needs the fetch form, and it
    // must resolve the config dir rather than hardcoding ~/.claude.
    for (const name of ['doc-updater']) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc!.content, `${name} must resolve the config dir when fetching policy`)
        .toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/');
    }
  });

  it('REQ-AGENT-086 AC1/AC7: Claude PR reviewers carry the packet transport and no repository-wide scan tools', () => {
    // Something has to keep raw scan output out of reviewer context. It used to
    // be indexed retrieval; stripping that without a replacement regressed
    // review cost by an order of magnitude. It is now the review-scope packet
    // CLI, which returns lane-owned hunks and exact changed-input ranges. This
    // asserts the replacement in both directions: the transport must be
    // reachable, and the unbounded-scan tools it replaces must be absent. A
    // regression either way fails here.
    for (const name of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc, `.claude/agents/${name}.md should be seeded`).toBeTruthy();
      const tools = JSON.parse(frontmatter(doc!.content).tools) as string[];

      // Bash and nothing else. Every other grant is a way to go looking for
      // evidence the packet already carries or policy the agent already holds,
      // and each one costs a tool schema in the prompt before the first turn.
      expect(tools, `${name} must be bash-only`).toEqual(['Bash']);

      expect(
        doc!.content,
        `${name} must invoke the seeded packet CLI`,
      ).toContain('skills/review-scope/scripts/build-review-packet.mjs');
      expect(doc!.content, `${name} must carry the packet section`).toMatch(
        /^## Your lane packet$/m,
      );
    }

    const skill = AGENTS_SEEDED_CONFIGS.find(
      (d) => d.key === '.claude/skills/review-scope/SKILL.md',
    );
    expect(skill, 'review-scope SKILL.md must be seeded for Claude').toBeTruthy();
    expect(skill!.content).toContain('~/.claude/skills/review-scope/scripts/build-review-packet.mjs');
    const script = AGENTS_SEEDED_CONFIGS.find(
      (d) => d.key === '.claude/skills/review-scope/scripts/build-review-packet.mjs',
    );
    expect(script, 'the packet CLI the reviewers invoke must be seeded alongside it').toBeTruthy();
  });

  it('REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract', () => {
    // The seeded prompt files ARE the enforcement surface for the handoff
    // contract: reviewers report without writing (AC3), the root alone
    // persists triage (AC4) and applies fixes (AC5). Removing the binding
    // sections from the generated seed must fail here.
    const reviewerBindings: Array<[string, RegExp]> = [
      ['.claude/agents/code-reviewer.md', /## Operating Mode: Research \+ Report/],
      ['.claude/agents/spec-reviewer.md', /## REPORT-ONLY \(binding/],
      ['.claude/agents/doc-updater.md', /## REPORT-ONLY \(binding/],
    ];
    for (const [key, pattern] of reviewerBindings) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === key);
      expect(doc, `${key} should be seeded`).toBeTruthy();
      expect(doc!.content).toMatch(pattern);
    }
    const reviewCommand = AGENTS_SEEDED_CONFIGS.find((d) => d.key === '.claude/commands/review.md');
    expect(reviewCommand, '.claude/commands/review.md should be seeded').toBeTruthy();
    // Structural marker, not prose: the binding root-ownership section (AC4/AC5)
    // must survive seed generation; its wording may evolve freely underneath.
    expect(reviewCommand!.content).toMatch(/^## Review ownership \(binding\)$/m);
  });

  it('REQ-AGENT-086 AC6: reviewer effort pins are seeded for Claude and stripped from transforms', () => {
    const expectedEffort: Record<string, string> = {
      'code-reviewer': 'medium',
      'spec-reviewer': 'medium',
      'doc-updater': 'medium',
    };
    for (const [name, effort] of Object.entries(expectedEffort)) {
      const doc = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `.claude/agents/${name}.md`);
      expect(doc, `.claude/agents/${name}.md should be seeded`).toBeTruthy();
      expect(frontmatter(doc!.content).effort, `${name} effort pin`).toBe(effort);
      // Transformed runtimes have no effort frontmatter key; it must be stripped.
      for (const prefix of ['.pi/agent/agents', '.gemini/agents']) {
        const transformed = AGENTS_SEEDED_CONFIGS.find((d) => d.key === `${prefix}/${name}.md`);
        if (transformed) {
          expect(transformed.content, `${prefix}/${name}.md must not carry effort`).not.toMatch(/^effort:/m);
        }
      }
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