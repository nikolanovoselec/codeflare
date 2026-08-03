import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ReviewLane = 'code-reviewer' | 'spec-reviewer' | 'doc-updater';
type BoundaryEvent = 'push' | 'pr-create';
type BoundarySurfaces = {
  reminder: boolean;
  settled: boolean;
  event?: BoundaryEvent;
  pushSource?: string;
  pushTarget?: string;
  pushRemote?: string;
};
type TranscriptFacts = {
  boundary?: { toolUseId: string; command: string };
  reviewHead?: string;
  reviewRange?: string;
  reviewRepo?: string;
  reviewBranch?: string;
  reviewPrNumber?: number;
  reviewBase?: 'main' | 'master' | 'develop';
  reviewBoundaryToolUseId?: string;
  bypassed: boolean;
  ciLaunched: boolean;
  triageComplete: boolean;
  lanes: Record<ReviewLane, { state: 'missing' | 'in-flight' | 'terminal'; toolUseId?: string }>;
};
type PlannedReviewHelpers = {
  classifyReviewBoundaryCommand(command: string): BoundarySurfaces;
  isReviewTransitionSuspended(repo: string): boolean;
  requiredReviewLanes(input: { repo: string; ackHead?: string; head: string; prover?: string }): ReviewLane[];
  roundLimitReached(repo: string, lane: ReviewLane): boolean;
  reviewTranscriptFacts(input: {
    sessionFile: string;
    entries?: Record<string, unknown>[];
    requiredLanes: ReviewLane[];
    ciHead?: string;
  }): TranscriptFacts;
};

const ALL_LANES: ReviewLane[] = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
// Both runtimes decide an inert delta with this one program; the shell lane
// classifier is the other half of the parity contract.
const PROVER = join(process.cwd(), 'preseed/agents/claude/skills/review-scope/scripts/inert-source-delta.mjs');
const LANE_CLASSIFIER = join(process.cwd(), 'preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh');
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

function assistantText(content: string, timestamp = '2026-07-12T12:03:00.000Z'): Record<string, unknown> {
  return sessionEntry('message', {
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      provider: 'anthropic',
      model: 'fixture',
      usage: {},
      stopReason: 'stop',
      timestamp: Date.parse(timestamp),
    },
  });
}

function triageHeaderMessage(): Record<string, unknown> {
  return assistantText('| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |');
}

function triageMessage(): Record<string, unknown> {
  return assistantText('| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n|---|---|---|---|---|');
}

function toolResult(
  toolUseId: string,
  toolName = 'subagent',
  isError = false,
  options: { text?: string; details?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return sessionEntry('message', {
    message: {
      role: 'toolResult',
      toolCallId: toolUseId,
      toolName,
      content: [{ type: 'text', text: options.text ?? (isError ? 'failed' : 'ok') }],
      details: options.details,
      isError,
    },
  });
}

function reviewReminder(head: string, reviewRange: string, base = 'main'): Record<string, unknown> {
  return sessionEntry('custom_message', {
    customType: 'pr-boundary-launch-plan',
    content: `review_range=${reviewRange}`,
    details: {
      head,
      reviewRange,
      repo: '/workspace/repo',
      branch: 'pi',
      prNumber: 42,
      base,
      boundaryToolUseId: 'push-1',
    },
    display: true,
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
  it('REQ-AGENT-063/REQ-AGENT-116: recognizes implicit and explicit branch pushes while rejecting non-branch forms', async () => {
    const { classifyReviewBoundaryCommand } = await plannedHelpers();
    const push = {
      reminder: true,
      settled: true,
      event: 'push' as const,
      pushSource: 'refs/heads/pi',
      pushTarget: 'pi',
    };
    const inferredPush = { reminder: true, settled: true, event: 'push' as const };
    const originPush = { ...inferredPush, pushRemote: 'origin' };
    const none = { reminder: false, settled: false };
    const cases: Array<[string, BoundarySurfaces]> = [
      ['git push origin pi', push],
      ['CI=1 git push origin pi', push],
      ['env GH_TOKEN=x git push origin pi', push],
      ['MESSAGE="review later" git push origin pi', push],
      ["printf '%s' 'git push origin pi'", none],
      ['cat <<EOF\ngit push origin pi\nEOF', none],
      ['cat <<EOF\ngit push origin pi\nEOF\ngit push origin pi', push],
      ["printf '%s' 'example <<EOF'\ngit push origin pi", push],
      ['cat <<EOF-TEXT\ngit push origin pi\nEOF-TEXT', none],
      ['cat <<A <<B\nfirst\nA\ngit push origin pi\nB\ngit push origin pi', push],
      ['printf done; git push origin pi', push],
      ['git push origin HEAD:refs/heads/pi', { ...push, pushSource: 'HEAD' }],
      ['git push', inferredPush],
      ['git push origin', originPush],
      ['git push origin HEAD', originPush],
      ['git push -u origin HEAD', originPush],
      ['git push --repo origin HEAD', originPush],
      ['git push --repo=origin HEAD', originPush],
      ['gh pr create --base main --title review', { reminder: true, settled: true, event: 'pr-create' }],
      ['gh pr edit 42 --base master', none],
      ['gh pr edit 42 --base main && git push origin pi', push],
      ['gh pr merge 42', none],
      ['gh pr update-branch 42', none],
      ['git push origin --delete pi', none],
      ['git push origin :pi', none],
      ['git push --repo', none],
      ['git push --all origin', none],
      ['git push --mirror origin', none],
      ['git push --tags origin', none],
      ['git push --force origin pi', push],
      ['git push --force-with-lease origin pi', push],
      ['git push --dry-run origin pi', none],
      ['git push --follow-tags origin pi', none],
      ['git push -fu origin pi', push],
      ['git push origin +pi', push],
      ['git push origin pi other', none],
      ['git push origin refs/tags/v1:refs/heads/pi', none],
      ['git push origin pi:HEAD', none],
      ['git -C /tmp/repo push origin pi', push],
    ];

    expect(cases.map(([command, expected]) => [command, classifyReviewBoundaryCommand(command), expected]))
      .toEqual(cases.map(([command, expected]) => [command, expected, expected]));
  });

  it('REQ-AGENT-092/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition', async () => {
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
      // REQ-AGENT-040 AC1: source changes require THE CODE LANE. The other two
      // are added only where they have something to check -- their own surface
      // changed, or one of their anchors cites a file in this diff. A bare
      // fixture has neither, and demanding them bought two agent startups that
      // found no lane-owned file and exited.
      { path: 'src/lib/review.ts', expected: ['code-reviewer'] },
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
    // Source plus documentation earns those two lanes; nothing in the range is a
    // spec surface and no spec anchor cites it, so spec-reviewer has nothing to do.
    expect(requiredReviewLanes({ repo, ackHead: base, head: git(repo, 'rev-parse', 'HEAD') }))
      .toEqual(['code-reviewer', 'doc-updater']);
  });

  it('REQ-AGENT-040: classifies tricky filenames and source-to-doc renames without bypassing code review', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const first = makeRepo();
    const sourceHead = commit(first.repo, 'src/original.ts', 'export {};\n', 'source');
    // git mv does not create the destination directory.
    mkdirSync(join(first.repo, 'documentation'), { recursive: true });
    git(first.repo, 'mv', 'src/original.ts', 'documentation/original.md');
    git(first.repo, 'commit', '-m', 'rename source to docs');
    // --no-renames keeps the SOURCE path in the diff, so the code lane still
    // fires -- that is the bypass this guards. The new doc path earns the doc
    // lane on its own; no anchor in these fixtures cites the source, so the
    // spec lane is not owed.
    expect(requiredReviewLanes({ repo: first.repo, ackHead: sourceHead, head: git(first.repo, 'rev-parse', 'HEAD') })).toEqual(['code-reviewer', 'doc-updater']);

    const second = makeRepo();
    const newlinePath = 'src/line\nbreak.ts';
    const newlineHead = commit(second.repo, newlinePath, 'export {};\n', 'newline path');
    expect(requiredReviewLanes({ repo: second.repo, ackHead: second.base, head: newlineHead })).toEqual(['code-reviewer']);
  });

  it('REQ-AGENT-040: reduces a proven comment-only source delta to the code lane alone', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const { repo } = makeRepo();
    const seeded = commit(repo, 'src/a.ts', 'const x = 1; // one\nconst y = 2;\n', 'seed');
    const reworded = commit(repo, 'src/a.ts', 'const x = 1; // uno\nconst y = 2;\n', 'reword the comment');
    expect(requiredReviewLanes({ repo, ackHead: seeded, head: reworded, prover: PROVER })).toEqual(['code-reviewer']);

    // The reduction is one-directional: no prover, no reduction. These repos
    // hold no @impl anchor citing the source, so an unproven delta lands on the
    // code lane rather than all three.
    expect(requiredReviewLanes({ repo, ackHead: seeded, head: reworded, prover: join(repo, 'absent.mjs') })).toEqual(['code-reviewer']);

    const rewritten = commit(repo, 'src/a.ts', 'const x = 9; // uno\nconst y = 2;\n', 'change the code');
    expect(requiredReviewLanes({ repo, ackHead: reworded, head: rewritten, prover: PROVER })).toEqual(['code-reviewer']);
  });

  it('REQ-AGENT-040: an inert source delta still earns the lanes its other paths touch, and any undecidable file keeps all three', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const cases: Array<{ name: string; also?: [string, string]; expected: ReviewLane[] }> = [
      { name: 'comment only', expected: ['code-reviewer'] },
      { name: 'comment plus spec', also: ['sdd/spec/agents.md', 'spec\n'], expected: ALL_LANES },
      { name: 'comment plus docs', also: ['documentation/security.md', 'docs\n'], expected: ['code-reviewer', 'doc-updater'] },
      // An added file changes the module set even when its body is all comments.
      { name: 'comment plus added source', also: ['src/added.ts', '// only a comment\n'], expected: ['code-reviewer'] },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { repo } = makeRepo();
      const seeded = commit(repo, 'src/a.ts', 'const x = 1; // one\n', 'seed');
      write(repo, 'src/a.ts', `const x = 1; // ${index}\n`);
      if (testCase.also) write(repo, testCase.also[0], testCase.also[1]);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', testCase.name);
      expect(requiredReviewLanes({ repo, ackHead: seeded, head: git(repo, 'rev-parse', 'HEAD'), prover: PROVER }), testCase.name)
        .toEqual(testCase.expected);
    }

    // JSX text is content, so .tsx is ineligible however the delta reads.
    const { repo } = makeRepo();
    const seeded = commit(repo, 'src/a.tsx', 'export const a = 1; // one\n', 'seed');
    const reworded = commit(repo, 'src/a.tsx', 'export const a = 1; // uno\n', 'reword');
    expect(requiredReviewLanes({ repo, ackHead: seeded, head: reworded, prover: PROVER })).toEqual(['code-reviewer']);
  });

  it('REQ-AGENT-040: a behavioural change earns a lane only where that surface changed or an anchor cites it', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    // Same source edit, three anchor states. The lane set must follow the
    // anchors, not the mere presence of a behavioural file: spawning a lane
    // that owns nothing costs a full agent startup to be told so.
    const bare = makeRepo();
    const bareHead = commit(bare.repo, 'src/foo.ts', 'export const a = 1;\n', 'source only');
    expect(requiredReviewLanes({ repo: bare.repo, ackHead: bare.base, head: bareHead })).toEqual(['code-reviewer']);

    const docs = makeRepo();
    commit(docs.repo, 'documentation/api.md', 'x <!-- @impl: src/foo.ts -->\n', 'anchor');
    const docsBase = git(docs.repo, 'rev-parse', 'HEAD');
    const docsHead = commit(docs.repo, 'src/foo.ts', 'export const a = 1;\n', 'source only');
    expect(requiredReviewLanes({ repo: docs.repo, ackHead: docsBase, head: docsHead })).toEqual(['code-reviewer', 'doc-updater']);

    const spec = makeRepo();
    commit(spec.repo, 'sdd/spec/x.md', 'x <!-- @impl: src/foo.ts -->\n', 'anchor');
    const specBase = git(spec.repo, 'rev-parse', 'HEAD');
    const specHead = commit(spec.repo, 'src/foo.ts', 'export const a = 1;\n', 'source only');
    expect(requiredReviewLanes({ repo: spec.repo, ackHead: specBase, head: specHead })).toEqual(['code-reviewer', 'spec-reviewer']);
  });

  it('REQ-AGENT-040: Pi and Claude resolve the same range to the same lanes', async () => {
    const { requiredReviewLanes } = await plannedHelpers();
    const { repo } = makeRepo();
    const seeded = commit(repo, 'src/a.ts', 'const x = 1; // one\n', 'seed');
    const reworded = commit(repo, 'src/a.ts', 'const x = 1; // uno\n', 'reword');
    const rewritten = commit(repo, 'src/a.ts', 'const x = 9; // uno\n', 'change the code');
    write(repo, 'src/a.ts', 'const x = 9; // tres\n');
    write(repo, 'sdd/spec/agents.md', 'spec\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'comment plus spec');
    const mixed = git(repo, 'rev-parse', 'HEAD');
    const docsOnly = commit(repo, 'documentation/security.md', 'docs\n', 'docs');
    const licenseOnly = commit(repo, 'LICENSE', 'MIT\n', 'chore: license');

    for (const [base, head, name] of [
      [seeded, reworded, 'comment only'],
      [reworded, rewritten, 'code change'],
      [rewritten, mixed, 'comment plus spec'],
      [mixed, docsOnly, 'docs only'],
      [docsOnly, licenseOnly, 'license only'],
    ] as const) {
      // The shell classifier resolves the prover relative to its own location,
      // so both runtimes run the one program this range is decided by.
      // The script is fed on stdin and every value arrives as a positional
      // argument, so no command string is built from an environment value at
      // all. This is the form host/__tests__/lane-classifier.test.js already
      // uses: CodeQL flags `bash -c` even when the values are passed as argv,
      // because it does not model "$1" quoting as a safety boundary.
      const claude = execFileSync(
        'bash',
        ['-s', '--', LANE_CLASSIFIER, base, head],
        { cwd: repo, encoding: 'utf8', input: 'source "$1"; compute_required_lanes "$2" "$3"' },
      ).trim().split(/\s+/).filter(Boolean);
      expect(claude, name).toEqual(requiredReviewLanes({ repo, ackHead: base, head, prover: PROVER }));
    }
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

describe('Pi round-limit no-op', () => {
  // A lane whose document already defines it as a no-op must cost nothing. Pi
  // had the ownership half of that and not the round-limit half, so a lane at
  // limit still paid a full agent startup to be told what git already knew.
  it('drops a lane at its round limit instead of demanding it', async () => {
    const { repo, base } = makeRepo();
    let head = base;
    for (let i = 0; i < 5; i += 1) {
      head = commit(repo, `sdd/spec/req-${i}.md`, `# req ${i}\n`, `[autonomous] fix: round ${i}`);
    }
    head = commit(repo, 'src/thing.ts', 'export const x = 1;\n', 'feat: source change');

    const { requiredReviewLanes } = await plannedHelpers();
    const lanes = requiredReviewLanes({ repo, ackHead: base, head });

    expect(lanes).toContain('code-reviewer');
    expect(lanes, 'spec-reviewer is past its round limit and must not be demanded')
      .not.toContain('spec-reviewer');
  });

  // The counters are lane-specific on purpose: spec-reviewer counts a subject
  // that CONTAINS its tags, doc-updater one that STARTS WITH them. A commit
  // whose subject merely mentions the tag mid-sentence therefore counts for one
  // lane and not the other, and collapsing that changes when a limit fires.
  it('keeps the two lane counters asymmetric', async () => {
    const { roundLimitReached } = await plannedHelpers();
    const { repo } = makeRepo();
    // Same five commits, touching BOTH trees, with the tag mid-subject. The
    // only thing that can separate the two answers is the match function:
    // spec-reviewer counts a CONTAINED tag, doc-updater only a LEADING one.
    for (let i = 0; i < 5; i += 1) {
      write(repo, `sdd/spec/req-${i}.md`, `# req ${i}\n`);
      write(repo, `documentation/page-${i}.md`, `# page ${i}\n`);
      git(repo, 'add', '--', `sdd/spec/req-${i}.md`, `documentation/page-${i}.md`);
      git(repo, 'commit', '-m', `chore: [autonomous] sweep ${i}`);
    }

    expect(roundLimitReached(repo, 'spec-reviewer'), 'spec-reviewer counts a contained tag').toBe(true);
    expect(roundLimitReached(repo, 'doc-updater'), 'doc-updater counts only a leading tag').toBe(false);
  });

  // Bulk operations are excluded by both rules, so a repo that just ran
  // /sdd clean is not locked out of its next review.
  it('does not count bulk-operation commits toward the limit', async () => {
    const { roundLimitReached } = await plannedHelpers();
    const { repo } = makeRepo();
    for (let i = 0; i < 6; i += 1) {
      commit(repo, `sdd/spec/bulk-${i}.md`, `# bulk ${i}\n`, `[sdd-clean] sweep ${i}`);
    }

    expect(roundLimitReached(repo, 'spec-reviewer')).toBe(false);
  });
});

describe('native Pi transcript review facts', () => {
  it('REQ-AGENT-055: ignores non-boundary PR commands when correlating later public reviewer calls', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-old', 'bash', { command: 'git push origin pi' }, '2026-07-12T12:00:00.000Z'),
      toolResult('push-old', 'bash'),
      assistantTool('code-old', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false }, '2026-07-12T12:01:00.000Z'),
      notification('code-old'),
      assistantTool('push-new', 'bash', { command: 'gh pr merge 42' }, '2026-07-12T12:05:00.000Z'),
      toolResult('push-new', 'bash'),
      assistantTool('doc-new', 'subagent', { subagent_type: 'doc-updater', run_in_background: true, inherit_context: false }, '2026-07-12T12:06:00.000Z'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.boundary).toEqual({ toolUseId: 'push-old', command: 'git push origin pi' });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'terminal', toolUseId: 'code-old' },
      'spec-reviewer': { state: 'missing' },
      'doc-updater': { state: 'in-flight', toolUseId: 'doc-new' },
    });
  });

  it('REQ-AGENT-036: ignores failed settled boundary commands', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-failed', 'bash', { command: 'git push origin pi' }),
      toolResult('push-failed', 'bash', true),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.boundary).toBeUndefined();
    expect(Object.values(facts.lanes).every((lane) => lane.state === 'missing')).toBe(true);
  });

  it('REQ-AGENT-053/REQ-AGENT-059: correlates successful native notifications by XML tool-use-id', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      assistantTool('code-1', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false }),
      toolResult('code-1'),
      sessionEntry('custom', { customType: 'subagents:completed', data: { toolCallId: 'code-1' } }),
      notification('different-id'),
      assistantTool('spec-1', 'subagent', { subagent_type: 'spec-reviewer', run_in_background: true, inherit_context: false }),
      notification('spec-1', 'Error'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'in-flight', toolUseId: 'code-1' },
      'spec-reviewer': { state: 'missing' },
      'doc-updater': { state: 'missing' },
    });
  });

  it('REQ-AGENT-098: recognizes structural triage only after all reviewer notifications', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const calls = [
      assistantTool('code-1', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false }),
      assistantTool('spec-1', 'subagent', { subagent_type: 'spec-reviewer', run_in_background: true, inherit_context: false }),
      assistantTool('doc-1', 'subagent', { subagent_type: 'doc-updater', run_in_background: true, inherit_context: false }),
    ];
    const beforeFinalNotification = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      ...calls,
      notification('code-1'),
      notification('spec-1'),
      triageMessage(),
      notification('doc-1'),
    ]);
    const afterFinalHeaderOnly = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      ...calls,
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageHeaderMessage(),
    ]);
    const afterFinalNotification = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      ...calls,
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
    ]);
    const afterDuplicateNotification = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      ...calls,
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
      notification('code-1'),
      assistantTool('code-2', 'subagent', {
        subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false,
      }),
      notification('code-2'),
    ]);

    expect(reviewTranscriptFacts({ sessionFile: beforeFinalNotification, requiredLanes: ALL_LANES }).triageComplete).toBe(false);
    expect(reviewTranscriptFacts({ sessionFile: afterFinalHeaderOnly, requiredLanes: ALL_LANES }).triageComplete).toBe(false);
    expect(reviewTranscriptFacts({ sessionFile: afterFinalNotification, requiredLanes: ALL_LANES }).triageComplete).toBe(true);
    expect(reviewTranscriptFacts({ sessionFile: afterDuplicateNotification, requiredLanes: ALL_LANES }).triageComplete).toBe(true);
  });

  it('REQ-AGENT-098: first public reviewer result keeps triage complete after later terminal evidence', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const lanes: Array<{ lane: ReviewLane; callId: string; agentId: string; resultId: string }> = [
      { lane: 'code-reviewer', callId: 'code-1', agentId: 'agent-code', resultId: 'result-code' },
      { lane: 'spec-reviewer', callId: 'spec-1', agentId: 'agent-spec', resultId: 'result-spec' },
      { lane: 'doc-updater', callId: 'doc-1', agentId: 'agent-doc', resultId: 'result-doc' },
    ];
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      ...lanes.flatMap(({ lane, callId, agentId, resultId }) => [
        assistantTool(callId, 'subagent', { subagent_type: lane, run_in_background: true, inherit_context: false }),
        toolResult(callId, 'subagent', false, {
          details: { agentId, subagentType: lane },
          text: `Agent started in background.\nAgent ID: ${agentId}\nType: ${lane}`,
        }),
        assistantTool(resultId, 'get_subagent_result', { agent_id: agentId, wait: true, verbose: false }),
        toolResult(resultId, 'get_subagent_result', false, {
          text: `Agent: ${agentId}\nType: ${lane} | Status: completed\nResult: reviewed`,
        }),
      ]),
      triageMessage(),
      assistantTool('result-code-late', 'get_subagent_result', { agent_id: 'agent-code', wait: true, verbose: false }),
      toolResult('result-code-late', 'get_subagent_result', false, {
        text: 'Agent: agent-code\nType: code-reviewer | Status: completed\nResult: reviewed again',
      }),
      notification('code-1'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'terminal', toolUseId: 'code-1' },
      'spec-reviewer': { state: 'terminal', toolUseId: 'spec-1' },
      'doc-updater': { state: 'terminal', toolUseId: 'doc-1' },
    });
    expect(facts.triageComplete).toBe(true);
  });

  it('REQ-AGENT-071/REQ-AGENT-074: keeps unmatched reviewer calls in flight until native terminal notification', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }, '2026-07-12T12:00:00.000Z'),
      toolResult('push-1', 'bash'),
      assistantTool('code-long', 'subagent', { subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false }, '2026-07-12T12:00:30.000Z'),
      assistantTool('spec-done', 'subagent', { subagent_type: 'spec-reviewer', run_in_background: true, inherit_context: false }, '2026-07-12T12:09:30.000Z'),
      notification('spec-done'),
      assistantTool('doc-queued', 'subagent', { subagent_type: 'doc-updater', run_in_background: true, inherit_context: false }, '2026-07-12T12:09:45.000Z'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'in-flight', toolUseId: 'code-long' },
      'spec-reviewer': { state: 'terminal', toolUseId: 'spec-done' },
      'doc-updater': { state: 'in-flight', toolUseId: 'doc-queued' },
    });
  });

  it('REQ-AGENT-071: counts reviewer calls only when their prompt carries the acknowledged-to-current range', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const ackHead = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const reviewRange = `${ackHead}..${head}`;
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      reviewReminder(head, reviewRange, 'develop'),
      assistantTool('code-range', 'subagent', {
        subagent_type: 'code-reviewer', run_in_background: true, inherit_context: false, prompt: `review_range=${reviewRange}`,
      }),
      assistantTool('spec-full', 'subagent', {
        subagent_type: 'spec-reviewer', run_in_background: true, inherit_context: false, prompt: 'review full PR against main',
      }),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.reviewHead).toBe(head);
    expect(facts.reviewRange).toBe(reviewRange);
    expect(facts.reviewRepo).toBe('/workspace/repo');
    expect(facts.reviewBranch).toBe('pi');
    expect(facts.reviewPrNumber).toBe(42);
    expect(facts.reviewBase).toBe('develop');
    expect(facts.reviewBoundaryToolUseId).toBe('push-1');
    expect(facts.lanes['code-reviewer']).toEqual({ state: 'in-flight', toolUseId: 'code-range' });
    expect(facts.lanes['spec-reviewer']).toEqual({ state: 'missing' });
  });

  it('REQ-AGENT-068: recognizes one matching CI launch independently of reviewer completion', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const head = 'b'.repeat(40);
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      assistantTool('ci-old', 'subagent', {
        subagent_type: 'ci-monitor', run_in_background: true, inherit_context: false, prompt: `head=${'a'.repeat(40)}`,
      }),
      assistantTool('ci-current', 'subagent', {
        subagent_type: 'ci-monitor', run_in_background: true, inherit_context: false, prompt: `repo=owner/repo pr=42 head=${head}`,
      }),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES, ciHead: head });
    expect(facts.ciLaunched).toBe(true);
    expect(Object.values(facts.lanes).every((lane) => lane.state === 'missing')).toBe(true);
  });

  it('REQ-AGENT-071: rejects reviewer calls that inherit or omit parent context isolation', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const sessionFile = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      assistantTool('code-inherited', 'subagent', {
        subagent_type: 'code-reviewer', run_in_background: true, inherit_context: true,
      }),
      notification('code-inherited'),
      assistantTool('spec-unspecified', 'subagent', {
        subagent_type: 'spec-reviewer', run_in_background: true,
      }),
      notification('spec-unspecified'),
    ]);

    const facts = reviewTranscriptFacts({ sessionFile, requiredLanes: ALL_LANES });
    expect(facts.lanes).toEqual({
      'code-reviewer': { state: 'missing' },
      'spec-reviewer': { state: 'missing' },
      'doc-updater': { state: 'missing' },
    });
  });

  it('REQ-AGENT-041: recognizes an explicit user bypass only when it follows the latest boundary', async () => {
    const { reviewTranscriptFacts } = await plannedHelpers();
    const before = writeSession([
      userMessage('skip review'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    ]);
    const after = writeSession([
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
      userMessage('skip verification'),
    ]);

    expect(reviewTranscriptFacts({ sessionFile: before, requiredLanes: ALL_LANES }).bypassed).toBe(false);
    expect(reviewTranscriptFacts({ sessionFile: after, requiredLanes: ALL_LANES }).bypassed).toBe(true);
  });
});
