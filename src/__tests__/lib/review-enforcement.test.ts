import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rememberActiveRepo } from '../../../preseed/agents/pi/extensions/codeflare-pi';

type ReviewLane = 'code-reviewer' | 'spec-reviewer' | 'doc-updater';
type PrState = {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: 'main' | 'master' | 'develop';
  headRefOid: string;
  headRefName: string;
  number: number;
};
type SentMessage = {
  message: { customType: string; content?: string; details?: Record<string, unknown>; display?: boolean };
  options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' };
};
type ExtensionHandler = (event: unknown, ctx: TestContext) => unknown | Promise<unknown>;
type TestContext = {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  sessionManager: { getSessionFile(): string; getEntries(): Record<string, unknown>[] };
  ui: { notify(message: string): void; setStatus(): void; clearStatus(): void };
};
type PlannedReviewEnforcement = {
  registerReviewEnforcement(
    pi: TestPi,
    dependencies: {
      queryPr(repo: string, target?: string): Promise<PrState | undefined>;
      queryHead?(repo: string, revision?: string): Promise<string | undefined>;
      queryBranch?(repo: string): Promise<string | undefined>;
      queryPushBranch?(repo: string, branch: string, remote?: string): Promise<string | undefined>;
      sleep?(delayMs: number): Promise<void>;
      headRetryDelaysMs?: number[];
      deferGoalPause?(task: () => void | Promise<void>): void;
    },
  ): void | Promise<void>;
  queryPr(
    repo: string,
    runner?: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: 'utf8'; timeout: number },
    ) => Promise<{ stdout: string }>,
    target?: string,
  ): Promise<PrState | undefined>;
  queryPushBranch(
    repo: string,
    branch: string,
    runner?: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: 'utf8'; timeout: number },
    ) => Promise<{ stdout: string }>,
    remote?: string,
  ): Promise<string | undefined>;
};
type TestPi = {
  on(event: string, handler: ExtensionHandler): void;
  events: {
    emit(channel: string, payload: unknown): void;
  };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: SentMessage['message'], options?: SentMessage['options']): void;
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string; description: string }>;
  setActiveTools(names: string[]): void;
};

const ALL_LANES: ReviewLane[] = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const REVIEW_BYPASS_FILE = join(tmpdir(), `pi-review-bypass-${process.pid}`);
const NOW = Date.parse('2026-07-12T12:10:00.000Z');
process.env.REVIEW_BYPASS_FILE = REVIEW_BYPASS_FILE;
const roots: string[] = [];
let entrySequence = 0;

async function plannedEnforcement(): Promise<PlannedReviewEnforcement> {
  return await import('../../../preseed/agents/pi/extensions/review-enforcement') as unknown as PlannedReviewEnforcement;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function gitMetadataDirectory(repo: string): string {
  return git(repo, 'rev-parse', '--absolute-git-dir');
}

function write(repo: string, relativePath: string, contents: string): void {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function nextId(prefix: string): string {
  entrySequence += 1;
  return `${prefix}-${entrySequence}`;
}

function assistantTool(toolUseId: string, name: string, args: Record<string, unknown>, timestamp = '2026-07-12T12:00:00.000Z'): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('message'),
    parentId: null,
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
  };
}

function toolResult(toolUseId: string, toolName: string, isError = false): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('result'),
    parentId: null,
    timestamp: '2026-07-12T12:00:01.000Z',
    message: {
      role: 'toolResult',
      toolCallId: toolUseId,
      toolName,
      content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
      isError,
      timestamp: Date.parse('2026-07-12T12:00:01.000Z'),
    },
  };
}

function reviewerArgs(fixture: ReturnType<typeof makeReviewFixture>, lane: ReviewLane): Record<string, unknown> {
  return {
    subagent_type: lane,
    run_in_background: true,
    inherit_context: false,
    prompt: `review_range=${fixture.base}..${fixture.head}`,
  };
}

function ciArgs(head: string): Record<string, unknown> {
  return {
    subagent_type: 'ci-monitor',
    run_in_background: true,
    inherit_context: false,
    prompt: `repo=owner/repo pr=42 head=${head}`,
  };
}

function launchWaves(reviewers: ReviewLane[], includeCi: boolean): Array<string[]> {
  return [reviewers, ...(includeCi ? [['ci-monitor']] : [])];
}

function diffScope() {
  return { mode: 'diff', workSet: 'changed-hunks-and-direct-invalidations' };
}

function boundaryIdentity(
  fixture: ReturnType<typeof makeReviewFixture>,
  boundaryToolUseId = 'push-1',
) {
  return {
    repo: fixture.repo,
    branch: fixture.pr.headRefName,
    prNumber: fixture.pr.number,
    base: fixture.pr.baseRefName,
    boundaryToolUseId,
    launchTurn: {
      disposition: 'stop-after-final-launch',
      handoff: 'native-task-notifications',
    },
  };
}

function markdownHeadings(content: string | undefined): string[] {
  return String(content ?? '').split('\n').filter((line) => /^#{2,3} /.test(line));
}

function markdownTableColumns(content: string | undefined): string[] {
  const header = String(content ?? '').split('\n').find((line) => line.startsWith('| FINDING |')) ?? '';
  return header.split('|').map((column) => column.trim()).filter(Boolean);
}

function markdownValue(content: string | undefined, prefix: string): string | undefined {
  const line = String(content ?? '').split('\n').find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
}

function userMessage(content: string): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('user'),
    parentId: null,
    timestamp: '2026-07-12T12:01:00.000Z',
    message: { role: 'user', content, timestamp: Date.parse('2026-07-12T12:01:00.000Z') },
  };
}

function assistantText(content: string): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('assistant'),
    parentId: null,
    timestamp: '2026-07-12T12:03:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      provider: 'anthropic',
      model: 'fixture',
      usage: {},
      stopReason: 'stop',
      timestamp: Date.parse('2026-07-12T12:03:00.000Z'),
    },
  };
}

function triageMessage(): Record<string, unknown> {
  return assistantText('| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n|---|---|---|---|---|');
}

function goalState(goalId: string, status: 'active' | 'paused' | 'blocked' | 'complete' | null): Record<string, unknown> {
  return {
    type: 'custom',
    id: nextId('goal-state'),
    customType: 'goal-state',
    data: {
      goal: status === null ? null : { id: goalId, status },
    },
  };
}

function notification(toolUseId: string, status = 'Done'): Record<string, unknown> {
  return {
    type: 'custom_message',
    id: nextId('notification'),
    parentId: null,
    timestamp: '2026-07-12T12:02:00.000Z',
    customType: 'subagent-notification',
    content: `<task-notification>\n<task-id>agent-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
    display: true,
  };
}

function makeReviewFixture(options: { child?: boolean; changedPath?: string } = {}): {
  repo: string;
  base: string;
  head: string;
  sessionFile: string;
  pr: PrState;
} {
  const repo = tempRoot('pi-review-enforcement-');
  git(repo, 'init', '-q');
  git(repo, 'branch', '-M', 'pi');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@users.noreply.github.com');
  write(repo, 'sdd/README.md', '# fixture\n');
  write(repo, 'README.md', '# fixture\n');
  git(repo, 'add', 'sdd/README.md', 'README.md');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  // These tests exercise the launch plan, not lane classification, so the
  // boundary commit has to genuinely earn all three lanes: a source file for the
  // code lane and a spec file, which carries the doc lane with it. A source-only
  // delta now classifies to the code lane alone, and every `missingLanes`
  // expectation here is a subtraction from the full set.
  write(repo, options.changedPath ?? 'src/review.ts', 'export {};\n');
  write(repo, 'sdd/spec/boundary.md', '# boundary\n');
  git(repo, 'add', '--', options.changedPath ?? 'src/review.ts', 'sdd/spec/boundary.md');
  git(repo, 'commit', '-m', 'review boundary');
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(gitMetadataDirectory(repo), 'sdd-last-ack-pr-head'), `${base}\n`, 'utf8');

  const sessionFile = join(repo, 'session.jsonl');
  const header = {
    type: 'session',
    version: 3,
    id: nextId('session'),
    timestamp: '2026-07-12T11:59:00.000Z',
    cwd: repo,
    ...(options.child ? { parentSession: '/tmp/parent-session.jsonl' } : {}),
  };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8');

  return {
    repo,
    base,
    head,
    sessionFile,
    pr: { state: 'OPEN', baseRefName: 'main', headRefOid: head, headRefName: 'pi', number: 42 },
  };
}

function makeLinkedReviewFixture(): ReturnType<typeof makeReviewFixture> {
  const source = makeReviewFixture();
  const parent = tempRoot('pi-review-linked-parent-');
  const repo = join(parent, 'linked');
  const branch = 'linked-pi';
  git(source.repo, 'worktree', 'add', '-qb', branch, repo, source.head);
  const sessionFile = join(repo, 'session.jsonl');
  writeFileSync(sessionFile, `${JSON.stringify({
    type: 'session',
    version: 3,
    id: nextId('session'),
    timestamp: '2026-07-12T11:59:00.000Z',
    cwd: repo,
  })}\n`, 'utf8');
  writeFileSync(join(gitMetadataDirectory(repo), 'sdd-last-ack-pr-head'), `${source.base}\n`, 'utf8');
  return {
    ...source,
    repo,
    sessionFile,
    pr: { ...source.pr, headRefName: branch },
  };
}

function appendSession(sessionFile: string, ...entries: Record<string, unknown>[]): void {
  appendFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function makeHarness(repo: string, sessionFile: string): {
  pi: TestPi;
  ctx: TestContext;
  sent: SentMessage[];
  goalControlRequests: Array<{ action: string; goalId: string }>;
  notifications: string[];
  operations: string[];
  setGoalControlAvailable(available: boolean): void;
  setGoalPauseResponseSucceeds(succeeds: boolean): void;
  setGoalResumeRaceActive(goalId: string | undefined): void;
  setGoalResumeSucceeds(succeeds: boolean): void;
  setLiveEntries(entries: Record<string, unknown>[] | undefined): void;
  deferGoalPause(task: () => void | Promise<void>): void;
  flushGoalPauses(): Promise<void>;
  emit(event: string, payload?: unknown): Promise<void>;
} {
  const handlers = new Map<string, ExtensionHandler[]>();
  const sent: SentMessage[] = [];
  const goalControlRequests: Array<{ action: string; goalId: string }> = [];
  const notifications: string[] = [];
  const operations: string[] = [];
  const deferredGoalPauses: Array<() => void | Promise<void>> = [];
  let activeTools = ['read', 'bash'];
  let goalControlAvailable = true;
  let goalPauseResponseSucceeds = true;
  let goalResumeRaceActive: string | undefined;
  let goalResumeSucceeds = true;
  let liveEntries: Record<string, unknown>[] | undefined;
  const allTools = [
    { name: 'read', description: 'Read files' },
    { name: 'bash', description: 'Run shell commands' },
    { name: 'subagent', description: 'Launch a background specialist' },
  ];
  const pi: TestPi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    events: {
      emit: (channel, payload) => {
        if (channel !== 'codeflare:pi-goal:control' || !goalControlAvailable) return;
        const request = payload as {
          action?: unknown;
          goalId?: unknown;
          accepted?: () => void;
          respond?: (result: { ok: boolean; goalId: string; status: string }) => void;
        };
        if ((request.action !== 'pause' && request.action !== 'resume')
          || typeof request.goalId !== 'string'
          || typeof request.respond !== 'function') return;
        goalControlRequests.push({ action: request.action, goalId: request.goalId });
        request.accepted?.();
        if (request.action === 'pause' && !goalPauseResponseSucceeds) {
          appendSession(sessionFile, goalState(request.goalId, 'paused'));
          request.respond({ ok: false, goalId: request.goalId, status: 'paused' });
          return;
        }
        if (request.action === 'resume' && goalResumeRaceActive) {
          appendSession(sessionFile, goalState(goalResumeRaceActive, 'active'));
          request.respond({ ok: false, goalId: request.goalId, status: 'paused' });
          return;
        }
        const succeeded = request.action === 'pause' || goalResumeSucceeds;
        request.respond({
          ok: succeeded,
          goalId: request.goalId,
          status: request.action === 'pause' || !succeeded ? 'paused' : 'active',
        });
      },
    },
    appendEntry: (customType, data) => {
      operations.push(`append:${customType}`);
      appendSession(sessionFile, {
        type: 'custom',
        id: nextId('custom'),
        customType,
        data,
      });
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => allTools.map((tool) => ({ ...tool })),
    setActiveTools: (names) => {
      activeTools = [...names];
      operations.push(`activate:${names.join(',')}`);
    },
    sendMessage: (message, options) => {
      operations.push(`send:${message.customType}`);
      sent.push({ message, options });
      appendSession(sessionFile, {
        type: 'custom_message',
        id: nextId('custom'),
        parentId: null,
        timestamp: new Date(NOW).toISOString(),
        ...message,
      });
    },
  };
  const ctx: TestContext = {
    cwd: repo,
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getEntries: () => liveEntries ?? readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type !== 'session'),
    },
    ui: {
      notify: (message) => { notifications.push(message); },
      setStatus: () => undefined,
      clearStatus: () => undefined,
    },
  };
  return {
    pi,
    ctx,
    sent,
    goalControlRequests,
    notifications,
    operations,
    setGoalControlAvailable: (available) => { goalControlAvailable = available; },
    setGoalPauseResponseSucceeds: (succeeds) => { goalPauseResponseSucceeds = succeeds; },
    setGoalResumeRaceActive: (goalId) => { goalResumeRaceActive = goalId; },
    setGoalResumeSucceeds: (succeeds) => { goalResumeSucceeds = succeeds; },
    setLiveEntries: (entries) => { liveEntries = entries; },
    deferGoalPause: (task) => { deferredGoalPauses.push(task); },
    flushGoalPauses: async () => {
      for (const task of deferredGoalPauses.splice(0)) await task();
    },
    emit: async (event, payload = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

async function registerFixture(
  fixture: ReturnType<typeof makeReviewFixture>,
  cwd = fixture.repo,
  observeQuery?: (repo: string, target: string | undefined) => void,
  observePush?: (repo: string, branch: string, remote: string | undefined) => void,
) {
  const { registerReviewEnforcement } = await plannedEnforcement();
  const harness = makeHarness(cwd, fixture.sessionFile);
  await registerReviewEnforcement(harness.pi, {
    queryPr: async (repo, target) => {
      observeQuery?.(repo, target);
      return fixture.pr;
    },
    queryPushBranch: async (repo, branch, remote) => {
      observePush?.(repo, branch, remote);
      return branch;
    },
    deferGoalPause: harness.deferGoalPause,
  });
  return harness;
}

function boundaryEvent(command = 'git push origin pi', toolCallId = 'push-1') {
  return {
    toolName: 'bash',
    toolCallId,
    input: { command },
    args: { command },
    result: { content: [{ type: 'text', text: 'ok' }], isError: false },
  };
}

function ackHead(repo: string): string {
  return readFileSync(join(gitMetadataDirectory(repo), 'sdd-last-ack-pr-head'), 'utf8').trim();
}

afterEach(() => {
  rmSync(REVIEW_BYPASS_FILE, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Pi review reminder and settled enforcement', () => {
  it('REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110: emits one plan before settled recovery', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    expect(harness.operations.slice(0, 2)).toEqual([
      'activate:read,bash,subagent',
      'send:pr-boundary-launch-plan',
    ]);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        display: true,
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    const plan = harness.sent[0]?.message.content;
    expect(markdownHeadings(plan)).toEqual([
      '## PR boundary — review + CI',
      '### 1. Start reviewers together',
      '### 2. Start CI immediately',
      '### 3. Triage and acknowledge before fixing',
    ]);
    expect(markdownValue(plan, '**Order:** ')).toBe('REVIEWERS → CI → TRIAGE + ACK → FIX');
    expect(markdownValue(plan, '**Triage turn:** ')).toBe(
      'publish the triage table; make no mutations; end the turn',
    );
    expect(markdownValue(plan, '**Fix delivery:** ')).toBe(
      'next-turn follow-up after acknowledgement',
    );
    expect(markdownValue(plan, '- Agents: ')).toBe('`code-reviewer`, `spec-reviewer`, `doc-updater`');
    expect(markdownValue(plan, '- `inherit_context`: ')).toBe('`false`');
    expect(markdownValue(plan, '- Prompt scope: ')).toBe(
      `\`scope=diff\` and \`review_range=${fixture.base}..${fixture.head}\``,
    );
    expect(markdownValue(plan, '- `event`: ')).toBe('`push`');
    expect(markdownValue(plan, '- `changed`: ')).toBe('`true`');
    expect(markdownValue(plan, '- `repo`: ')).toBe('`<owner/repo>`');
    expect(markdownValue(plan, '- `pr`: ')).toBe('`42`');
    expect(markdownValue(plan, '- `cwd`: ')).toBe(`\`${fixture.repo}\``);
    expect(markdownValue(plan, '- `reviewState`: ')).toBe('`launched`');
    expect(markdownTableColumns(plan)).toEqual([
      'FINDING', 'VALIDITY', 'PROPOSED FIX', 'PROPORTIONALITY', 'MINIMAL DECISION',
    ]);
    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        display: true,
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(markdownHeadings(harness.sent[0]?.message.content)).toEqual([
      '## PR boundary follow-up — missing work',
      '### 1. Start reviewers together',
      '### 2. Start CI immediately',
      '### 3. Triage and acknowledge before fixing',
    ]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('tool_result', boundaryEvent());

    expect(harness.goalControlRequests).toEqual([]);
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-launch-plan');
    await harness.emit('agent_end');
    expect(harness.goalControlRequests).toEqual([]);
    await harness.flushGoalPauses();
    expect(harness.goalControlRequests).toEqual([{
      action: 'pause',
      goalId: 'goal-1',
    }]);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'paused'),
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head)),
      notification('ci-1'),
    );
    await harness.emit('agent_end');
    expect(harness.goalControlRequests).toEqual([{ action: 'pause', goalId: 'goal-1' }]);

    for (const reviewer of ['code-1', 'spec-1', 'doc-1']) {
      appendSession(fixture.sessionFile, notification(reviewer));
      await harness.emit('agent_end');
      expect(harness.goalControlRequests).toEqual([{ action: 'pause', goalId: 'goal-1' }]);
      expect(ackHead(fixture.repo)).toBe(fixture.base);
    }

    appendSession(fixture.sessionFile, triageMessage());
    await harness.emit('agent_end');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    expect(harness.sent.at(-1)).toEqual({
      message: expect.objectContaining({
        customType: 'pr-boundary-fix-follow-up',
        details: { head: fixture.head, reviewRange: `${fixture.base}..${fixture.head}` },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    });
  });

  it('REQ-AGENT-113: clears stale review ownership when a manual resume wins the release race', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-resume-race', 'bash', { command: 'git push origin pi' }),
      toolResult('push-resume-race', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-resume-race'));
    await harness.emit('agent_end');
    expect(harness.goalControlRequests).toEqual([]);
    await harness.flushGoalPauses();
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'paused'),
      assistantTool('code-resume-race', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-resume-race', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-resume-race', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-resume-race'),
      notification('spec-resume-race'),
      notification('doc-resume-race'),
      triageMessage(),
    );
    harness.setGoalResumeRaceActive('goal-1');

    await harness.emit('agent_end');

    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    expect(harness.notifications).toEqual([]);
    const entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause')
      .at(-1)?.data).toBeNull();
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-fix-follow-up');
  });

  it('REQ-AGENT-112/REQ-AGENT-113: retains release ownership when the exact Goal persists paused despite a failed pause response', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    harness.setGoalPauseResponseSucceeds(false);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-persisted-pause', 'bash', { command: 'git push origin pi' }),
      toolResult('push-persisted-pause', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-persisted-pause'));

    expect(harness.goalControlRequests).toEqual([]);
    await harness.emit('agent_end');
    expect(harness.goalControlRequests).toEqual([]);
    await harness.flushGoalPauses();
    expect(harness.goalControlRequests).toEqual([{ action: 'pause', goalId: 'goal-1' }]);
    const entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause')
      .at(-1)?.data).toEqual({ head: fixture.head, goalId: 'goal-1' });

    appendSession(fixture.sessionFile,
      assistantTool('code-persisted', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-persisted', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-persisted', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-persisted'),
      notification('spec-persisted'),
      notification('doc-persisted'),
      triageMessage(),
    );
    await harness.emit('agent_end');

    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-fix-follow-up');
  });

  it('REQ-AGENT-112: transfers an owned pause to a replacement PR head and resumes after its FIX reminder', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    appendSession(fixture.sessionFile, goalState('goal-1', 'paused'));
    write(fixture.repo, 'src/review.ts', 'export const replacement = true;\n');
    git(fixture.repo, 'add', 'src/review.ts');
    git(fixture.repo, 'commit', '-m', 'replacement head');
    fixture.head = git(fixture.repo, 'rev-parse', 'HEAD');
    fixture.pr.headRefOid = fixture.head;
    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-2'));
    expect(harness.goalControlRequests).toEqual([{ action: 'pause', goalId: 'goal-1' }]);

    appendSession(fixture.sessionFile,
      assistantTool('code-2', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-2', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-2', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-2'),
      notification('spec-2'),
      notification('doc-2'),
      triageMessage(),
    );
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    expect(harness.sent.at(-1)).toMatchObject({
      message: {
        customType: 'pr-boundary-fix-follow-up',
        details: { head: fixture.head },
      },
      options: { deliverAs: 'followUp', triggerTurn: true },
    });
  });

  it('REQ-AGENT-112: rolls back a paused Goal when replacement-head ownership cannot be recorded', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    appendSession(fixture.sessionFile, goalState('goal-1', 'paused'));
    write(fixture.repo, 'src/review.ts', 'export const replacement = true;\n');
    git(fixture.repo, 'add', 'src/review.ts');
    git(fixture.repo, 'commit', '-m', 'replacement head');
    fixture.head = git(fixture.repo, 'rev-parse', 'HEAD');
    fixture.pr.headRefOid = fixture.head;
    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    const appendEntry = harness.pi.appendEntry;
    harness.pi.appendEntry = (customType, data) => {
      if (customType === 'pr-boundary-goal-pause'
        && (data as { head?: string } | null)?.head === fixture.head) {
        throw new Error('simulated transfer persistence failure');
      }
      appendEntry(customType, data);
    };

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-2'));
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    const entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause').at(-1)?.data).toBeNull();
  });

  it('REQ-AGENT-112: retains failed rollback ownership and releases it after replacement-head review', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();
    const originalHead = fixture.head;

    appendSession(fixture.sessionFile, goalState('goal-1', 'paused'));
    write(fixture.repo, 'src/review.ts', 'export const replacement = true;\n');
    git(fixture.repo, 'add', 'src/review.ts');
    git(fixture.repo, 'commit', '-m', 'replacement head');
    fixture.head = git(fixture.repo, 'rev-parse', 'HEAD');
    fixture.pr.headRefOid = fixture.head;
    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    const appendEntry = harness.pi.appendEntry;
    harness.pi.appendEntry = (customType, data) => {
      if (customType === 'pr-boundary-goal-pause'
        && (data as { head?: string } | null)?.head === fixture.head) {
        throw new Error('simulated transfer persistence failure');
      }
      appendEntry(customType, data);
    };
    harness.setGoalResumeSucceeds(false);

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-2'));
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    let entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause').at(-1)?.data).toEqual({
      head: originalHead,
      goalId: 'goal-1',
    });
    expect(harness.notifications.at(-1)).toContain('rollback also failed');

    harness.setGoalResumeSucceeds(true);
    appendSession(fixture.sessionFile,
      assistantTool('code-2', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-2', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-2', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-2'),
      notification('spec-2'),
      notification('doc-2'),
      triageMessage(),
    );
    await harness.emit('agent_end');

    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause').at(-1)?.data).toBeNull();
  });

  it('REQ-AGENT-112: does not pause when review ownership cannot be recorded', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    const staleHead = fixture.base;
    appendSession(fixture.sessionFile,
      {
        type: 'custom',
        id: nextId('goal-pause'),
        customType: 'pr-boundary-goal-pause',
        data: { head: staleHead, goalId: 'stale-goal' },
      },
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    const appendEntry = harness.pi.appendEntry;
    harness.pi.appendEntry = (customType, data) => {
      if (customType === 'pr-boundary-goal-pause'
        && (data as { head?: string } | null)?.head === fixture.head) {
        throw new Error('simulated ownership persistence failure');
      }
      appendEntry(customType, data);
    };

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    expect(harness.goalControlRequests).toEqual([]);
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-launch-plan');
    expect(harness.notifications.at(-1)).toContain('before pausing');
    const entries = readFileSync(fixture.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.customType === 'pr-boundary-goal-pause').at(-1)?.data).toEqual({
      head: staleHead,
      goalId: 'stale-goal',
    });
  });

  it('REQ-AGENT-113: fails open when the Goal extension is unavailable', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    harness.setGoalControlAvailable(false);
    appendSession(fixture.sessionFile,
      goalState('stale-goal', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();

    expect(harness.goalControlRequests).toEqual([]);
    expect(harness.sent.at(-1)).toEqual({
      message: expect.objectContaining({ customType: 'pr-boundary-launch-plan' }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    });
  });

  it('REQ-AGENT-113: keeps FIX delivery fail-open when Goal is removed during review', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'paused'),
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
    );
    harness.setGoalControlAvailable(false);

    await harness.emit('agent_end');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.goalControlRequests).toEqual([{
      action: 'pause',
      goalId: 'goal-1',
    }]);
    expect(harness.sent.at(-1)?.options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('REQ-AGENT-113: never resumes a replacement Goal after the boundary pause', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'paused'),
      goalState('goal-2', 'active'),
      goalState('goal-2', 'paused'),
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
    );

    await harness.emit('agent_end');

    expect(harness.goalControlRequests).toEqual([{
      action: 'pause',
      goalId: 'goal-1',
    }]);
    expect(harness.sent.at(-1)?.options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('REQ-AGENT-113: never resumes the same Goal after independent reactivation', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'paused'),
      goalState('goal-1', 'active'),
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
    );

    await harness.emit('agent_end');

    expect(harness.goalControlRequests).toEqual([{
      action: 'pause',
      goalId: 'goal-1',
    }]);
    expect(harness.sent.at(-1)?.options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review', async () => {
    const cases: Array<{
      name: string;
      prepare(fixture: ReturnType<typeof makeReviewFixture>): string | undefined;
    }> = [
      {
        name: 'missing',
        prepare: (fixture) => {
          rmSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), { force: true });
          return undefined;
        },
      },
      {
        name: 'malformed',
        prepare: (fixture) => {
          writeFileSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), 'not-a-sha\n', 'utf8');
          return undefined;
        },
      },
      {
        name: 'non-ancestor',
        prepare: (fixture) => {
          const tree = git(fixture.repo, 'rev-parse', `${fixture.base}^{tree}`);
          const nonAncestor = git(fixture.repo, 'commit-tree', tree, '-m', 'unrelated root');
          writeFileSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), `${nonAncestor}\n`, 'utf8');
          return nonAncestor;
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = makeReviewFixture();
      const expectedAck = testCase.prepare(fixture);
      const harness = await registerFixture(fixture);

      await harness.emit('tool_result', boundaryEvent());

      expect(harness.sent, testCase.name).toEqual([{
        message: expect.objectContaining({
          customType: 'pr-boundary-launch-plan',
          details: {
            ...boundaryIdentity(fixture),
            head: fixture.head,
            ackHead: expectedAck,
            reviewRange: undefined,
            scope: diffScope(),
            requiredLanes: ALL_LANES,
            launchWaves: launchWaves(ALL_LANES, true),
            ciEvent: 'push',
          },
        }),
        options: { deliverAs: 'followUp', triggerTurn: true },
      }]);
    }
  });

  it('REQ-AGENT-055/REQ-AGENT-068: acknowledged current head emits a CI-only plan', async () => {
    const fixture = makeReviewFixture();
    writeFileSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), `${fixture.head}\n`, 'utf8');
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-current', 'bash', { command: 'git push origin pi' }),
      toolResult('push-current', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-current'));

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          ...boundaryIdentity(fixture, 'push-current'),
          head: fixture.head,
          ackHead: fixture.head,
          reviewRange: undefined,
          scope: diffScope(),
          requiredLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.head);
  });

  it('REQ-AGENT-036/REQ-AGENT-063: PR edit, update, and merge commands do not launch boundary work', async () => {
    for (const [index, command] of [
      'gh pr edit 42 --base main',
      'gh pr update-branch 42',
      'gh pr merge 42',
    ].entries()) {
      const fixture = makeReviewFixture();
      const harness = await registerFixture(fixture);
      appendSession(fixture.sessionFile,
        assistantTool(`unsupported-${index}`, 'bash', { command }),
        toolResult(`unsupported-${index}`, 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(command));
      await harness.emit('agent_settled');

      expect(harness.sent, command).toEqual([]);
      expect(ackHead(fixture.repo), command).toBe(fixture.base);
    }
  });

  it('REQ-AGENT-068: emits a CI-only launch plan in default session mode', async () => {
    const fixture = makeReviewFixture();
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';
    try {
      const harness = await registerFixture(fixture);
      appendSession(fixture.sessionFile,
        assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
        toolResult('push-1', 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent());

      expect(harness.sent[0]?.message.details).toMatchObject({
        requiredLanes: [],
        launchWaves: launchWaves([], true),
        ciEvent: 'push',
      });
      expect(markdownHeadings(harness.sent[0]?.message.content)).toEqual([
        '## PR boundary — CI',
        '### 1. Start CI immediately',
      ]);
      expect(markdownTableColumns(harness.sent[0]?.message.content)).toEqual([]);
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-068: emits a CI-only launch plan outside SDD mode', async () => {
    const fixture = makeReviewFixture();
    rmSync(join(fixture.repo, 'sdd'), { recursive: true, force: true });
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036: resolves a cd-prefixed boundary through active repository memory', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(fixture.repo);
    const harness = await registerFixture(fixture, sessionRoot);

    await harness.emit('tool_result', boundaryEvent(`cd ${fixture.repo} && gh pr create --base main`));

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          ciEvent: 'pr-create',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036/REQ-AGENT-063: resolves fail-fast multiline push and PR-create boundaries', async () => {
    const commands = [
      'set -euo pipefail\ncd "REPO"\ngit push origin pi',
      'set -euo pipefail\ncd "REPO"\ngh pr create --base main --head pi --title review',
    ];

    for (const [index, template] of commands.entries()) {
      const fixture = makeReviewFixture();
      const sessionRoot = dirname(fixture.repo);
      const queriedRepos: string[] = [];
      const harness = await registerFixture(fixture, sessionRoot, (repo) => {
        queriedRepos.push(repo);
      });
      const command = template.replace('REPO', fixture.repo);
      const toolUseId = `fail-fast-multiline-${index}`;
      appendSession(fixture.sessionFile,
        assistantTool(toolUseId, 'bash', { command }),
        toolResult(toolUseId, 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(command, toolUseId));

      expect(queriedRepos).toEqual([fixture.repo]);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.message.details).toMatchObject({
        ...boundaryIdentity(fixture, toolUseId),
        head: fixture.head,
        ackHead: fixture.base,
        reviewRange: `${fixture.base}..${fixture.head}`,
        requiredLanes: ALL_LANES,
        ciEvent: index === 0 ? 'push' : 'pr-create',
      });
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-068: default mode resolves the repository from a cd-prefixed boundary', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(sessionRoot);
    const harness = await registerFixture(fixture, sessionRoot);
    const command = `cd ${fixture.repo} && git push origin pi`;
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command }),
      toolResult('push-1', 'bash'),
    );
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';

    try {
      await harness.emit('tool_result', boundaryEvent(command));
      expect(harness.sent).toEqual([{
        message: expect.objectContaining({
          customType: 'pr-boundary-launch-plan',
          details: {
            ...boundaryIdentity(fixture),
            head: fixture.head,
            ackHead: fixture.base,
            reviewRange: `${fixture.base}..${fixture.head}`,
            scope: diffScope(),
            requiredLanes: [],
            launchWaves: launchWaves([], true),
            ciEvent: 'push',
          },
        }),
        options: { deliverAs: 'followUp', triggerTurn: true },
      }]);
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-068: default mode resolves the repository from batch tool cwd', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(sessionRoot);
    const harness = await registerFixture(fixture, sessionRoot);
    const input = { cwd: fixture.repo, commands: [{ command: 'git push origin pi' }] };
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'ctx_batch_execute', input),
      toolResult('push-1', 'ctx_batch_execute'),
    );
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';

    try {
      await harness.emit('tool_result', {
        toolName: 'ctx_batch_execute',
        toolCallId: 'push-1',
        input,
        result: { content: [{ type: 'text', text: 'ok' }], isError: false },
      });
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.message.details).toMatchObject({
        head: fixture.head,
        requiredLanes: [],
        ciEvent: 'push',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-068: dispatches a git -C push from the workspace parent', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(sessionRoot);
    const harness = await registerFixture(fixture, sessionRoot);
    const command = `git -C "${fixture.repo}" push origin pi`;
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command }),
      toolResult('push-1', 'bash'),
    );
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';

    try {
      await harness.emit('tool_result', boundaryEvent(command));
      expect(harness.sent[0]?.message.details).toMatchObject({
        head: fixture.head,
        requiredLanes: [],
        ciEvent: 'push',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-063: resolves implicit pushes from the configured push destination', async () => {
    const implicitCases = [
      { command: 'git push', remote: undefined },
      { command: 'git push origin', remote: 'origin' },
      { command: 'git push -u origin HEAD', remote: 'origin' },
    ];
    for (const [index, testCase] of implicitCases.entries()) {
      const fixture = makeReviewFixture();
      const queries: Array<{ repo: string; target: string | undefined }> = [];
      const pushRoutes: Array<{ repo: string; branch: string; remote: string | undefined }> = [];
      const harness = await registerFixture(fixture, fixture.repo, (repo, target) => {
        queries.push({ repo, target });
      }, (repo, branch, remote) => {
        pushRoutes.push({ repo, branch, remote });
      });
      const command = testCase.command;
      const toolUseId = `implicit-${index}`;
      appendSession(fixture.sessionFile,
        assistantTool(toolUseId, 'bash', { command }),
        toolResult(toolUseId, 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(command, toolUseId));

      expect(pushRoutes).toEqual([{ repo: fixture.repo, branch: 'pi', remote: testCase.remote }]);
      expect(queries).toEqual([{ repo: fixture.repo, target: 'pi' }]);
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.message.details).toMatchObject({
        ...boundaryIdentity(fixture, toolUseId),
        head: fixture.head,
        ciEvent: 'push',
      });
    }

    const renamed = makeReviewFixture();
    git(renamed.repo, 'branch', '-m', 'topic');
    renamed.pr.headRefName = 'review-topic';
    const renamedQueries: Array<{ repo: string; target: string | undefined }> = [];
    const { registerReviewEnforcement } = await plannedEnforcement();
    const renamedHarness = makeHarness(renamed.repo, renamed.sessionFile);
    registerReviewEnforcement(renamedHarness.pi, {
      queryBranch: async () => 'topic',
      queryPushBranch: async (_repo, _branch, remote) => remote === undefined ? 'review-topic' : undefined,
      queryPr: async (repo, target) => {
        renamedQueries.push({ repo, target });
        return renamed.pr;
      },
    });
    appendSession(renamed.sessionFile,
      assistantTool('renamed-upstream', 'bash', { command: 'git push' }),
      toolResult('renamed-upstream', 'bash'),
    );

    await renamedHarness.emit('tool_result', boundaryEvent('git push', 'renamed-upstream'));

    expect(renamedQueries).toEqual([{ repo: renamed.repo, target: 'review-topic' }]);
    expect(renamedHarness.sent[0]?.message.details).toMatchObject({
      ...boundaryIdentity(renamed, 'renamed-upstream'),
      branch: 'review-topic',
      head: renamed.head,
    });

    const detached = makeReviewFixture();
    git(detached.repo, 'checkout', '--detach', '-q');
    let detachedQueries = 0;
    const detachedHarness = await registerFixture(detached, detached.repo, () => {
      detachedQueries += 1;
    });
    appendSession(detached.sessionFile,
      assistantTool('detached-push', 'bash', { command: 'git push' }),
      toolResult('detached-push', 'bash'),
    );

    await detachedHarness.emit('tool_result', boundaryEvent('git push', 'detached-push'));

    expect(detachedQueries).toBe(0);
    expect(detachedHarness.sent).toEqual([]);
  });

  it('REQ-AGENT-036: resolves a remote-only push through the production configured-push fallback', async () => {
    const fixture = makeReviewFixture();
    git(fixture.repo, 'remote', 'add', 'origin', fixture.repo);
    git(fixture.repo, 'config', 'remote.origin.push', 'refs/heads/pi:refs/heads/review-topic');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/review-topic', fixture.head);
    fixture.pr.headRefName = 'review-topic';
    const queried: Array<{ repo: string; target: string | undefined }> = [];
    const { registerReviewEnforcement } = await plannedEnforcement();
    const harness = makeHarness(fixture.repo, fixture.sessionFile);
    registerReviewEnforcement(harness.pi, {
      queryPr: async (repo, target) => {
        queried.push({ repo, target });
        return fixture.pr;
      },
    });
    const command = 'git push origin';
    appendSession(fixture.sessionFile,
      assistantTool('production-push-fallback', 'bash', { command }),
      toolResult('production-push-fallback', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command, 'production-push-fallback'));

    expect(queried).toEqual([{ repo: fixture.repo, target: 'review-topic' }]);
    expect(harness.sent[0]?.message.details).toMatchObject({
      ...boundaryIdentity(fixture, 'production-push-fallback'),
      head: fixture.head,
    });
  });

  it('REQ-AGENT-036/REQ-AGENT-055: binds git -C review and acknowledgement to the boundary repository', async () => {
    const ambient = makeReviewFixture();
    const boundary = makeReviewFixture();
    const { registerReviewEnforcement } = await plannedEnforcement();
    const harness = makeHarness(ambient.repo, boundary.sessionFile);
    const queriedRepos: string[] = [];
    registerReviewEnforcement(harness.pi, {
      queryPr: async (repo) => {
        queriedRepos.push(repo);
        return repo === boundary.repo ? boundary.pr : ambient.pr;
      },
    });
    const command = `git -C "${boundary.repo}" push origin pi`;
    appendSession(boundary.sessionFile,
      assistantTool('cross-repo-push', 'bash', { command }),
      toolResult('cross-repo-push', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command, 'cross-repo-push'));

    expect(queriedRepos).toEqual([boundary.repo]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.message.details).toMatchObject({
      ...boundaryIdentity(boundary, 'cross-repo-push'),
      head: boundary.head,
    });

    harness.sent.splice(0);
    rememberActiveRepo(ambient.repo);
    appendSession(boundary.sessionFile,
      assistantTool('code-cross', 'subagent', reviewerArgs(boundary, 'code-reviewer')),
      assistantTool('spec-cross', 'subagent', reviewerArgs(boundary, 'spec-reviewer')),
      assistantTool('doc-cross', 'subagent', reviewerArgs(boundary, 'doc-updater')),
      assistantTool('ci-cross', 'subagent', ciArgs(boundary.head)),
      notification('code-cross'),
      notification('spec-cross'),
      notification('doc-cross'),
      triageMessage(),
    );

    await harness.emit('agent_end');

    expect(queriedRepos).toEqual([boundary.repo, boundary.repo]);
    expect(ackHead(boundary.repo)).toBe(boundary.head);
    expect(ackHead(ambient.repo)).toBe(ambient.base);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({ customType: 'pr-boundary-fix-follow-up' }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
  });

  it('REQ-AGENT-036/REQ-AGENT-055: persists acknowledgement in a linked worktree git directory', async () => {
    const fixture = makeLinkedReviewFixture();
    const harness = await registerFixture(fixture, dirname(fixture.repo));
    const command = `set -euo pipefail\ncd "${fixture.repo}"\ngit push origin ${fixture.pr.headRefName}`;
    appendSession(fixture.sessionFile,
      assistantTool('linked-push', 'bash', { command }),
      toolResult('linked-push', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command, 'linked-push'));
    appendSession(fixture.sessionFile,
      assistantTool('code-linked', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-linked', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-linked', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-linked'),
      notification('spec-linked'),
      notification('doc-linked'),
      triageMessage(),
    );

    await harness.emit('agent_end');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-fix-follow-up');
  });

  it('REQ-AGENT-041/REQ-AGENT-119: persists settled retry counts in a linked worktree git directory', async () => {
    const fixture = makeLinkedReviewFixture();
    const harness = await registerFixture(fixture, dirname(fixture.repo));
    const command = `set -euo pipefail\ncd "${fixture.repo}"\ngit push origin ${fixture.pr.headRefName}`;
    appendSession(fixture.sessionFile,
      assistantTool('linked-retry', 'bash', { command }),
      toolResult('linked-retry', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command, 'linked-retry'));
    await harness.emit('agent_settled');
    await harness.emit('agent_settled');

    expect(readFileSync(join(gitMetadataDirectory(fixture.repo), 'sdd-review-block-count'), 'utf8')).toBe(`${fixture.head}:1\n`);
    expect(harness.sent.at(-1)?.message.customType).toBe('pr-boundary-launch-follow-up');
  });

  it('REQ-AGENT-036/REQ-AGENT-063: pairs a batch boundary with its command repository', async () => {
    const ambient = makeReviewFixture();
    const boundary = makeReviewFixture();
    const { registerReviewEnforcement } = await plannedEnforcement();
    const harness = makeHarness(ambient.repo, boundary.sessionFile);
    const queriedRepos: string[] = [];
    registerReviewEnforcement(harness.pi, {
      queryPr: async (repo) => {
        queriedRepos.push(repo);
        return repo === boundary.repo ? boundary.pr : ambient.pr;
      },
    });
    const input = {
      cwd: dirname(boundary.repo),
      commands: [
        { command: `git -C "${boundary.repo}" push origin pi` },
        { command: `git -C "${ambient.repo}" status --short` },
      ],
    };
    appendSession(boundary.sessionFile,
      assistantTool('batch-cross-repo', 'ctx_batch_execute', input),
      toolResult('batch-cross-repo', 'ctx_batch_execute'),
    );

    await harness.emit('tool_result', {
      toolName: 'ctx_batch_execute',
      toolCallId: 'batch-cross-repo',
      input,
      isError: false,
    });

    expect(queriedRepos).toEqual([boundary.repo]);
    expect(harness.sent[0]?.message.details).toMatchObject({
      ...boundaryIdentity(boundary, 'batch-cross-repo'),
      head: boundary.head,
    });
  });

  it('REQ-AGENT-036/REQ-AGENT-063: binds compound-shell pushes to their exact repository segment', async () => {
    const commands = [
      (ambient: string, boundary: string) => `git -C "${ambient}" status --short; git -C "${boundary}" push origin pi`,
      (ambient: string, boundary: string) => `cd "${ambient}" && git status --short; cd "${boundary}" && git push origin pi`,
    ];

    for (const [index, commandForRepos] of commands.entries()) {
      const ambient = makeReviewFixture();
      const boundary = makeReviewFixture();
      const command = commandForRepos(ambient.repo, boundary.repo);
      const { registerReviewEnforcement } = await plannedEnforcement();
      const harness = makeHarness(ambient.repo, boundary.sessionFile);
      const queriedRepos: string[] = [];
      registerReviewEnforcement(harness.pi, {
        queryPr: async (repo) => {
          queriedRepos.push(repo);
          return repo === boundary.repo ? boundary.pr : ambient.pr;
        },
      });
      const toolUseId = `compound-cross-repo-${index}`;
      appendSession(boundary.sessionFile,
        assistantTool(toolUseId, 'bash', { command }),
        toolResult(toolUseId, 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(command, toolUseId));

      expect(queriedRepos).toEqual([boundary.repo]);
      expect(harness.sent[0]?.message.details).toMatchObject({
        ...boundaryIdentity(boundary, toolUseId),
        head: boundary.head,
      });
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-063: preserves cwd only across deterministic parent-shell segments', async () => {
    const pipelineAmbient = makeReviewFixture();
    const pipelineOther = makeReviewFixture();
    const pipelineCommand = `cd "${pipelineOther.repo}" | true; git push origin pi`;
    const pipelineQueries: string[] = [];
    const { registerReviewEnforcement } = await plannedEnforcement();
    const pipelineHarness = makeHarness(pipelineAmbient.repo, pipelineAmbient.sessionFile);
    registerReviewEnforcement(pipelineHarness.pi, {
      queryPr: async (repo) => {
        pipelineQueries.push(repo);
        return repo === pipelineAmbient.repo ? pipelineAmbient.pr : pipelineOther.pr;
      },
    });
    appendSession(pipelineAmbient.sessionFile,
      assistantTool('pipeline-push', 'bash', { command: pipelineCommand }),
      toolResult('pipeline-push', 'bash'),
    );

    await pipelineHarness.emit('tool_result', boundaryEvent(pipelineCommand, 'pipeline-push'));

    expect(pipelineQueries).toEqual([pipelineAmbient.repo]);
    expect(pipelineHarness.sent[0]?.message.details).toMatchObject({
      ...boundaryIdentity(pipelineAmbient, 'pipeline-push'),
      head: pipelineAmbient.head,
    });

    for (const [index, command] of [
      `cd "${pipelineOther.repo}"; git push origin pi`,
      `set -e\nset +e\ncd "${pipelineOther.repo}"\ngit push origin pi`,
      `set -- -e\ncd "${pipelineOther.repo}"\ngit push origin pi`,
      `cd /missing || git push origin pi`,
      `true || cd "${pipelineOther.repo}" && git push origin pi`,
    ].entries()) {
      const fixture = makeReviewFixture();
      let queries = 0;
      const harness = await registerFixture(fixture, fixture.repo, () => {
        queries += 1;
      });
      const toolUseId = `uncertain-cwd-${index}`;
      appendSession(fixture.sessionFile,
        assistantTool(toolUseId, 'bash', { command }),
        toolResult(toolUseId, 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(command, toolUseId));

      expect(queries).toBe(0);
      expect(harness.sent).toEqual([]);
    }
  });

  it('REQ-AGENT-036: PR creation targeting develop launches its review window', async () => {
    const fixture = makeReviewFixture();
    fixture.pr.baseRefName = 'develop';
    const harness = await registerFixture(fixture);
    const command = 'gh pr create --base develop --title review';
    appendSession(fixture.sessionFile,
      assistantTool('create-develop', 'bash', { command }),
      toolResult('create-develop', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command, 'create-develop'));

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.message.customType).toBe('pr-boundary-launch-plan');

    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-develop', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-develop', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-develop', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      assistantTool('ci-develop', 'subagent', ciArgs(fixture.head)),
      notification('code-develop'),
      notification('spec-develop'),
      notification('doc-develop'),
      triageMessage(),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({ customType: 'pr-boundary-fix-follow-up' }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036/REQ-AGENT-055: PR creation completion acknowledges its review window', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    const command = 'gh pr create --base main --title review';
    appendSession(fixture.sessionFile,
      assistantTool('create-1', 'bash', { command }),
      toolResult('create-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent(command, 'create-1'));
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
      triageMessage(),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
  });

  it('REQ-AGENT-036/REQ-AGENT-063: launches only for the branch actually pushed to an open protected PR', async () => {
    const unrelated = makeReviewFixture();
    git(unrelated.repo, 'branch', 'unrelated', unrelated.head);
    const unrelatedHarness = await registerFixture(unrelated);
    const unrelatedCommand = 'git push origin unrelated';
    appendSession(unrelated.sessionFile,
      assistantTool('push-unrelated', 'bash', { command: unrelatedCommand }),
      toolResult('push-unrelated', 'bash'),
    );

    await unrelatedHarness.emit('tool_result', boundaryEvent(unrelatedCommand));
    expect(unrelatedHarness.sent).toEqual([]);

    const mismatchedSource = makeReviewFixture();
    git(mismatchedSource.repo, 'branch', 'protected-feature', mismatchedSource.base);
    mismatchedSource.pr.headRefName = 'protected-feature';
    const mismatchHarness = await registerFixture(mismatchedSource);
    const mismatchCommand = 'git push origin protected-feature';
    appendSession(mismatchedSource.sessionFile,
      assistantTool('push-mismatch', 'bash', { command: mismatchCommand }),
      toolResult('push-mismatch', 'bash'),
    );

    await mismatchHarness.emit('tool_result', boundaryEvent(mismatchCommand));
    expect(mismatchHarness.sent).toEqual([]);

    const protectedBranch = makeReviewFixture();
    git(protectedBranch.repo, 'branch', 'protected-feature', protectedBranch.head);
    protectedBranch.pr.headRefName = 'protected-feature';
    protectedBranch.pr.baseRefName = 'develop';
    const protectedHarness = await registerFixture(protectedBranch);
    const protectedCommand = 'git push origin protected-feature';
    appendSession(protectedBranch.sessionFile,
      assistantTool('push-protected', 'bash', { command: protectedCommand }),
      toolResult('push-protected', 'bash'),
    );

    await protectedHarness.emit('tool_result', boundaryEvent(protectedCommand));
    expect(protectedHarness.sent).toHaveLength(1);
    expect(protectedHarness.sent[0]?.message.customType).toBe('pr-boundary-launch-plan');

    const deleted = makeReviewFixture();
    const deletedHarness = await registerFixture(deleted);
    const deleteCommand = 'git push origin --delete obsolete';
    appendSession(deleted.sessionFile,
      assistantTool('push-delete', 'bash', { command: deleteCommand }),
      toolResult('push-delete', 'bash'),
    );

    await deletedHarness.emit('tool_result', boundaryEvent(deleteCommand));
    expect(deletedHarness.sent).toEqual([]);
  });

  it('REQ-AGENT-063: extracts boundaries only from supported shell tool result surfaces', async () => {
    const cases = [
      { toolName: 'bash', input: { command: 'git push origin pi' }, isError: false, expected: 1 },
      { toolName: 'bash', input: { command: 'git push origin pi' }, isError: true, expected: 0 },
      { toolName: 'ctx_execute', input: { language: 'shell', code: 'git push origin pi' }, isError: false, expected: 1 },
      { toolName: 'ctx_execute', input: { language: 'javascript', code: "console.log('git push origin pi')" }, isError: false, expected: 0 },
      { toolName: 'ctx_batch_execute', input: { commands: [{ command: 'printf done' }, { command: 'git push origin pi' }] }, isError: false, expected: 1 },
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = makeReviewFixture();
      const harness = await registerFixture(fixture);
      const toolUseId = `boundary-${index}`;
      appendSession(fixture.sessionFile,
        assistantTool(toolUseId, testCase.toolName, testCase.input),
        toolResult(toolUseId, testCase.toolName),
      );

      await harness.emit('tool_result', {
        toolName: testCase.toolName,
        toolCallId: toolUseId,
        input: testCase.input,
        isError: testCase.isError,
      });
      expect(harness.sent).toHaveLength(testCase.expected);
    }
  });

  it('REQ-AGENT-036: default PR lookup returns without blocking on the GitHub process', async () => {
    const { queryPr } = await plannedEnforcement();
    const repo = tempRoot('pi-review-query-');
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\nsleep 2\nprintf '%s\\n' '{"state":"OPEN","baseRefName":"main","headRefOid":"${'a'.repeat(40)}","headRefName":"pi","number":637}'\n`, 'utf8');
    chmodSync(gh, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    try {
      const startedAt = Date.now();
      const pending = queryPr(repo);
      expect(Date.now() - startedAt).toBeLessThan(750);
      await expect(pending).resolves.toEqual(expect.objectContaining({ number: 637 }));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('REQ-AGENT-036: PR lookup is repository-scoped, bounded, and fail-closed', async () => {
    const { queryPr } = await plannedEnforcement();
    const repo = '/tmp/review-query-repo';
    const pr: PrState = {
      state: 'OPEN',
      baseRefName: 'main',
      headRefOid: 'a'.repeat(40),
      headRefName: 'pi',
      number: 637,
    };
    let observed: { command: string; args: string[]; options: { cwd: string; encoding: 'utf8'; timeout: number } } | undefined;
    const pending = queryPr(repo, async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: JSON.stringify(pr) };
    });

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual(pr);
    expect(observed).toEqual({
      command: 'gh',
      args: ['pr', 'view', '--json', 'state,baseRefName,headRefOid,headRefName,number,isDraft'],
      options: { cwd: repo, encoding: 'utf8', timeout: 10_000 },
    });
    let targetedArgs: string[] | undefined;
    await queryPr(repo, async (_command, args) => {
      targetedArgs = args;
      return { stdout: JSON.stringify(pr) };
    }, '42');
    expect(targetedArgs).toEqual([
      'pr', 'view', '42', '--json', 'state,baseRefName,headRefOid,headRefName,number,isDraft',
    ]);

    await expect(queryPr(repo, async () => Promise.reject(new Error('gh failed')))).resolves.toBeUndefined();
  });

  it('REQ-AGENT-036: resolves Git configured push destinations without parsing Git config', async () => {
    const { queryPushBranch } = await plannedEnforcement();
    const repo = '/tmp/review-push-branch-repo';
    let observed: { command: string; args: string[]; options: { cwd: string; encoding: 'utf8'; timeout: number } } | undefined;

    await expect(queryPushBranch(repo, 'topic', async (command, args, options) => {
      observed = { command, args, options };
      return { stdout: 'origin/review-topic\n' };
    }, 'origin')).resolves.toBe('review-topic');
    expect(observed).toEqual({
      command: 'git',
      args: ['-c', 'branch.topic.pushRemote=origin', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', 'topic@{push}'],
      options: { cwd: repo, encoding: 'utf8', timeout: 10_000 },
    });

    await expect(queryPushBranch(repo, 'topic', async () => ({ stdout: 'upstream/review-topic\n' }), 'origin')).resolves.toBeUndefined();
    await expect(queryPushBranch(repo, 'topic', async () => ({ stdout: '\n' }))).resolves.toBeUndefined();
    await expect(queryPushBranch(repo, 'topic', async () => ({ stdout: 'review-topic\n' }))).resolves.toBeUndefined();
    await expect(queryPushBranch(repo, 'topic', async () => ({ stdout: 'refs/remotes/origin/review-topic\n' }))).resolves.toBeUndefined();
    await expect(queryPushBranch(repo, 'topic', async () => ({ stdout: 'origin/a\norigin/b\n' }))).resolves.toBeUndefined();
  });

  it('REQ-AGENT-036 + REQ-AGENT-080 AC6: an unpublished local commit emits no launch plan without a boundary', async () => {
    const fixture = makeReviewFixture();
    write(fixture.repo, 'src/unpublished.ts', 'export {};\n');
    git(fixture.repo, 'add', 'src/unpublished.ts');
    git(fixture.repo, 'commit', '-m', 'unpublished local commit');
    const { registerReviewEnforcement } = await plannedEnforcement();
    const harness = makeHarness(fixture.repo, fixture.sessionFile);
    let queries = 0;
    await registerReviewEnforcement(harness.pi, {
      queryPr: async () => {
        queries += 1;
        return fixture.pr;
      },
    });

    await harness.emit('agent_settled');

    expect(queries).toBe(0);
    expect(harness.sent).toEqual([]);
  });

  it('REQ-AGENT-058: recovered review requires a matching emitted head', async () => {
    for (const emittedHead of [undefined, 'f'.repeat(40)]) {
      const fixture = makeReviewFixture();
      const { registerReviewEnforcement } = await plannedEnforcement();
      const harness = makeHarness(fixture.repo, fixture.sessionFile);
      registerReviewEnforcement(harness.pi, { queryPr: async () => fixture.pr });
      appendSession(fixture.sessionFile,
        assistantTool('stale-push', 'bash', { command: 'git push origin pi' }),
        toolResult('stale-push', 'bash'),
        ...(emittedHead ? [{
          type: 'custom_message',
          customType: 'pr-boundary-launch-plan',
          details: {
            ...boundaryIdentity(fixture, 'stale-push'),
            head: emittedHead,
            reviewRange: `${fixture.base}..${emittedHead}`,
          },
          display: true,
        }] : []),
      );

      await harness.emit('agent_settled');

      expect(harness.sent).toEqual([]);
      expect(ackHead(fixture.repo)).toBe(fixture.base);
    }
  });

  it('REQ-AGENT-058 + REQ-AGENT-080 AC6: an eligible pushed boundary emits one authoritative launch plan', async () => {
    const fixture = makeReviewFixture();
    const staleHead = fixture.head;
    write(fixture.repo, 'src/review-follow-up.ts', 'export {};\n');
    git(fixture.repo, 'add', 'src/review-follow-up.ts');
    git(fixture.repo, 'commit', '-m', 'follow-up boundary');
    fixture.head = git(fixture.repo, 'rev-parse', 'HEAD');
    const harness = makeHarness(fixture.repo, fixture.sessionFile);
    const delays: number[] = [];
    let queries = 0;
    const { registerReviewEnforcement } = await plannedEnforcement();
    await registerReviewEnforcement(harness.pi, {
      queryPr: async () => ({
        ...fixture.pr,
        headRefOid: ++queries < 3 ? staleHead : fixture.head,
      }),
      queryHead: async () => fixture.head,
      sleep: async (delayMs) => { delays.push(delayMs); },
      headRetryDelaysMs: [0, 10, 20],
    });
    appendSession(fixture.sessionFile,
      assistantTool('push-lagged', 'bash', { command: 'git push origin pi' }),
      toolResult('push-lagged', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-lagged'));

    expect(queries).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          ...boundaryIdentity(fixture, 'push-lagged'),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036: ignores a failed persisted push during settled enforcement', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-failed', 'bash', { command: 'git push origin pi' }),
      toolResult('push-failed', 'bash', true),
    );

    await harness.emit('agent_settled');

    expect(harness.sent).toEqual([]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer'), '2026-07-12T12:00:30.000Z'),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer'), '2026-07-12T12:00:40.000Z'),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head), '2026-07-12T12:00:50.000Z'),
    );

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        display: true,
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: ['doc-updater'],
          launchWaves: launchWaves(['doc-updater'], false),
          ciEvent: undefined,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    const followUp = harness.sent[0]?.message.content;
    expect(markdownHeadings(followUp)).toEqual([
      '## PR boundary follow-up — missing work',
      '### 1. Start reviewers together',
      '### 2. Triage and acknowledge before fixing',
    ]);
    expect(followUp).toMatch(/\*\*Recovery rule:\*\*[\s\S]+Do not duplicate unmatched calls/);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-068/REQ-AGENT-074: requests a missing CI launch without duplicating in-flight reviewers', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
    );

    await harness.emit('agent_settled');

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer'), '2026-07-12T12:07:00.000Z'),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer'), '2026-07-12T12:07:10.000Z'),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater'), '2026-07-12T12:07:20.000Z'),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head), '2026-07-12T12:07:30.000Z'),
      notification('doc-1'),
      notification('code-1'),
    );

    await harness.emit('agent_settled');
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(harness.sent).toEqual([]);

    appendSession(fixture.sessionFile, notification('spec-1'));
    await harness.emit('agent_settled');
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(harness.sent).toEqual([]);

    appendSession(fixture.sessionFile, triageMessage());
    await harness.emit('agent_settled');
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-fix-follow-up',
        display: true,
        details: {
          head: fixture.head,
          reviewRange: `${fixture.base}..${fixture.head}`,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(markdownValue(harness.sent[0]?.message.content, '**Phase:** ')).toBe('FIX');
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/codeflare-review-jobs'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-results'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-pending.json'))).toBe(false);
  });

  it('REQ-AGENT-074: agent end acknowledges triage from live session state before disk flush', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head)),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
    );
    const persisted = readFileSync(fixture.sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.type !== 'session');
    harness.setLiveEntries([...persisted, triageMessage()]);

    await harness.emit('agent_end');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-fix-follow-up',
        details: { head: fixture.head, reviewRange: `${fixture.base}..${fixture.head}` },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
  });

  it('REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: failed reviewer notification remains unacknowledged and recoverable', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head)),
      notification('code-1', 'Error'),
      notification('spec-1'),
      notification('doc-1'),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(harness.sent[0]?.message.details).toMatchObject({
      head: fixture.head,
      missingLanes: ['code-reviewer'],
      ciEvent: undefined,
    });
  });

  it('REQ-AGENT-053/055/074 + REQ-AGENT-080 AC6: delayed completion acknowledges the pushed review head, not unpublished local work', async () => {
    const fixture = makeReviewFixture();
    const initialHarness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await initialHarness.emit('tool_result', boundaryEvent());
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      assistantTool('ci-1', 'subagent', ciArgs(fixture.head)),
      notification('code-1'),
      notification('doc-1'),
    );

    write(fixture.repo, 'src/follow-up.ts', 'export {};\n');
    git(fixture.repo, 'add', 'src/follow-up.ts');
    git(fixture.repo, 'commit', '-m', 'unpublished follow-up');

    const reloadedHarness = await registerFixture(fixture);
    appendSession(fixture.sessionFile, notification('spec-1'), triageMessage());
    await reloadedHarness.emit('session_start', { reason: 'resume' });
    await reloadedHarness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(reloadedHarness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-fix-follow-up',
        display: true,
        details: {
          head: fixture.head,
          reviewRange: `${fixture.base}..${fixture.head}`,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);

    const postAckHarness = await registerFixture(fixture);
    await postAckHarness.emit('agent_settled');
    expect(postAckHarness.sent).toEqual([]);
    expect(ackHead(fixture.repo)).toBe(fixture.head);
  });

  it('REQ-AGENT-110 AC5: reload recovers one launch plan for a successful boundary whose live handler was missed', async () => {
    const fixture = makeReviewFixture();
    const command = [
      'set -euo pipefail',
      `cd "${fixture.repo}"`,
      'git status --short',
      'git push origin pi',
    ].join('\n');
    appendSession(fixture.sessionFile,
      assistantTool('push-before-reload', 'bash', { command }),
      toolResult('push-before-reload', 'bash'),
    );

    const reloadedHarness = await registerFixture(fixture);
    await reloadedHarness.emit('session_start', { reason: 'resume' });
    await reloadedHarness.emit('agent_settled');
    await reloadedHarness.emit('agent_settled');

    expect(reloadedHarness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: expect.objectContaining({
          boundaryToolUseId: 'push-before-reload',
          head: fixture.head,
        }),
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036: resumed sessions stay inert until a new eligible boundary', async () => {
    const fixture = makeReviewFixture();
    const initialHarness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await initialHarness.emit('tool_result', boundaryEvent());
    appendSession(fixture.sessionFile,
      assistantTool('switch-1', 'bash', { command: 'git switch pi' }),
      toolResult('switch-1', 'bash'),
    );
    let prQueries = 0;
    const resumedHarness = await registerFixture(fixture, fixture.repo, () => {
      prQueries += 1;
    });
    await resumedHarness.emit('session_start', { reason: 'resume' });

    await resumedHarness.emit('tool_result', boundaryEvent('git switch pi', 'switch-1'));
    await resumedHarness.emit('agent_end');
    await resumedHarness.emit('agent_settled');

    expect(prQueries).toBe(0);
    expect(resumedHarness.sent).toEqual([]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);

    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    await resumedHarness.emit('tool_result', boundaryEvent('git push origin pi', 'push-2'));

    expect(prQueries).toBe(1);
    expect(resumedHarness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: expect.objectContaining({ boundaryToolUseId: 'push-2', head: fixture.head }),
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
    );
    fixture.pr.headRefOid = 'f'.repeat(40);

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(harness.sent).toEqual([]);
  });

  it('REQ-AGENT-041: consumes a one-shot bypass and acknowledges the exact PR head', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    writeFileSync(REVIEW_BYPASS_FILE, '', 'utf8');
    appendSession(fixture.sessionFile,
      assistantTool('create-1', 'bash', { command: 'gh pr create --base main' }),
      toolResult('create-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('gh pr create --base main', 'create-1'));
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          ...boundaryIdentity(fixture, 'create-1'),
          head: fixture.head,
          ackHead: fixture.head,
          reviewRange: undefined,
          scope: diffScope(),
          requiredLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'pr-create',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(true);
    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(false);
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    harness.sent.splice(0);

    write(fixture.repo, 'src/next.ts', 'export const next = true;\n');
    git(fixture.repo, 'add', 'src/next.ts');
    git(fixture.repo, 'commit', '-m', 'next boundary');
    const nextHead = git(fixture.repo, 'rev-parse', 'HEAD');
    fixture.pr.headRefOid = nextHead;
    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent('git push origin pi', 'push-2'));
    expect(harness.sent[0]?.message.details).toMatchObject({
      head: nextHead,
      ackHead: fixture.head,
      reviewRange: `${fixture.head}..${nextHead}`,
      requiredLanes: ['code-reviewer'],
      ciEvent: 'push',
    });
  });

  it('REQ-AGENT-041: an explicit post-boundary user bypass acknowledges the exact PR head', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile, userMessage('skip review'));

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.head,
          reviewRange: undefined,
          missingLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
  });

  it('REQ-AGENT-041: a post-boundary sentinel acknowledges the exact PR head', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    writeFileSync(REVIEW_BYPASS_FILE, '', 'utf8');

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(false);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        details: {
          ...boundaryIdentity(fixture),
          head: fixture.head,
          ackHead: fixture.head,
          reviewRange: undefined,
          missingLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-041/REQ-AGENT-119: blocks five times then latches GIVEUP for the same head without acknowledging it', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile, assistantTool('ci-1', 'subagent', ciArgs(fixture.head)));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      harness.sent.splice(0);
      await harness.emit('agent_settled');
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.message.details).toEqual({
        ...boundaryIdentity(fixture),
        head: fixture.head,
        ackHead: fixture.base,
        reviewRange: `${fixture.base}..${fixture.head}`,
        missingLanes: ALL_LANES,
        launchWaves: launchWaves(ALL_LANES, false),
        ciEvent: undefined,
      });
    }

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
    expect(readFileSync(join(fixture.repo, '.git/sdd-review-block-count'), 'utf8').trim()).toBe(`${fixture.head}:GIVEUP`);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-041/REQ-AGENT-058/REQ-AGENT-113/REQ-AGENT-114: a merged PR releases Goal without consuming bypass or acknowledging', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      goalState('goal-1', 'active'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_end');
    await harness.flushGoalPauses();
    harness.sent.splice(0);
    appendSession(fixture.sessionFile, goalState('goal-1', 'paused'));
    fixture.pr.state = 'MERGED';
    writeFileSync(REVIEW_BYPASS_FILE, '', 'utf8');

    await harness.emit('agent_settled');

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-closed-unacknowledged',
        display: true,
        details: { head: fixture.head, state: 'MERGED' },
      }),
      options: { triggerTurn: false },
    }]);
    expect(harness.goalControlRequests).toEqual([
      { action: 'pause', goalId: 'goal-1' },
      { action: 'resume', goalId: 'goal-1' },
    ]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(true);
  });

  it('REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes', async () => {
    const fixture = makeReviewFixture({ child: true });
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
  });
});
