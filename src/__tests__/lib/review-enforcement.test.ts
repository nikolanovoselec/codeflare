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
type AppendedEntry = { customType: string; data: unknown };
type ExtensionHandler = (event: unknown, ctx: TestContext) => unknown | Promise<unknown>;
type TestWidgetContent = unknown;
type TestContext = {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  sessionManager: { getSessionFile(): string };
  ui: {
    notify(): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: TestWidgetContent, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void;
  };
};
type ServiceSpawnOptions = {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  foreground?: boolean;
  bypassQueue?: boolean;
};
type SpawnedAgent = {
  id: string;
  type: string;
  prompt: string;
  options?: ServiceSpawnOptions;
};
type TestSubagentsService = {
  spawn(type: string, prompt: string, options?: ServiceSpawnOptions): string;
  getRecord(id: string): { status: string } | undefined;
};
type CiRequest = {
  subagent_type: 'ci-monitor';
  description: string;
  prompt: string;
  run_in_background: true;
  inherit_context: false;
};
type PlannedReviewEnforcement = {
  registerReviewEnforcement(
    pi: TestPi,
    dependencies: {
      queryPr(repo: string, target?: string): Promise<PrState | undefined>;
      queryHead?(repo: string): Promise<string | undefined>;
      fetchPrHead?(repo: string, pr: PrState): Promise<boolean>;
      sleep?(delayMs: number): Promise<void>;
      headRetryDelaysMs?: number[];
      getSubagentsService?(): TestSubagentsService | undefined;
      resolveCiRequest?(input: {
        event: 'push' | 'pr-create';
        repo: string;
        pr: number;
        reviewState: 'launched' | 'not-required';
      }): Promise<CiRequest | undefined>;
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
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: SentMessage['message'], options?: SentMessage['options']): void;
  events: { on(channel: string, handler: (data: unknown) => void): () => void };
};

const ALL_LANES: ReviewLane[] = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const REVIEW_BYPASS_FILE = join(tmpdir(), `pi-review-bypass-${process.pid}`);
const SERVICE_SYMBOL = Symbol.for('@gotgenes/pi-subagents:service');
const ORIGINAL_SERVICE = (globalThis as Record<symbol, unknown>)[SERVICE_SYMBOL];
const NOW = Date.parse('2026-07-12T12:10:00.000Z');
process.env.REVIEW_BYPASS_FILE = REVIEW_BYPASS_FILE;
const roots: string[] = [];
const activeHarnesses: Array<{ emit(event: string, payload?: unknown): Promise<void> }> = [];
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

function serviceRecord(agentId: string, status: 'completed' | 'error'): Record<string, unknown> {
  return {
    type: 'custom',
    id: nextId('service-record'),
    parentId: null,
    timestamp: '2026-07-12T12:02:00.000Z',
    customType: 'subagents:record',
    data: { id: agentId, status },
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
  appended: AppendedEntry[];
  service: TestSubagentsService;
  serviceStatuses: Map<string, string>;
  spawned: SpawnedAgent[];
  widgets: Map<string, TestWidgetContent>;
  statuses: Map<string, string | undefined>;
  emit(event: string, payload?: unknown): Promise<void>;
  emitService(event: string, payload?: unknown): Promise<void>;
} {
  const handlers = new Map<string, ExtensionHandler[]>();
  const serviceHandlers = new Map<string, Array<(data: unknown) => void>>();
  const sent: SentMessage[] = [];
  const appended: AppendedEntry[] = [];
  const spawned: SpawnedAgent[] = [];
  const serviceStatuses = new Map<string, string>();
  const widgets = new Map<string, TestWidgetContent>();
  const statuses = new Map<string, string | undefined>;
  const service: TestSubagentsService = {
    spawn: (type, prompt, options) => {
      const id = nextId('agent');
      spawned.push({ id, type, prompt, options });
      serviceStatuses.set(id, 'queued');
      return id;
    },
    getRecord: (id) => {
      const status = serviceStatuses.get(id);
      return status ? { status } : undefined;
    },
  };
  const pi: TestPi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
      appendSession(sessionFile, {
        type: 'custom',
        id: nextId('custom'),
        parentId: null,
        timestamp: new Date(NOW).toISOString(),
        customType,
        data,
      });
    },
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
    events: {
      on: (channel, handler) => {
        serviceHandlers.set(channel, [...(serviceHandlers.get(channel) ?? []), handler]);
        return () => serviceHandlers.set(
          channel,
          (serviceHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
        );
      },
    },
  };
  const ctx: TestContext = {
    cwd: repo,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      notify: () => undefined,
      setStatus: (key, text) => statuses.set(key, text),
      setWidget: (key, content) => widgets.set(key, content),
    },
  };
  const harness = {
    pi,
    ctx,
    sent,
    appended,
    service,
    serviceStatuses,
    spawned,
    widgets,
    statuses,
    emit: async (event: string, payload: unknown = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    emitService: async (event: string, payload: unknown = {}) => {
      for (const handler of serviceHandlers.get(event) ?? []) handler(payload);
      await Promise.resolve();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

function latestReviewWindow(harness: ReturnType<typeof makeHarness>): Record<string, unknown> | undefined {
  return harness.appended
    .filter((entry) => entry.customType === 'codeflare:review-window')
    .at(-1)?.data as Record<string, unknown> | undefined;
}

async function registerFixture(
  fixture: ReturnType<typeof makeReviewFixture>,
  cwd = fixture.repo,
  observeTarget?: (target: string | undefined) => void,
  options?: { resolveCiRequest?: (input: {
    event: 'push' | 'pr-create';
    repo: string;
    pr: number;
    reviewState: 'launched' | 'not-required';
  }) => Promise<CiRequest | undefined> },
) {
  const { registerReviewEnforcement } = await plannedEnforcement();
  const harness = makeHarness(cwd, fixture.sessionFile);
  await registerReviewEnforcement(harness.pi, {
    queryPr: async (_repo, target) => {
      observeTarget?.(target);
      return fixture.pr;
    },
    getSubagentsService: () => harness.service,
    resolveCiRequest: options?.resolveCiRequest ?? (async ({ pr }: { pr: number }) => ({
      subagent_type: 'ci-monitor',
      description: `Monitor PR #${pr} CI`,
      prompt: `repo=owner/repo pr=${pr} head=${fixture.pr.headRefOid}`,
      run_in_background: true,
      inherit_context: false,
    })),
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

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) await harness.emit('session_shutdown');
  rmSync(REVIEW_BYPASS_FILE, { force: true });
  if (ORIGINAL_SERVICE === undefined) delete (globalThis as Record<symbol, unknown>)[SERVICE_SYMBOL];
  else (globalThis as Record<symbol, unknown>)[SERVICE_SYMBOL] = ORIGINAL_SERVICE;
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, true),
      ciEvent: 'push',
    });

    await harness.emit('agent_settled');
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'follow-up',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      missingLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, true),
      ciEvent: 'push',
    });
    expect(ackHead(fixture.repo)).toBe(fixture.base);
  });

  it('REQ-AGENT-071/REQ-AGENT-080: delegates background reviewers to the stock service widget before CI without a model launch turn', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    expect(harness.sent).toEqual([]);
    expect(harness.spawned).toEqual([]);
    const plannedEntries = readFileSync(fixture.sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'custom' && entry.customType === 'codeflare:review-window');
    expect(plannedEntries.map((entry) => entry.data)).toEqual([expect.objectContaining({
      phase: 'plan',
      head: fixture.head,
      reviewRange: `${fixture.base}..${fixture.head}`,
      requiredLanes: ALL_LANES,
      ciEvent: 'push',
    })]);

    await harness.emit('agent_settled');

    expect(harness.spawned.map((agent) => agent.type)).toEqual([...ALL_LANES, 'ci-monitor']);
    expect(harness.spawned.slice(0, 3).every((agent) =>
      agent.options?.foreground === false
      && agent.options?.inheritContext === false
      && agent.prompt.includes(`review_range=${fixture.base}..${fixture.head}`)))
      .toBe(true);
    expect(harness.spawned[3]).toMatchObject({
      type: 'ci-monitor',
      prompt: `repo=owner/repo pr=42 head=${fixture.head}`,
      options: { foreground: false, inheritContext: false, bypassQueue: true },
    });
    expect(harness.sent).toEqual([]);
    expect(harness.widgets.has('codeflare-review-agents')).toBe(true);
    expect(harness.statuses.get('codeflare-review-agents')).toBe('Review: 4 queued');

    const entries = readFileSync(fixture.sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const dispatches = entries
      .filter((entry) => entry.type === 'custom' && entry.customType === 'codeflare:subagent-dispatch')
      .map((entry) => entry.data);
    expect(dispatches).toEqual(harness.spawned.map((agent, index) => expect.objectContaining({
      agentId: agent.id,
      head: fixture.head,
      kind: index < 3 ? 'reviewer' : 'ci',
    })));

    await harness.emit('agent_settled');
    expect(harness.spawned).toHaveLength(4);
  });

  it('REQ-AGENT-091: requests one automatic adversarial triage per reviewer completion and marks the final result', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    const reviewers = harness.spawned.slice(0, 3);
    const ci = harness.spawned[3];

    for (const [index, reviewer] of reviewers.entries()) {
      harness.serviceStatuses.set(reviewer.id, 'completed');
      await harness.emitService('subagents:completed', { id: reviewer.id });
      expect(harness.sent.at(-1)).toMatchObject({
        message: {
          customType: 'codeflare:review-triage-reminder',
          details: {
            agentId: reviewer.id,
            head: fixture.head,
            lane: ALL_LANES[index],
            allRequiredReviewersCompleted: index === reviewers.length - 1,
            automaticFixes: true,
            confirmationRequired: false,
            tableColumns: ['FINDING', 'PROPOSED FIX', 'STATUS', 'DECISION'],
          },
          display: true,
        },
        options: { deliverAs: 'followUp', triggerTurn: false },
      });
    }

    expect(harness.sent).toHaveLength(3);
    harness.serviceStatuses.set(ci.id, 'completed');
    await harness.emitService('subagents:completed', { id: ci.id });
    await harness.emitService('subagents:completed', { id: reviewers[0].id });
    expect(harness.sent).toHaveLength(3);
  });

  it('REQ-AGENT-071: resolves the stock service from its published global symbol', async () => {
    const fixture = makeReviewFixture();
    const harness = makeHarness(fixture.repo, fixture.sessionFile);
    (globalThis as Record<symbol, unknown>)[SERVICE_SYMBOL] = harness.service;
    const { registerReviewEnforcement } = await plannedEnforcement();
    await registerReviewEnforcement(harness.pi, {
      queryPr: async () => fixture.pr,
      resolveCiRequest: async () => undefined,
    });
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');

    expect(harness.spawned.map((agent) => agent.type)).toEqual(ALL_LANES);
  });

  it('REQ-AGENT-074/REQ-AGENT-080: waits for every reviewer agent ID before spawning CI', async () => {
    const fixture = makeReviewFixture();
    const ciInputs: Array<Record<string, unknown>> = [];
    const harness = await registerFixture(fixture, fixture.repo, undefined, {
      resolveCiRequest: async (input) => {
        ciInputs.push(input);
        return {
          subagent_type: 'ci-monitor',
          description: 'Monitor exact-head CI',
          prompt: `repo=owner/repo pr=${input.pr} head=${fixture.head}`,
          run_in_background: true,
          inherit_context: false,
        };
      },
    });
    const spawn = harness.service.spawn;
    let failSpecOnce = true;
    harness.service.spawn = (type, prompt, options) => {
      if (type === 'spec-reviewer' && failSpecOnce) {
        failSpecOnce = false;
        throw new Error('temporary spawn failure');
      }
      return spawn(type, prompt, options);
    };
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual(['code-reviewer', 'doc-updater']);

    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual([
      'code-reviewer',
      'doc-updater',
      'spec-reviewer',
      'ci-monitor',
    ]);
    expect(ciInputs).toEqual([{
      event: 'push',
      repo: fixture.repo,
      pr: 42,
      reviewState: 'launched',
    }]);
  });

  it('REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only matching successful service records', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    appendSession(fixture.sessionFile,
      ...harness.spawned.slice(0, 3).map((agent) => serviceRecord(agent.id, 'completed')),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.head);
  });

  it('REQ-AGENT-053/REQ-AGENT-074: retries only the lane whose service record failed', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    const [code, spec, docs] = harness.spawned;
    appendSession(fixture.sessionFile,
      serviceRecord(code.id, 'error'),
      serviceRecord(spec.id, 'completed'),
      serviceRecord(docs.id, 'completed'),
    );

    await harness.emit('agent_settled');

    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(harness.spawned.map((agent) => agent.type)).toEqual([
      ...ALL_LANES,
      'ci-monitor',
      'code-reviewer',
    ]);
  });

  it('REQ-AGENT-053/REQ-AGENT-074: keeps unknown reload dispatches in flight but retries live stopped agents', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual([...ALL_LANES, 'ci-monitor']);

    const reloadedHarness = await registerFixture(fixture);
    await reloadedHarness.emit('agent_settled');
    expect(reloadedHarness.spawned).toEqual([]);

    for (const agent of harness.spawned) harness.serviceStatuses.set(agent.id, 'stopped');
    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual([
      ...ALL_LANES,
      'ci-monitor',
      ...ALL_LANES,
      'ci-monitor',
    ]);
  });

  it('REQ-AGENT-068/REQ-AGENT-080: persists an empty CI resolution so reload does not re-resolve it', async () => {
    const fixture = makeReviewFixture();
    let resolutions = 0;
    const harness = await registerFixture(fixture, fixture.repo, undefined, {
      resolveCiRequest: async () => {
        resolutions += 1;
        return undefined;
      },
    });
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');
    await harness.emit('agent_settled');

    expect(resolutions).toBe(1);
    expect(harness.spawned.map((agent) => agent.type)).toEqual(ALL_LANES);
  });

  it('REQ-AGENT-084 AC5: carries a mid-task fully-autonomous upgrade into reviewer service prompts', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    appendSession(fixture.sessionFile,
      userMessage('Start investigating this issue.'),
      userMessage('Go fully autonomous from here.'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await harness.emit('tool_result', boundaryEvent());
    await harness.emit('agent_settled');

    expect(harness.spawned.slice(0, 3).every((agent) =>
      agent.prompt.includes('autonomy_override=fully-autonomous'))).toBe(true);
    expect(harness.spawned[3]?.prompt).not.toContain('autonomy_override=fully-autonomous');
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
      appendSession(fixture.sessionFile,
        assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
        toolResult('push-1', 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent());

      expect(harness.sent, testCase.name).toEqual([]);
      expect(latestReviewWindow(harness), testCase.name).toMatchObject({
        phase: 'plan',
        head: fixture.head,
        ...(expectedAck ? { ackHead: expectedAck } : {}),
        scope: diffScope(),
        requiredLanes: ALL_LANES,
        launchWaves: launchWaves(ALL_LANES, true),
        ciEvent: 'push',
      });
      await harness.emit('agent_settled');
      expect(harness.spawned.slice(0, 3).every((agent) =>
        agent.prompt.includes('review_base=origin/main')
        && !agent.prompt.includes('review_range=')), testCase.name).toBe(true);
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

    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.head,
      scope: diffScope(),
      requiredLanes: [],
      launchWaves: launchWaves([], true),
      ciEvent: 'push',
    });
    expect(ackHead(fixture.repo)).toBe(fixture.head);
    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual(['ci-monitor']);
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, false),
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: remoteHead,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${remoteHead}`,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, true),
      ciEvent: 'push',
    });
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
    expect(latestReviewWindow(harness)).toBeUndefined();
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
      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
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

      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
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

    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      scope: diffScope(),
      requiredLanes: [],
      launchWaves: launchWaves([], true),
      ciEvent: 'push',
    });
    await harness.emit('agent_settled');
    expect(harness.spawned.map((agent) => agent.type)).toEqual(['ci-monitor']);
  });

  it('REQ-AGENT-036: resolves a cd-prefixed boundary through active repository memory', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(fixture.repo);
    const harness = await registerFixture(fixture, sessionRoot);

    await harness.emit('tool_result', boundaryEvent(`cd ${fixture.repo} && gh pr create --base main`));

    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, true),
      ciEvent: 'pr-create',
    });
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
      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
        phase: 'plan',
        head: fixture.head,
        ackHead: fixture.base,
        reviewRange: `${fixture.base}..${fixture.head}`,
        scope: diffScope(),
        requiredLanes: [],
        launchWaves: launchWaves([], true),
        ciEvent: 'push',
      });
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
      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
        head: fixture.head,
        requiredLanes: [],
        ciEvent: 'push',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-068: dispatches a git -C push against the command-selected repository', async () => {
    const fixture = makeReviewFixture();
    const sessionRoot = dirname(fixture.repo);
    rememberActiveRepo(sessionRoot);
    let queriedRepo: string | undefined;
    const harness = makeHarness(sessionRoot, fixture.sessionFile);
    const { registerReviewEnforcement } = await plannedEnforcement();
    await registerReviewEnforcement(harness.pi, {
      queryPr: async (repo) => {
        queriedRepo = repo;
        return fixture.pr;
      },
      queryHead: async () => fixture.head,
      getSubagentsService: () => harness.service,
      resolveCiRequest: async () => undefined,
    });
    const command = `git -C "${fixture.repo}" push origin pi`;
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command }),
      toolResult('push-1', 'bash'),
    );
    const previousMode = process.env.SESSION_MODE;
    process.env.SESSION_MODE = 'default';

    try {
      await harness.emit('tool_result', boundaryEvent(command));
      expect(queriedRepo).toBe(fixture.repo);
      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
        head: fixture.head,
        requiredLanes: [],
        ciEvent: 'push',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = previousMode;
    }
  });

  it('REQ-AGENT-036: resolves an explicit push refspec and PR --head without checkout-HEAD equality', async () => {
    const cases = [
      { command: 'git push origin other-commit:review-head', expectedTarget: 'review-head' },
      { command: 'gh pr create --base main --head review-head', expectedTarget: 'review-head' },
    ];

    for (const testCase of cases) {
      const fixture = makeReviewFixture();
      let observedTarget: string | undefined;
      let fetchedHead = false;
      const harness = makeHarness(fixture.repo, fixture.sessionFile);
      const { registerReviewEnforcement } = await plannedEnforcement();
      await registerReviewEnforcement(harness.pi, {
        queryPr: async (_repo, target) => {
          observedTarget = target;
          return fixture.pr;
        },
        queryHead: async () => fixture.base,
        fetchPrHead: async (_repo, pr) => {
          fetchedHead = pr.headRefOid === fixture.head;
          return fetchedHead;
        },
        getSubagentsService: () => harness.service,
        resolveCiRequest: async () => undefined,
      });
      appendSession(fixture.sessionFile,
        assistantTool('boundary-1', 'bash', { command: testCase.command }),
        toolResult('boundary-1', 'bash'),
      );

      await harness.emit('tool_result', boundaryEvent(testCase.command));

      expect(observedTarget).toBe(testCase.expectedTarget);
      expect(fetchedHead).toBe(true);
      expect(latestReviewWindow(harness)).toMatchObject({
        head: fixture.head,
        requiredLanes: ALL_LANES,
      });
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
      expect(harness.sent).toEqual([]);
      expect(harness.appended.filter((entry) => entry.customType === 'codeflare:review-window'))
        .toHaveLength(testCase.expected);
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
    expect(latestReviewWindow(harness)).toBeUndefined();
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      scope: diffScope(),
      requiredLanes: ALL_LANES,
      launchWaves: launchWaves(ALL_LANES, true),
      ciEvent: 'push',
    });
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
    expect(latestReviewWindow(harness)).toBeUndefined();
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'follow-up',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      missingLanes: ['doc-updater'],
      launchWaves: launchWaves(['doc-updater'], false),
    });
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

    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'follow-up',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      missingLanes: [],
      launchWaves: launchWaves([], true),
      ciEvent: 'push',
    });
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      head: fixture.head,
      missingLanes: ['code-reviewer'],
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
    await initialHarness.emit('agent_settled');
    appendSession(fixture.sessionFile,
      serviceRecord(initialHarness.spawned[0].id, 'completed'),
      serviceRecord(initialHarness.spawned[2].id, 'completed'),
    );

    write(fixture.repo, 'src/follow-up.ts', 'export {};\n');
    git(fixture.repo, 'add', 'src/follow-up.ts');
    git(fixture.repo, 'commit', '-m', 'unpublished follow-up');

    const reloadedHarness = await registerFixture(fixture);
    appendSession(fixture.sessionFile, serviceRecord(initialHarness.spawned[1].id, 'completed'));
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
    await harness.emit('agent_settled');
    harness.sent.splice(0);
    appendSession(fixture.sessionFile,
      ...harness.spawned.slice(0, 3).map((agent) => serviceRecord(agent.id, 'completed')),
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
    expect(harness.sent).toEqual([]);
    expect(latestReviewWindow(harness)).toMatchObject({
      phase: 'plan',
      head: fixture.head,
      ackHead: fixture.base,
      reviewRange: `${fixture.base}..${fixture.head}`,
      scope: diffScope(),
      requiredLanes: [],
      launchWaves: launchWaves([], true),
      ciEvent: 'pr-create',
    });
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(false);
    harness.sent.splice(0);

    appendSession(fixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    expect(harness.sent).toEqual([]);
    expect(harness.appended.filter((entry) => entry.customType === 'codeflare:review-window'))
      .toHaveLength(2);
  });

  it('REQ-AGENT-041 AC1/AC3/AC4: applies a one-shot bypass only from initiating direct-user wording', async () => {
    const acceptedFixture = makeReviewFixture();
    const accepted = await registerFixture(acceptedFixture);
    await accepted.emit('input', {
      text: 'Push to remote and skip review.',
      source: 'interactive',
    });
    appendSession(acceptedFixture.sessionFile,
      userMessage('Push to remote and skip review.'),
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );

    await accepted.emit('tool_result', boundaryEvent());
    await accepted.emit('agent_settled');

    expect(accepted.spawned.map((agent) => agent.type)).toEqual(['ci-monitor']);
    expect(ackHead(acceptedFixture.repo)).toBe(acceptedFixture.base);
    expect(existsSync(REVIEW_BYPASS_FILE)).toBe(false);
    expect(existsSync(join(acceptedFixture.repo, '.git/sdd-review-block-count'))).toBe(false);

    const rejectedFixture = makeReviewFixture();
    const rejected = await registerFixture(rejectedFixture);
    await rejected.emit('input', { text: 'skip review', source: 'extension' });
    await rejected.emit('input', {
      text: 'skip review',
      source: 'interactive',
      streamingBehavior: 'steer',
    });
    appendSession(rejectedFixture.sessionFile,
      assistantTool('push-2', 'bash', { command: 'git push origin pi' }),
      toolResult('push-2', 'bash'),
    );

    await rejected.emit('tool_result', boundaryEvent());
    await rejected.emit('agent_settled');

    expect(rejected.spawned.map((agent) => agent.type)).toEqual([...ALL_LANES, 'ci-monitor']);
  });

  it('REQ-AGENT-041/REQ-AGENT-074: retries immediate service failures five times then latches GIVEUP', async () => {
    const fixture = makeReviewFixture();
    const harness = await registerFixture(fixture);
    harness.service.spawn = () => { throw new Error('service unavailable'); };
    appendSession(fixture.sessionFile,
      assistantTool('push-1', 'bash', { command: 'git push origin pi' }),
      toolResult('push-1', 'bash'),
    );
    await harness.emit('tool_result', boundaryEvent());
    harness.sent.splice(0);
    appendSession(fixture.sessionFile, assistantTool('ci-1', 'subagent', ciArgs(fixture.head)));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await harness.emit('agent_settled');
      expect(harness.sent).toEqual([]);
      expect(latestReviewWindow(harness)).toMatchObject({
        phase: 'follow-up',
        head: fixture.head,
        ackHead: fixture.base,
        reviewRange: `${fixture.base}..${fixture.head}`,
        missingLanes: ALL_LANES,
        launchWaves: launchWaves(ALL_LANES, false),
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
    expect(latestReviewWindow(harness)).toBeUndefined();
    expect(ackHead(fixture.repo)).toBe(fixture.base);
    expect(existsSync(join(fixture.repo, '.git/sdd-review-block-count'))).toBe(false);
  });
});
