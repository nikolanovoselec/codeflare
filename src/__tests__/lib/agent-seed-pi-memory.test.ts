import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH, RETIRED_PRESEED_KEYS } from '../../lib/agent-seed.generated';
import { captureFilename, captureFilenameAt, captureTimestamp, compactMessages, isFirstMessage, isRealUserPrompt, isResumedSession, MEMORY_CAPTURE_MAX_TOTAL_CHARS, MEMORY_CAPTURE_MAX_TURN_CHARS, MEMORY_EVERY_N_PROMPTS, parseSessionMessages, realUserPromptCount, selectTurns, sessionId, shouldCapture, withCurrentPrompt } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

/**
 * Validates invariants of the generated agent seed configs.
 *
 * The generator script (generate-agent-seed.mjs) reads manifest.json and the
 * preseed file tree at build time, validates bidirectional consistency, and
 * embeds the result into AGENTS_SEEDED_CONFIGS. These tests verify the
 * generated output's runtime invariants without filesystem access (which
 * isn't available in the Workers vitest pool).
 */

// REQ-AGENT-026: Knowledge-Graph Persistence via Git
// REQ-AGENT-063: PR-Boundary Command Parsing
// REQ-BROWSER-003: Pi Native Browser Run Wrapper

describe('Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)', () => {
  it('REQ-MEM-001 AC4: captureTimestamp includes the resolved timezone offset', () => {
    const ts = captureTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}$/);
    const tsUtc = captureTimestamp('UTC');
    expect(tsUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\+0000$/);
  });

  it('REQ-MEM-001 AC4: captureFilename matches Claude\'s timestamp and short session-ID shape', () => {
    const fn = captureFilename('019fa5d1-04cc-7b7f-8fd7-b58a8c4dda6c');
    expect(fn).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}-8c4dda6c\.md$/);
  });

  it('REQ-MEM-001 AC4: same-second UUIDv7 sessions with a shared timestamp prefix get distinct filenames', () => {
    const timestamp = '2026-07-28T03-04-30+0200';
    const first = captureFilenameAt(timestamp, '019fa5d1-04cc-7b7f-8fd7-b58a8c4dda6c');
    const second = captureFilenameAt(timestamp, '019fa5d1-1234-7abc-8def-1234567890ab');

    expect(first).toBe(`${timestamp}-8c4dda6c.md`);
    expect(second).toBe(`${timestamp}-567890ab.md`);
    expect(first).not.toBe(second);
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

  it('REQ-MEM-001 AC2: Pi excludes synthetic envelopes and preserves genuine code-like prompts', () => {
    const messages = [
      { role: 'user', content: 'real prompt' },
      { role: 'user', content: '<div>real HTML question</div>' },
      { role: 'user', content: 'How does the "directive" field work?' },
      { role: 'user', content: 'What does subagent_type mean?' },
      { role: 'user', content: '<task-notification>done</task-notification>' },
      { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] },
      { role: 'assistant', content: 'reply' },
    ];
    expect(messages.map(isRealUserPrompt)).toEqual([true, true, true, true, false, false, false]);
    expect(realUserPromptCount(messages)).toBe(4);
    const compacted = compactMessages(messages);
    expect(compacted).toContain('real prompt');
    expect(compacted).toContain('<div>real HTML question</div>');
    expect(compacted).toContain('How does the "directive" field work?');
    expect(compacted).toContain('What does subagent_type mean?');
    expect(compacted).not.toContain('task-notification');
  });

  it('REQ-MEM-002 AC7: withCurrentPrompt counts the submitted prompt once for resume detection', () => {
    const prior = [{ role: 'user', content: 'older prompt' }, { role: 'assistant', content: 'older answer' }];
    const withCurrent = withCurrentPrompt(prior, 'current prompt');
    expect(realUserPromptCount(withCurrent)).toBe(2);
    expect(withCurrentPrompt(withCurrent, 'current prompt')).toHaveLength(withCurrent.length);
    expect(withCurrentPrompt(withCurrent, '<task-notification>x</task-notification>')).toHaveLength(withCurrent.length);
  });

  // compactMessages is the Pi transcript prefilter (memory-vault-helpers.ts): keep user +
  // assistant text only, drop tool/thinking blocks and already-captured prompts, then bound
  // the remaining retry window to 40 turns at 4000 chars each.
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

    it('keeps only the uncaptured interval after the successful user-prompt count', () => {
      const messages = [
        { role: 'user', content: 'captured-user-1' },
        { role: 'assistant', content: 'captured-answer-1' },
        { role: 'user', content: 'captured-user-2' },
        { role: 'assistant', content: 'captured-answer-2' },
        { role: 'user', content: 'new-user-3' },
        { role: 'assistant', content: 'new-answer-3' },
      ];
      const result = compactMessages(messages, 2);
      expect(result).not.toContain('captured-user-1');
      expect(result).not.toContain('captured-user-2');
      expect(result).toContain('captured-answer-2');
      expect(result).toContain('new-user-3');
      expect(result).toContain('new-answer-3');
    });

    it('spends the character budget newest-first when the window is long', () => {
      const turns = Array.from({ length: 120 }, (_, i) => ({ role: 'user', text: `turn-${i} ${'x'.repeat(5000)}` }));
      const kept = selectTurns(turns);
      const total = kept.reduce((sum, turn) => sum + turn.text.length, 0);
      // Both directions: the budget is a ceiling, and it is actually filled.
      // Keeping one turn would satisfy the ceiling on its own.
      expect(total).toBeLessThanOrEqual(MEMORY_CAPTURE_MAX_TOTAL_CHARS);
      expect(total).toBeGreaterThan(MEMORY_CAPTURE_MAX_TOTAL_CHARS - 6000);
      expect(kept.at(-1)!.text).toMatch(/^turn-119 /);
      expect(kept.some((turn) => turn.text.startsWith('turn-0 '))).toBe(false);
    });

    it('keeps every user prompt when the assistant turns exhaust the budget', () => {
      // Capture fires on a count of user prompts, so a payload that drops them
      // summarises a window without the instructions that defined it. The
      // assistant turns here cost twice the budget on their own.
      const messages = Array.from({ length: 80 }, (_, i) => (i % 2 === 0
        ? { role: 'user', content: `turn-${i}` }
        : { role: 'assistant', content: `turn-${i} ${'x'.repeat(25000)}` }));
      const result = compactMessages(messages);
      const count = (marker: string) => result.split(marker).length - 1;

      expect(count('## user\n')).toBe(40);
      expect(count('## assistant\n')).toBeGreaterThan(0);
      expect(count('## assistant\n')).toBeLessThan(40);
      expect(result).toContain('turn-79 ');
      expect(result).not.toContain('turn-1 ');
    });

    it('truncates a single turn longer than the per-turn cap', () => {
      const result = compactMessages([{ role: 'user', content: 'a'.repeat(24000) }]);
      const body = result.slice('## user\n'.length);
      expect(body.length).toBe(MEMORY_CAPTURE_MAX_TURN_CHARS);
    });
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
  });

  it('REQ-MEM-018: Pi extraction agents expose bounded frontmatter (native + transformed)', () => {
    // Two delivery paths, one invariant set. vault-extract is transformed and
    // gets these injected by the frontmatter adapter; memory-capture is a
    // pi-native file emitted verbatim and carries them by hand. The identity
    // line is per agent, so it is pinned per key rather than shared.
    const expectedDescription = {
      '.pi/agent/agents/memory-capture.md': 'Visible Pi memory capture worker.',
      '.pi/agent/agents/vault-extract.md': 'Visible Pi Vault extraction worker.',
    } as const;
    for (const [key, description] of Object.entries(expectedDescription)) {
      const agent = AGENTS_SEEDED_CONFIGS.find((document) => document.key === key);
      expect(agent?.modes).toEqual(['advanced']);
      const parsed = Object.fromEntries(
        (agent?.content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
          .split('\n')
          // First colon only. A frontmatter value may contain one, and the
          // description assertion below compares text far enough along the
          // line to be clipped by a parser that splits on every colon.
          .map((line) => {
            const at = line.indexOf(':');
            return at < 0 ? [line] : [line.slice(0, at), line.slice(at + 1).trim()];
          })
          .filter((parts) => parts.length === 2),
      );
      expect(parsed.run_in_background).toBe('true');
      expect(parsed.tools).toBe('bash');
      expect(parsed.thinking).toBe('medium');
      // The pi-native file never reaches the adapter, so every invariant the
      // adapter used to guarantee is pinned here instead -- the identity line
      // included, since the deleted branch injected that too and a hand edit
      // would otherwise drop or reword it with nothing failing.
      expect(parsed.prompt_mode).toBe('replace');
      expect(parsed.extensions).toBe('true');
      expect(parsed.description).toContain(description);
    }
  });

  // Pi's capture is a different transport on a different bound: the root hands
  // it an immutable execution snapshot and it gets four turns (AD103,
  // REQ-MEM-016), while Claude's runner inlines the transcript into the prompt
  // and gets six (AD124). Pi's document used to be produced by exact-string
  // replacement over Claude's prose, so an ordinary edit to the Claude agent
  // moved the anchors, the replacements silently no-oped, and Pi shipped
  // Claude's budget and Claude's transport with nothing to notice it. Both
  // halves are asserted, so re-linking the two documents fails here instead of
  // in a runtime nobody is looking at.
  it('REQ-MEM-016/AD103: Pi keeps its own capture budget and transport, independent of Claude', () => {
    const doc = (key: string) => AGENTS_SEEDED_CONFIGS.find((d) => d.key === key)?.content ?? '';
    const pi = doc('.pi/agent/agents/memory-capture.md');
    const claude = doc('.claude/agents/memory-capture.md');
    const budget = (content: string) => content.match(/Finish within (\w+) turns/)?.[1];

    expect(budget(pi)).toBe('four');
    expect(budget(claude)).toBe('six');

    // Claude-transport identifiers that must never reach Pi's contract.
    for (const claudeOnly of ['CAPTURE_REQUEST', 'BEGIN TRANSCRIPT', 'run-memory-capture.sh']) {
      expect(pi).not.toContain(claudeOnly);
    }
    // Pi's own delivery, which the stale replacements had dropped on the floor.
    expect(pi).toContain('immutable execution snapshot');
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
    // Mirrors computePreseedHash in scripts/generate-agent-seed.mjs, which cannot
    // be imported here: that module invokes generate() at import time and would
    // rewrite the generated seed mid-suite. Change the formula there and this
    // recomputation fails until it is changed to match.
    // The retired list is inside the hash so that shipping it triggers the
    // upgrade that applies it (REQ-STOR-019); recomputing without it would pass
    // only while the list stayed empty.
    const recomputed = createHash('sha256')
      .update(JSON.stringify({ documents: sorted, retired: RETIRED_PRESEED_KEYS }))
      .digest('hex')
      .slice(0, 16);
    expect(PRESEED_CONTENT_HASH).toBe(recomputed);
  });
});
