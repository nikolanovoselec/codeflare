import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    dependencies: { queryPr(repo: string): Promise<PrState | undefined> },
  ): void | Promise<void>;
};
type TestPi = {
  on(event: string, handler: ExtensionHandler): void;
  sendMessage(message: SentMessage['message'], options?: SentMessage['options']): void;
};

const ALL_LANES: ReviewLane[] = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const NOW = Date.parse('2026-07-12T12:10:00.000Z');
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
    prompt: `review_range=${fixture.base}..${fixture.head}`,
  };
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

async function registerFixture(fixture: ReturnType<typeof makeReviewFixture>, cwd = fixture.repo) {
  const { registerReviewEnforcement } = await plannedEnforcement();
  const harness = makeHarness(cwd, fixture.sessionFile);
  await registerReviewEnforcement(harness.pi, {
    queryPr: async () => fixture.pr,
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Pi review reminder and settled enforcement', () => {
  it('REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits a ranged reminder and follow-up for all missing lanes', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-reminder',
        content: expect.stringContaining(`review_range=${fixture.base}..${fixture.head}`),
        display: true,
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          requiredLanes: ALL_LANES,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);

    harness.sent.splice(0);
    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-follow-up',
        content: expect.stringContaining(`review_range=${fixture.base}..${fixture.head}`),
        display: true,
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: ALL_LANES,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-036: resolves a cd-prefixed boundary through active repository memory', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(fixture.repo);
    const harness = await registerFixture(fixture, sessionRoot);

    await harness.emit('tool_result', boundaryEvent(`cd ${fixture.repo} && gh pr create --base main`));

    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-reminder',
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          requiredLanes: ALL_LANES,
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
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
    );

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([{
      message: expect.objectContaining({
        customType: 'pr-boundary-review-follow-up',
        content: expect.stringContaining(`review_range=${fixture.base}..${fixture.head}`),
        display: true,
        details: {
          head: fixture.head,
          ackHead: fixture.base,
          reviewRange: `${fixture.base}..${fixture.head}`,
          missingLanes: ['doc-updater'],
        },
      }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    }]);
    expect(ackHead(fixture.repo)).toBe(fixture.base);
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
      notification('doc-1'),
      notification('code-1', 'Error'),
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
    expect(harness.sent).toEqual([]);
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

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      harness.sent.splice(0);
      await harness.emit('agent_settled');
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.message.details).toEqual({
        head: fixture.head,
        ackHead: fixture.base,
        reviewRange: `${fixture.base}..${fixture.head}`,
        missingLanes: ALL_LANES,
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
      assistantTool('merge-1', 'bash', { command: 'gh pr merge 42' }),
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
