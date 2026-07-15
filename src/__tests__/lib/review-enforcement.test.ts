import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rememberActiveRepo } from '../../../preseed/agents/pi/extensions/codeflare-pi';

type ReviewLane = 'code-reviewer' | 'spec-reviewer' | 'doc-updater';
type PrState = {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: 'main' | 'master';
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
  sessionManager: { getSessionFile(): string };
  ui: { notify(): void; setStatus(): void; clearStatus(): void };
};
type PlannedReviewEnforcement = {
  registerReviewEnforcement(
    pi: TestPi,
    dependencies: {
      queryPr(repo: string, target?: string): Promise<PrState | undefined>;
      queryHead?(repo: string): Promise<string | undefined>;
      sleep?(delayMs: number): Promise<void>;
      headRetryDelaysMs?: number[];
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
};
type TestPi = {
  on(event: string, handler: ExtensionHandler): void;
  sendMessage(message: SentMessage['message'], options?: SentMessage['options']): void;
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

function userMessage(content: string): Record<string, unknown> {
  return {
    type: 'message',
    id: nextId('user'),
    parentId: null,
    timestamp: '2026-07-12T12:01:00.000Z',
    message: { role: 'user', content, timestamp: Date.parse('2026-07-12T12:01:00.000Z') },
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
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@users.noreply.github.com');
  write(repo, 'sdd/README.md', '# fixture\n');
  write(repo, 'README.md', '# fixture\n');
  git(repo, 'add', 'sdd/README.md', 'README.md');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, options.changedPath ?? 'src/review.ts', 'export {};\n');
  git(repo, 'add', '--', options.changedPath ?? 'src/review.ts');
  git(repo, 'commit', '-m', 'review boundary');
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, '.git/sdd-last-ack-pr-head'), `${base}\n`, 'utf8');

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

function appendSession(sessionFile: string, ...entries: Record<string, unknown>[]): void {
  appendFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function makeHarness(repo: string, sessionFile: string): {
  pi: TestPi;
  ctx: TestContext;
  sent: SentMessage[];
  emit(event: string, payload?: unknown): Promise<void>;
} {
  const handlers = new Map<string, ExtensionHandler[]>();
  const sent: SentMessage[] = [];
  const pi: TestPi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (message, options) => {
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
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { notify: () => undefined, setStatus: () => undefined, clearStatus: () => undefined },
  };
  return {
    pi,
    ctx,
    sent,
    emit: async (event, payload = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

async function registerFixture(
  fixture: ReturnType<typeof makeReviewFixture>,
  cwd = fixture.repo,
  observeTarget?: (target: string | undefined) => void,
) {
  const { registerReviewEnforcement } = await plannedEnforcement();
  const harness = makeHarness(cwd, fixture.sessionFile);
  await registerReviewEnforcement(harness.pi, {
    queryPr: async (_repo, target) => {
      observeTarget?.(target);
      return fixture.pr;
    },
  });
  return harness;
}

function boundaryEvent(command = 'git push origin pi') {
  return {
    toolName: 'bash',
    toolCallId: 'push-1',
    input: { command },
    args: { command },
    result: { content: [{ type: 'text', text: 'ok' }], isError: false },
  };
}

function ackHead(repo: string): string {
  return readFileSync(join(repo, '.git/sdd-last-ack-pr-head'), 'utf8').trim();
}

afterEach(() => {
  rmSync(REVIEW_BYPASS_FILE, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Pi review reminder and settled enforcement', () => {
  it('REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        content: expect.stringContaining('triage summary before fixing'),
        display: true,
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          reviewHandoff: 'triage-summary-before-fixes',
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-follow-up',
        content: expect.stringContaining('triage summary before fixing'),
        display: true,
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          reviewHandoff: 'triage-summary-before-fixes',
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
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

    await harness.emit('tool_result', boundaryEvent());

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
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

  it('REQ-AGENT-055/REQ-AGENT-082: protected-base retarget invalidates same-head acknowledgement', async () => {
    const fixture = makeReviewFixture();
    writeFileSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), `${fixture.head}\n`, 'utf8');
    const harness = await registerFixture(fixture);
    const command = 'gh pr edit 42 --base main';
    appendSession(fixture.sessionFile,
      assistantTool('retarget-1', 'bash', { command }),
      toolResult('retarget-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command));

    expect(existsSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'))).toBe(false);
    expect(harness.sent[0]?.message.details).toEqual({
      head: fixture.head,
      ackHead: undefined,
      reviewRange: undefined,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, false),
      ciEvent: undefined,
    });
  });

  it('REQ-AGENT-036: update-branch fetches and reviews a remote-only PR head', async () => {
    const fixture = makeReviewFixture();
    const remote = tempRoot('pi-review-remote-');
    git(remote, 'init', '--bare', '-q');
    git(fixture.repo, 'remote', 'add', 'origin', remote);
    git(fixture.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/pi');

    const updater = tempRoot('pi-review-updater-');
    git(updater, 'clone', '-q', '--branch', 'pi', remote, '.');
    git(updater, 'config', 'user.name', 'Test User');
    git(updater, 'config', 'user.email', 'test@users.noreply.github.com');
    write(updater, 'src/remote-update.ts', 'export {};\n');
    git(updater, 'add', 'src/remote-update.ts');
    git(updater, 'commit', '-m', 'remote PR update');
    const remoteHead = git(updater, 'rev-parse', 'HEAD');
    git(updater, 'push', '-q', 'origin', 'HEAD:refs/pull/42/head');

    expect(() => git(fixture.repo, 'cat-file', '-e', `${remoteHead}^{commit}`)).toThrow();
    fixture.pr = { ...fixture.pr, headRefOid: remoteHead };
    let observedTarget: string | undefined;
    const harness = await registerFixture(fixture, fixture.repo, (target) => { observedTarget = target; });
    const command = 'gh pr update-branch 42';
    appendSession(fixture.sessionFile,
      assistantTool('update-branch-1', 'bash', { command }),
      toolResult('update-branch-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command));

    expect(observedTarget).toBe('42');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          head: remoteHead,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${remoteHead}`,
          scope: diffScope(),
          requiredLanes: ALL_LANES,
          launchWaves: launchWaves(ALL_LANES, true),
          ciEvent: 'push',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
  });

  it('REQ-AGENT-036: up-to-date update-branch emits no launch plan', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    const command = 'gh pr update-branch 42';
    appendSession(fixture.sessionFile,
      assistantTool('update-branch-noop-1', 'bash', { command }),
      toolResult('update-branch-noop-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent(command));

    expect(harness.sent).toEqual([]);
  });

  it('REQ-AGENT-055/REQ-AGENT-082: protected retarget invalidation survives compound commands and disabled review mode', async () => {
    const fixture = makeReviewFixture();
    writeFileSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'), `${fixture.head}\n`, 'utf8');
    const harness = await registerFixture(fixture);
    const command = 'gh pr edit 42 --base main && git push origin pi';
    appendSession(fixture.sessionFile,
      assistantTool('retarget-push-1', 'bash', { command }),
      toolResult('retarget-push-1', 'bash'),
    );
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';

    try {
      await harness.emit('tool_result', boundaryEvent(command));
      expect(existsSync(join(fixture.repo, '.git/sdd-last-ack-pr-head'))).toBe(false);
      expect(harness.sent[0]?.message.details).toMatchObject({
        ackHead: undefined,
        requiredLanes: [],
        ciEvent: 'push',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
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

  it('REQ-AGENT-036/REQ-AGENT-055: PR creation completion acknowledges its review window', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    const command = 'gh pr create --base main --title review';
    appendSession(fixture.sessionFile,
      assistantTool('create-1', 'bash', { command }),
      toolResult('create-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent(command));
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      assistantTool('code-1', 'subagent', reviewerArgs(fixture, 'code-reviewer')),
      assistantTool('spec-1', 'subagent', reviewerArgs(fixture, 'spec-reviewer')),
      assistantTool('doc-1', 'subagent', reviewerArgs(fixture, 'doc-updater')),
      notification('code-1'),
      notification('spec-1'),
      notification('doc-1'),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
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

  it('REQ-AGENT-036: performs no PR query when the transcript has no settled boundary', async () => {
    const fixture = makeReviewFixture();
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

  it('REQ-AGENT-058: one boundary lifecycle retries bounded PR-head propagation and emits one plan', async () => {
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

    await harness.emit('tool_result', boundaryEvent());

    expect(queries).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
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

  it('REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only the reminder head after all lanes terminate', async () => {
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
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/codeflare-review-jobs'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-results'))).toBe(false);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-pending.json'))).toBe(false);
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

  it('REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: delayed completion acknowledges the reviewed PR head after reload and new local work', async () => {
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
      notification('code-1'),
      notification('doc-1'),
    );

    write(fixture.repo, 'src/follow-up.ts', 'export {};\n');
    git(fixture.repo, 'add', 'src/follow-up.ts');
    git(fixture.repo, 'commit', '-m', 'unpublished follow-up');

    const reloadedHarness = await registerFixture(fixture);
    appendSession(fixture.sessionFile, notification('spec-1'));
    await reloadedHarness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
    expect(reloadedHarness.sent).toEqual([]);
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

  it('REQ-AGENT-041: consumes a one-shot bypass on reminder-only PR creation', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    writeFileSync(REVIEW_BYPASS_FILE, '', 'utf8');
    appendSession(fixture.sessionFile,
      assistantTool('create-1', 'bash', { command: 'gh pr create --base main' }),
      toolResult('create-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent('gh pr create --base main'));
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-launch-plan',
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          scope: diffScope(),
          requiredLanes: [],
          launchWaves: launchWaves([], true),
          ciEvent: 'pr-create',
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(false);
    harness.sent.splice(0);

    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.message.customType).toBe('pr-boundary-launch-plan');
  });

  it('REQ-AGENT-041: honors an explicit post-boundary user bypass without fabricating acknowledgement', async () => {
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
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
  });

  it('REQ-AGENT-041: blocks five times then latches GIVEUP for the same head without acknowledging it', async () => {
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

  it('REQ-AGENT-058: reports a merged unacknowledged head once without acknowledging it', async () => {
    const fixture = makeReviewFixture();
    fixture.pr.state = 'MERGED';
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('merge-1', 'bash', { command: 'env GH_TOKEN=x gh pr merge 42' }),
      toolResult('merge-1', 'bash'),
    );

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-closed-unacknowledged',
        content: expect.any(String),
        display: true,
        details: { head: fixture.head, state: 'MERGED' },
      }),
      options: { triggerTurn: false },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
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
