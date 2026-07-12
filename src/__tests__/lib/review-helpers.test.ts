import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ReviewLane = 'code-reviewer' | 'spec-reviewer' | 'doc-updater';
type BoundarySurfaces = { reminder: boolean; settled: boolean };
type TranscriptFacts = {
  boundary?: { toolUseId: string; command: string };
  bypassed: boolean;
  lanes: Record<ReviewLane, { state: 'missing' | 'in-flight' | 'terminal'; toolUseId?: string }>;
};
type PlannedReviewHelpers = {
  classifyReviewBoundaryCommand(command: string): BoundarySurfaces;
  isReviewTransitionSuspended(repo: string): boolean;
  requiredReviewLanes(input: { repo: string; ackHead?: string; head: string }): ReviewLane[];
  reviewTranscriptFacts(input: {
    sessionFile: string;
    requiredLanes: ReviewLane[];
    nowMs: number;
    inFlightMs: number;
  }): TranscriptFacts;
};

const ALL_LANES: ReviewLane[] = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const NOW = Date.parse('2026-07-12T12:10:00.000Z');
const roots: string[] = [];

async function plannedHelpers(): Promise<PlannedReviewHelpers> {
  return await import('../../../preseed/agents/pi/extensions/review-helpers') as unknown as PlannedReviewHelpers;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo: string, relativePath: string, contents: string): void {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function commit(repo: string, relativePath: string, contents: string, message: string): string {
  write(repo, relativePath, contents);
  git(repo, 'add', '--', relativePath);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function makeRepo(): { repo: string; base: string } {
  const repo = tempRoot('pi-review-helpers-');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@users.noreply.github.com');
  write(repo, 'sdd/README.md', '# fixture\n');
  write(repo, 'README.md', '# fixture\n');
  git(repo, 'add', 'sdd/README.md', 'README.md');
  git(repo, 'commit', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function sessionEntry(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type, id: randomUUID(), timestamp: '2026-07-12T12:00:00.000Z', ...fields };
}

function assistantTool(toolUseId: string, name: string, args: Record<string, unknown>, timestamp = '2026-07-12T12:00:00.000Z'): Record<string, unknown> {
  return sessionEntry('message', {
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolUseId, name, arguments: args }],
      provider: 'anthropic',
      model: 'fixture',
      usage: {},
      stopReason: 'toolUse',
      timestamp: Date.parse(timestamp),
    },
  });
}

function userMessage(content: string, timestamp = '2026-07-12T12:00:30.000Z'): Record<string, unknown> {
  return sessionEntry('message', { timestamp, message: { role: 'user', content, timestamp: Date.parse(timestamp) } });
}

function toolResult(toolUseId: string): Record<string, unknown> {
  return sessionEntry('message', {
    message: { role: 'toolResult', toolCallId: toolUseId, toolName: 'subagent', content: [{ type: 'text', text: 'started' }], isError: false },
  });
}

function notification(toolUseId: string, status = 'Done'): Record<string, unknown> {
  return sessionEntry('custom_message', {
    customType: 'subagent-notification',
    content: `<task-notification>\n<task-id>agent-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
    display: true,
  });
}

function writeSession(entries: Record<string, unknown>[]): string {
  const root = tempRoot('pi-review-session-');
  const sessionFile = join(root, 'session.jsonl');
  const header = { type: 'session', version: 3, id: randomUUID(), timestamp: '2026-07-12T11:59:00.000Z', cwd: root };
  writeFileSync(sessionFile, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return sessionFile;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Claude-equivalent review boundary helpers', () => {
  it('REQ-AGENT-063: distinguishes Claude-supported reminder and settled command surfaces', async () => {
    const { classifyReviewBoundaryCommand } = await plannedHelpers();
    const cases: Array<[string, BoundarySurfaces]> = [
      ['git push origin pi', { reminder: true, settled: true }],
      ['CI=1 git push origin pi', { reminder: true, settled: true }],
      ["printf '%s' 'git push origin pi'", { reminder: false, settled: false }],
      ['printf done; git push origin pi', { reminder: true, settled: true }],
      ['gh pr create --base main --title review', { reminder: true, settled: false }],
      ['gh pr edit 42 --base master', { reminder: true, settled: true }],
      ['gh pr merge 42', { reminder: false, settled: true }],
      ['gh pr edit 42 --base develop', { reminder: false, settled: false }],
      ['gh pr update-branch 42', { reminder: false, settled: false }],
      ['git -C /tmp/repo push origin pi', { reminder: false, settled: false }],
    ];

    expect(cases.map(([command, expected]) => [command, classifyReviewBoundaryCommand(command), expected]))
      .toEqual(cases.map(([command, expected]) => [command, expected, expected]));
  });

  it('REQ-AGENT-045/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition', async () => {
    const { isReviewTransitionSuspended } = await plannedHelpers();
    const root = tempRoot('pi-review-transition-root-');
    write(root, 'sdd/README.md', '# fixture\n');
    write(root, 'sdd/config.yml', 'transition: true\n');
    write(root, 'sdd/.init-triage.md', '## TRIAGE-001\n**Status:** Open\n');

    const nested = tempRoot('pi-review-transition-nested-');
    write(nested, 'sdd/README.md', '# fixture\n');
    write(nested, 'sdd/spec/config.yml', 'transition: true\n');
    write(nested, 'sdd/spec/.review-queue.md', '## TRIAGE-002\n**Status:** open\n');

    expect(isReviewTransitionSuspended(root)).toBe(true);
    expect(isReviewTransitionSuspended(nested)).toBe(true);

    write(root, 'sdd/.init-triage.md', '## TRIAGE-001\n**Status:** resolved\n');
    write(nested, 'sdd/spec/config.yml', 'transition: false\n');
    expect(isReviewTransitionSuspended(root)).toBe(false);
    expect(isReviewTransitionSuspended(nested)).toBe(false);
  });

  it('REQ-AGENT-040: classifies generated, docs, spec, source, and mixed commit ranges into reviewer lanes', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const cases: Array<{ path: string; expected: ReviewLane[] }> = [
      { path: 'graphify-out/graph.json', expected: [] },
      { path: 'documentation/security.md', expected: ['doc-updater'] },
      { path: 'sdd/spec/agents.md', expected: ['spec-reviewer', 'doc-updater'] },
      { path: 'src/lib/review.ts', expected: ALL_LANES },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { repo, base } = makeRepo();
      const head = commit(repo, testCase.path, `${index}\n`, `case ${index}`);
      expect(requiredReviewLanes({ repo, ackHead: base, head })).toEqual(testCase.expected);
    }

    const { repo, base } = makeRepo();
    write(repo, 'documentation/review.md', 'docs\n');
    write(repo, 'src/review.ts', 'source\n');
    git(repo, 'add', 'documentation/review.md', 'src/review.ts');
    git(repo, 'commit', '-m', 'mixed');
    expect(requiredReviewLanes({ repo, ackHead: base, head: git(repo, 'rev-parse', 'HEAD') })).toEqual(ALL_LANES);
  });

  it('REQ-AGENT-040: uses NUL-safe no-renames diffing so tricky names and source-to-doc renames cannot bypass code review', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const first = makeRepo();
    const sourceHead = commit(first.repo, 'src/original.ts', 'export {};\n', 'source');
    git(first.repo, 'mv', 'src/original.ts', 'documentation/original.md');
    git(first.repo, 'commit', '-m', 'rename source to docs');
    expect(requiredReviewLanes({ repo: first.repo, ackHead: sourceHead, head: git(first.repo, 'rev-parse', 'HEAD') })).toEqual(ALL_LANES);

    const second = makeRepo();
    const newlinePath = 'src/line\nbreak.ts';
    const newlineHead = commit(second.repo, newlinePath, 'export {};\n', 'newline path');
    expect(requiredReviewLanes({ repo: second.repo, ackHead: second.base, head: newlineHead })).toEqual(ALL_LANES);
  });

  it('REQ-AGENT-055: falls back to all lanes for malformed and non-ancestor acknowledgements', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const empty = makeRepo();
    git(empty.repo, 'commit', '--allow-empty', '-m', 'empty');
    expect(requiredReviewLanes({ repo: empty.repo, ackHead: empty.base, head: git(empty.repo, 'rev-parse', 'HEAD') })).toEqual(ALL_LANES);

    const { repo, base } = makeRepo();
    const head = commit(repo, 'documentation/review.md', 'docs\n', 'docs');
    expect(requiredReviewLanes({ repo, ackHead: 'not-a-sha', head })).toEqual(ALL_LANES);

    git(repo, 'checkout', '--orphan', 'unrelated');
    git(repo, 'rm', '-rf', '.');
    const unrelated = commit(repo, 'documentation/unrelated.md', 'docs\n', 'unrelated');
    expect(requiredReviewLanes({ repo, ackHead: base, head: unrelated })).toEqual(ALL_LANES);
  });
});

describe('native Pi transcript review facts', () => {
  it('REQ-AGENT-055: uses only public subagent calls after the latest settled boundary', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-old', 'bash', { command: 'git push origin pi' }, '2026-07-12T12:00:00.000Z'),
      assistantTool('code-old', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true }, '2026-07-12T12:01:00.000Z'),
      notification('code-old'),
      assistantTool('push-new', 'bash', { command: 'gh pr merge 42' }, '2026-07-12T12:05:00.000Z'),
      assistantTool('doc-new', 'subagent', { subagent_type: 'doc-updater', run_in_background: true }, '2026-07-12T12:06:00.000Z'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES, nowMs: NOW, inFlightMs: 5 * 60_000 });
    expect(facts.boundary).toEqual({ toolUseId: 'push-new', command: 'gh pr merge 42' });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'missing' },
      'spec-reviewer': { state: 'missing' },
      'doc-updater': { state: 'in-flight', toolUseId: 'doc-new' },
    });
  });

  it('REQ-AGENT-053/REQ-AGENT-059: correlates terminal native notifications by XML tool-use-id, not tool results or lifecycle events', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      assistantTool('code-1', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true }),
      toolResult('code-1'),
      sessionEntry('custom', { customType: 'subagents:completed', data: { toolCallId: 'code-1' } }),
      notification('different-id'),
      assistantTool('spec-1', 'subagent', { subagent_type: 'spec-reviewer', run_in_background: true }),
      notification('spec-1', 'Error'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES, nowMs: NOW, inFlightMs: 15 * 60_000 });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'in-flight', toolUseId: 'code-1' },
      'spec-reviewer': { state: 'terminal', toolUseId: 'spec-1' },
      'doc-updater': { state: 'missing' },
    });
  });

  it('REQ-AGENT-071: reports missing, recent in-flight, stale unmatched, and out-of-order terminal lanes independently', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }, '2026-07-12T12:00:00.000Z'),
      assistantTool('code-stale', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true }, '2026-07-12T12:00:30.000Z'),
      assistantTool('spec-recent', 'subagent', { subagent_type: 'spec-reviewer', run_in_background: true }, '2026-07-12T12:09:30.000Z'),
      notification('spec-recent'),
      assistantTool('doc-recent', 'subagent', { subagent_type: 'doc-updater', run_in_background: true }, '2026-07-12T12:09:45.000Z'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES, nowMs: NOW, inFlightMs: 5 * 60_000 });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'missing' },
      'spec-reviewer': { state: 'terminal', toolUseId: 'spec-recent' },
      'doc-updater': { state: 'in-flight', toolUseId: 'doc-recent' },
    });
  });

  it('REQ-AGENT-041: recognizes an explicit user bypass only when it follows the latest boundary', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const before = writeSession([
      userMessage('skip review'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
    ]);
    const after = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      userMessage('skip verification'),
    ]);

    expect(reviewTranscriptFacts({ sessionFile: before, requiredLanes: ALL_LANES, nowMs: NOW, inFlightMs: 5 * 60_000 }).bypassed).toBe(false);
    expect(reviewTranscriptFacts({ sessionFile: after, requiredLanes: ALL_LANES, nowMs: NOW, inFlightMs: 5 * 60_000 }).bypassed).toBe(true);
  });
});
