import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberActiveRepo } from '../../../preseed/agents/pi/extensions/active-repo-memory';
import { completionPath, readCompletion, writeCompletion, type ReviewIdentity } from '../../../preseed/agents/pi/extensions/review-completion-state';

type ReviewLane = 'code-reviewer' | 'spec-reviewer' | 'doc-updater';
type PrState = {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: 'main' | 'master' | 'develop';
  headRefOid: string;
  headRefName: string;
  number: number;
};
type Handler = (event: any, ctx: TestContext) => unknown | Promise<unknown>;
type TestContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getSessionFile(): string;
    getEntries(): Record<string, unknown>[];
    getHeader(): { parentSession?: string };
  };
  ui: { select(title: string, options: string[]): Promise<string | undefined>; notify(): void };
};

const roots: string[] = [];
let sequence = 0;
const activeRepoMemory = globalThis as { [key: symbol]: string | undefined };
const activeRepoKey = Symbol.for('codeflare.activeRepo');

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo: string, path: string, contents: string): void {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function fixture(options: { child?: boolean; sdd?: boolean } = {}) {
  const home = tempRoot('review-home-');
  const repo = tempRoot('review-repo-');
  git(repo, 'init', '-q');
  git(repo, 'branch', '-M', 'feature');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  if (options.sdd !== false) write(repo, 'sdd/README.md', '# SDD\n');
  write(repo, 'README.md', '# Repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/review.ts', 'export const changed = true;\n');
  if (options.sdd !== false) write(repo, 'sdd/spec/review.md', '# Review\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'change');
  const head = git(repo, 'rev-parse', 'HEAD');
  const sessionFile = join(repo, 'session.jsonl');
  writeFileSync(sessionFile, `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'session',
    cwd: repo,
    ...(options.child ? { parentSession: '/tmp/parent.jsonl' } : {}),
  })}\n`, 'utf8');
  const pr: PrState = {
    state: 'OPEN',
    baseRefName: 'main',
    headRefOid: head,
    headRefName: 'feature',
    number: 42,
  };
  const identity: ReviewIdentity = {
    gitHost: 'github.com',
    repository: 'owner/repo',
    pr: 42,
    branch: 'feature',
    base: 'main',
    head,
  };
  return { home, repo, base, head, sessionFile, pr, identity };
}

function append(file: string, ...entries: Record<string, unknown>[]): void {
  appendFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'message',
    id: `message-${sequence += 1}`,
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: arguments_ }] },
  };
}

function toolResult(id: string, name: string): Record<string, unknown> {
  return {
    type: 'message',
    id: `result-${sequence += 1}`,
    message: { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false },
  };
}

function notification(id: string, result = ''): Record<string, unknown> {
  return {
    type: 'custom_message',
    id: `notification-${sequence += 1}`,
    customType: 'subagent-notification',
    content: `<task-notification><tool-use-id>${id}</tool-use-id><status>Done</status>${result}</task-notification>`,
  };
}

function triage(ciResult?: 'failure' | 'timeout', formatted = false): Record<string, unknown> {
  const result = ciResult ? `${formatted ? '`' : ''}CI_RESULT ${ciResult}${formatted ? '`' : ''}` : undefined;
  return {
    type: 'message',
    id: `triage-${sequence += 1}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |',
          '|---|---|---|---|---|',
          ...(result ? [`| Exact-head CI | Valid | ${result} | Proportional | Fix CI |`] : []),
        ].join('\n'),
      }],
    },
  };
}

function malformedFailureTriage(): Record<string, unknown> {
  return {
    type: 'message',
    id: `triage-${sequence += 1}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |',
          '|---|---|---|---|---|',
          '| Exact-head CI | Valid failure | CI_RESULT failure: fix the type error | Proportional | Fix CI |',
        ].join('\n'),
      }],
    },
  };
}

function reviewerPrompt(head: string, lane: ReviewLane): string {
  return [
    'scope=diff',
    'review_base=origin/main',
    `output_file=/tmp/codeflare-pr-42-${head.slice(0, 12)}-${lane}.md`,
  ].join('\n');
}

function appendSuccessfulRound(input: ReturnType<typeof fixture>, lanes: ReviewLane[], prefix: string): void {
  append(input.sessionFile,
    ...lanes.flatMap((lane, index) => {
      const id = `${prefix}-review-${index}`;
      return [
        toolCall(id, 'subagent', {
          subagent_type: lane,
          run_in_background: true,
          inherit_context: false,
          prompt: reviewerPrompt(input.head, lane),
        }),
        toolResult(id, 'subagent'),
        notification(id),
      ];
    }),
    toolCall(`${prefix}-ci`, 'subagent', {
      subagent_type: 'ci-monitor',
      run_in_background: true,
      inherit_context: false,
      prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
    }),
    toolResult(`${prefix}-ci`, 'subagent'),
    notification(`${prefix}-ci`, `<result>CI_RESULT success\npr=42 head=${input.head} repo=owner/repo</result>`),
    triage(),
  );
}

function boundary(command: string, id = `boundary-${sequence += 1}`, output = 'ok') {
  return {
    toolName: 'bash',
    toolCallId: id,
    input: { command },
    args: { command },
    result: { isError: false, content: [{ type: 'text', text: output }] },
  };
}

function originalVariablePathPush(input: ReturnType<typeof fixture>): string {
  return [
    'set -euo pipefail',
    `repo=${input.repo}`,
    `[ "$(grep -Rhc '^### REQ-SESSION-034:' "$repo/sdd/spec" | awk '{s+=$1} END {print s}')" = 1 ]`,
    `grep -Fq 'persists one fallback baseline across a second coordinator reconstruction' "$repo/src/__tests__/container-metrics.test.ts"`,
    `grep -Fq 'keeps host transport healthy when startup-reference storage cannot be read' "$repo/src/__tests__/container-metrics.test.ts"`,
    `sed -n '150,175p' "$repo/sdd/spec/session-lifecycle.md"`,
    `git -C "$repo" diff --check`,
    `git -C "$repo" diff -- sdd/spec/session-lifecycle.md sdd/spec/changes.md`,
    `git -C "$repo" add sdd/spec/session-lifecycle.md sdd/spec/changes.md`,
    `git -C "$repo" commit -m "docs: isolate durable idle baseline"`,
    `git -C "$repo" push origin feature`,
  ].join('\n');
}

async function harness(
  input: ReturnType<typeof fixture>,
  decisions: Array<string | undefined> = ['Launch review'],
  dependencyOverrides: Record<string, any> = {},
) {
  process.env.HOME = input.home;
  process.env.CODEFLARE_SYNC_DAEMON_PIDFILE = join(input.home, 'missing.pid');
  const { registerReviewEnforcement } = await import('../../../preseed/agents/pi/extensions/review-enforcement');
  const handlers = new Map<string, Handler[]>();
  const { goalControlAvailable = true, ...reviewDependencyOverrides } = dependencyOverrides;
  const sent: Array<{ customType: string; content?: string; details?: Record<string, unknown> }> = [];
  const prompts: Array<{ title: string; options: string[] }> = [];
  const entries = () => readFileSync(input.sessionFile, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.type !== 'session');
  let activeTools = ['read', 'bash'];
  const goalActions: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    events: {
      emit: vi.fn((_channel: string, request: any) => {
        if (!goalControlAvailable) return;
        request.accepted();
        goalActions.push(request.action);
        const status = request.action === 'pause' ? 'paused' : 'active';
        append(input.sessionFile, { type: 'custom', customType: 'goal-state', data: { goal: { id: request.goalId, status } } });
        request.respond({ ok: true, goalId: request.goalId, status });
      }),
    },
    appendEntry: (customType: string, data: unknown) => append(input.sessionFile, { type: 'custom', customType, data }),
    sendMessage: (message: { customType: string; content?: string; details?: Record<string, unknown> }) => {
      sent.push(message);
      append(input.sessionFile, { type: 'custom_message', ...message });
    },
    getActiveTools: () => activeTools,
    getAllTools: () => [{ name: 'read', description: '' }, { name: 'bash', description: '' }, { name: 'subagent', description: '' }],
    setActiveTools: (names: string[]) => { activeTools = names; },
  };
  const ctx: TestContext = {
    cwd: input.repo,
    hasUI: true,
    sessionManager: {
      getSessionFile: () => input.sessionFile,
      getEntries: entries,
      getHeader: () => optionsHeader(input),
    },
    ui: {
      select: async (title, options) => {
        prompts.push({ title, options });
        return decisions.shift();
      },
      notify: () => undefined,
    },
  };
  registerReviewEnforcement(pi as never, {
    queryPr: async () => input.pr,
    queryHead: async () => input.head,
    queryBranch: async () => input.pr.headRefName,
    queryRepository: async () => ({ gitHost: 'github.com', repository: 'owner/repo' }),
    headRetryDelaysMs: [0],
    ...reviewDependencyOverrides,
  });
  return {
    ctx,
    sent,
    prompts,
    goalActions,
    activeTools: () => activeTools,
    emit: async (event: string, payload: any = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

function optionsHeader(input: ReturnType<typeof fixture>): { parentSession?: string } {
  const header = JSON.parse(readFileSync(input.sessionFile, 'utf8').split('\n', 1)[0]) as { parentSession?: string };
  return header.parentSession ? { parentSession: header.parentSession } : {};
}

let savedActiveRepo: string | undefined;

beforeEach(() => {
  savedActiveRepo = activeRepoMemory[activeRepoKey];
  delete activeRepoMemory[activeRepoKey];
});

afterEach(() => {
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  if (savedActiveRepo === undefined) delete activeRepoMemory[activeRepoKey];
  else activeRepoMemory[activeRepoKey] = savedActiveRepo;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Pi marker-or-dialog review ingress', () => {
  it('prunes marker state once on first root startup without traversing symlinks', async () => {
    const input = fixture();
    const stateRoot = join(input.home, '.codeflare/review-state/v1');
    const old = { ...input.identity, head: 'c'.repeat(40) };
    writeCompletion(old, { root: stateRoot, now: () => new Date(0) });
    const outside = join(input.home, 'outside');
    mkdirSync(outside);
    const outsideMarker = join(outside, 'keep.json');
    writeFileSync(outsideMarker, '{}');
    symlinkSync(outside, join(stateRoot, 'linked'));
    const app = await harness(input, [undefined, undefined]);

    await app.emit('session_start', { reason: 'startup' });
    expect(existsSync(completionPath(old, stateRoot))).toBe(false);
    expect(existsSync(outsideMarker)).toBe(true);

    const later = { ...input.identity, repository: 'owner/unrelated', head: 'd'.repeat(40) };
    writeCompletion(later, { root: stateRoot, now: () => new Date(0) });
    await app.emit('session_start', { reason: 'resume' });
    expect(existsSync(completionPath(later, stateRoot))).toBe(true);
  });

  it('asks on startup with simple copy and exact choices', async () => {
    const input = fixture();
    const app = await harness(input, [undefined]);
    await app.emit('session_start', { reason: 'startup' });

    expect(app.prompts).toEqual([{
      title: 'Review completion is missing for repo:feature.\nReason: no saved completion.',
      options: ['Mark review complete', 'Launch review'],
    }]);
    expect(app.prompts[0]?.title).not.toContain(input.head);
    expect(app.sent).toHaveLength(0);
  });

  it('asks on non-delivery exposures but keeps inert commands silent', async () => {
    const input = fixture();
    const app = await harness(input, Array.from({ length: 4 }, () => undefined));
    for (const command of [
      'git switch feature',
      'git checkout feature',
      'gh pr checkout 42',
      'git pull',
      'git status',
    ]) await app.emit('tool_result', boundary(command));

    expect(app.prompts).toHaveLength(4);
    expect(app.sent).toHaveLength(0);
  });

  it('asks only when a successful PR merge changes checkout identity into an unacknowledged open PR', async () => {
    const input = fixture();
    const mergedHead = 'a'.repeat(40);
    let branch = 'feature';
    let head = input.head;
    const app = await harness(input, [undefined], {
      queryBranch: async () => branch,
      queryHead: async () => head,
      queryPr: async () => ({ ...input.pr, headRefName: branch, headRefOid: head, number: 969 }),
    });
    const event = boundary('git merge --ff-only origin/develop', 'merge-transition');

    await app.emit('tool_call', event);
    branch = 'develop';
    head = mergedHead;
    await app.emit('tool_result', event);

    expect(app.prompts).toEqual([{
      title: 'Review completion is missing for repo:develop.\nReason: no saved completion.',
      options: ['Mark review complete', 'Launch review'],
    }]);
    expect(app.sent).toHaveLength(0);
  });

  it('keeps PR merge commands silent without a successful checkout transition or with an exact marker', async () => {
    const input = fixture();
    const mergedHead = 'b'.repeat(40);
    let branch = 'feature';
    let head = input.head;
    const dependencies = {
      queryBranch: async () => branch,
      queryHead: async () => head,
      queryPr: async () => ({ ...input.pr, headRefName: branch, headRefOid: head, number: 969 }),
    };
    const unchanged = await harness(input, [], dependencies);
    const unchangedEvent = boundary('gh pr merge 976 --merge', 'merge-unchanged');
    await unchanged.emit('tool_call', unchangedEvent);
    await unchanged.emit('tool_result', unchangedEvent);
    expect(unchanged.prompts).toHaveLength(0);

    const failed = await harness(input, [], dependencies);
    const failedEvent = boundary('gh pr merge 976 --merge', 'merge-failed');
    failedEvent.result.isError = true;
    await failed.emit('tool_call', failedEvent);
    branch = 'develop';
    head = mergedHead;
    await failed.emit('tool_result', failedEvent);
    expect(failed.prompts).toHaveLength(0);

    const marked = await harness(input, [], dependencies);
    const markedEvent = boundary('gh pr merge 976 --merge', 'merge-marked');
    branch = 'feature';
    head = input.head;
    await marked.emit('tool_call', markedEvent);
    branch = 'develop';
    head = mergedHead;
    writeCompletion({ ...input.identity, pr: 969, branch, head }, { root: join(input.home, '.codeflare/review-state/v1') });
    await marked.emit('tool_result', markedEvent);
    expect(marked.prompts).toHaveLength(0);
    expect(marked.sent).toHaveLength(0);
  });

  it('keeps an ordinary classified boundary authoritative in a compound merge command', async () => {
    const input = fixture();
    const app = await harness(input, []);
    const event = boundary('gh pr merge 976 --merge && git push origin feature', 'merge-then-push');

    await app.emit('tool_call', event);
    await app.emit('tool_result', event);

    expect(app.prompts).toHaveLength(0);
    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);
    expect(app.sent[0]?.details).toMatchObject({ ciEvent: 'push', head: input.head });
  });

  async function expectAutomaticDeliveryPlan(command: string, hasUI = true) {
    const input = fixture();
    const app = await harness(input, []);
    app.ctx.hasUI = hasUI;
    if (!hasUI) app.ctx.ui = undefined as never;
    await app.emit('tool_result', boundary(command, 'delivery-1'));

    expect(app.prompts).toHaveLength(0);
    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);
    expect(app.sent[0]?.details).toMatchObject({
      head: input.head,
      requiredLanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
    });
    expect(app.sent[0]?.content).toContain('verify that it is evidence-backed and in scope');
    expect(app.sent[0]?.content).toContain('judge the finding separately from its proposed fix');
    expect(app.sent[0]?.content).toContain('reject unsupported or overengineered proposals');
    expect(app.sent[0]?.content).toContain('prefer the smallest correction that reuses existing machinery');
  }

  it('ignores protected-base delivery in a repository without SDD', async () => {
    const input = fixture({ sdd: false });
    const app = await harness(input, []);

    await app.emit('tool_result', boundary('git push origin feature', 'push-without-sdd'));

    expect(app.prompts).toHaveLength(0);
    expect(app.sent).toHaveLength(0);
  });

  it('automatically emits the exact review plan after successful push', async () => {
    await expectAutomaticDeliveryPlan('git push origin feature');
  });

  it('resolves one preceding literal git -C variable assignment for a push boundary', async () => {
    const input = fixture();
    const app = await harness(input);
    app.ctx.cwd = dirname(input.repo);
    const id = 'literal-variable-push';

    await app.emit('tool_result', boundary(originalVariablePathPush(input), id));

    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]).toMatchObject({
      customType: 'pr-boundary-launch-plan',
      details: { repo: input.repo, head: input.head, boundaryToolUseId: id, ciEvent: 'push' },
    });
  });

  it('preserves complete literal relative and quoted-space git -C paths', async () => {
    const input = fixture();
    const app = await harness(input);
    app.ctx.cwd = dirname(input.repo);
    const relative = `./${basename(input.repo)}`;

    await app.emit('tool_result', boundary(`git -C ${relative} push origin feature`, 'relative-path'));
    expect(app.sent[0]?.details).toMatchObject({ repo: input.repo, ciEvent: 'push' });

    const workspace = tempRoot('review-spaced-');
    const spaced = join(workspace, 'repo with spaces');
    symlinkSync(input.repo, spaced, 'dir');
    const spacedApp = await harness(input);
    spacedApp.ctx.cwd = workspace;
    await spacedApp.emit('tool_result', boundary('git -C "./repo with spaces" push origin feature', 'spaced-path'));
    expect(spacedApp.sent[0]?.details).toMatchObject({ repo: spaced, ciEvent: 'push' });
  });

  it.each([
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && repo=$(pwd) && git -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && unset -v repo && git -C "$repo" push origin feature`,
    () => `. /tmp/untrusted && git -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && printf -v repo %s ${input.repo} && git -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `(repo=${input.repo}; git -C "$repo" push origin feature)`,
    (input: ReturnType<typeof fixture>) => `if true; then repo=${input.repo}; fi\ngit -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && git -C '$repo' push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && git -C "${'${repo}'}" push origin feature`,
    () => `git -C "$(pwd)" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && command git -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && git -c x=y -C "$repo" push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && git -C "$repo"/other push origin feature`,
    (input: ReturnType<typeof fixture>) => `git -C "${input.repo}"/other push origin feature`,
    (_input: ReturnType<typeof fixture>) => `git -C/another/repo push origin feature`,
    (input: ReturnType<typeof fixture>) => `repo=${input.repo} && git -C $repo push origin feature`,
  ])('does not resolve an ambiguous or unsupported git -C variable push boundary', async (command) => {
    const input = fixture();
    const other = fixture();
    const queryPr = vi.fn(async () => input.pr);
    const app = await harness(input, [], { queryPr });
    app.ctx.cwd = other.repo;

    await app.emit('tool_result', boundary(command(input)));

    expect(queryPr).not.toHaveBeenCalled();
    expect(app.sent).toHaveLength(0);
  });

  it('activates subagent and emits independent launch waves before ending the boundary turn', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-tools'));

    expect(app.activeTools()).toContain('subagent');
    expect(app.sent[0]).toMatchObject({
      customType: 'pr-boundary-launch-plan',
      details: {
        launchWaves: [
          ['code-reviewer', 'spec-reviewer', 'doc-updater'],
          ['ci-monitor'],
        ],
      },
    });
    expect(app.sent[0]?.content).toContain('After the final launch:** End this turn immediately.');
  });

  it('emits copy-ready standalone reviewer assignment contracts without punctuation', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-contracts'));

    const content = app.sent[0]?.content ?? '';
    for (const lane of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      expect(content).toContain([
        `- \`${lane}\``,
        '```text',
        'scope=diff',
        'review_base=origin/main',
        `output_file=/tmp/codeflare-pr-42-${input.head.slice(0, 12)}-${lane}.md`,
        '```',
      ].join('\n'));
    }
    expect(content).not.toMatch(/output_file=\S+\.md[.,]/);
  });

  it('automatically emits the exact review plan after successful PR creation without requiring UI', async () => {
    await expectAutomaticDeliveryPlan('gh pr create --base main', false);
  });

  it('uses the exact created PR URL with the remembered checkout from a workspace CWD', async () => {
    const input = fixture();
    const queryPr = vi.fn(async () => input.pr);
    const app = await harness(input, [], { queryPr });
    const workspace = dirname(input.repo);
    app.ctx.cwd = workspace;
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      'workspace-pr-create',
      'https://github.com/owner/repo/pull/42\n',
    ));

    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);
    expect(app.sent[0]?.details).toMatchObject({
      prNumber: 42,
      head: input.head,
      boundaryToolUseId: 'workspace-pr-create',
      ciEvent: 'pr-create',
    });
    expect(queryPr).toHaveBeenCalledTimes(2);
    expect(queryPr).toHaveBeenNthCalledWith(1, input.repo, 'https://github.com/owner/repo/pull/42');
    expect(queryPr).toHaveBeenNthCalledWith(2, input.repo, 'https://github.com/owner/repo/pull/42');

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      'workspace-pr-create-repeat',
      'https://github.com/owner/repo/pull/42\n',
    ));
    expect(app.sent).toHaveLength(1);
  });

  it.each([
    ['no created PR URL', 'ok'],
    ['multiple created PR URLs', 'https://github.com/owner/repo/pull/42\nhttps://github.com/owner/repo/pull/43\n'],
    ['a malformed created PR URL', 'https://[/owner/repo/pull/42\n'],
    ['a different host', 'https://other.example/owner/repo/pull/42\n'],
    ['a different repository', 'https://github.com/other/repo/pull/42\n'],
  ])('does not use the remembered checkout for workspace PR creation with %s', async (_case, output) => {
    const input = fixture();
    const app = await harness(input, []);
    app.ctx.cwd = dirname(input.repo);
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      `workspace-pr-create-${output.length}`,
      output,
    ));

    expect(app.sent).toHaveLength(0);
  });

  it('does not fall back when a workspace PR creation has no remembered checkout', async () => {
    const input = fixture();
    const app = await harness(input, []);
    app.ctx.cwd = dirname(input.repo);

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      'workspace-pr-create-no-memory',
      'https://github.com/owner/repo/pull/42\n',
    ));

    expect(app.sent).toHaveLength(0);
  });

  it('does not replace an explicit checkout with remembered memory', async () => {
    const input = fixture();
    const other = fixture();
    const queryRepository = vi.fn(async (repo: string) => ({
      gitHost: 'github.com',
      repository: repo === other.repo ? 'other/repo' : 'owner/repo',
    }));
    const queryPr = vi.fn(async () => input.pr);
    const app = await harness(input, [], { queryRepository, queryPr });
    app.ctx.cwd = dirname(input.repo);
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      `cd ${other.repo} && gh pr create --repo owner/repo --base main --head feature`,
      'workspace-pr-create-explicit-checkout',
      'https://github.com/owner/repo/pull/42\n',
    ));

    expect(queryRepository).toHaveBeenCalledWith(other.repo);
    expect(queryPr).not.toHaveBeenCalled();
    expect(app.sent).toHaveLength(0);
  });

  it.each([
    ['a different branch', (input: ReturnType<typeof fixture>) => ({ ...input.pr, headRefName: 'other' })],
    ['a different head', (input: ReturnType<typeof fixture>) => ({ ...input.pr, headRefOid: input.base })],
  ])('does not emit a plan when the exact created PR has %s', async (_case, result) => {
    const input = fixture();
    const queryPr = vi.fn(async () => result(input));
    const app = await harness(input, [], { queryPr, headRetryDelaysMs: [0] });
    app.ctx.cwd = dirname(input.repo);
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      `workspace-pr-create-${_case}`,
      'https://github.com/owner/repo/pull/42\n',
    ));

    expect(queryPr).toHaveBeenCalledWith(input.repo, 'https://github.com/owner/repo/pull/42');
    expect(app.sent).toHaveLength(0);
  });

  it('does not fall back after an ambiguous cd path', async () => {
    const input = fixture();
    const app = await harness(input, []);
    app.ctx.cwd = dirname(input.repo);
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      'cd "$unknown" && gh pr create --repo owner/repo --base main --head feature',
      'workspace-pr-create-ambiguous-cd',
      'https://github.com/owner/repo/pull/42\n',
    ));

    expect(app.sent).toHaveLength(0);
  });

  it('retains the exact created PR target through completion lookup', async () => {
    const input = fixture();
    const queryPr = vi.fn(async () => input.pr);
    const app = await harness(input, [], { queryPr });
    app.ctx.cwd = dirname(input.repo);
    rememberActiveRepo(input.repo);

    await app.emit('tool_result', boundary(
      'gh pr create --repo owner/repo --base main --head feature',
      'workspace-pr-create-completion',
      'https://github.com/owner/repo/pull/42\n',
    ));
    await app.emit('agent_end');
    appendSuccessfulRound(input, ['code-reviewer', 'spec-reviewer', 'doc-updater'], 'workspace-completion');
    await app.emit('agent_end');

    expect(queryPr).toHaveBeenCalledTimes(3);
    expect(queryPr).toHaveBeenNthCalledWith(3, input.repo, 'https://github.com/owner/repo/pull/42');
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-fix-follow-up',
    ]);
  });

  it('automatically emits the exact review plan after successful PR reopen without requiring UI', async () => {
    await expectAutomaticDeliveryPlan('gh pr reopen 42', false);
  });

  it('retries delivery while the authoritative PR head is synchronizing', async () => {
    const input = fixture();
    const stale = { ...input.pr, headRefOid: input.base };
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const app = await harness(input, [], {
      queryPr: async () => { calls += 1; return calls === 1 ? stale : input.pr; },
      headRetryDelaysMs: [0, 1],
      sleep,
    });
    await app.emit('tool_result', boundary('git push origin feature', 'push-retry'));

    expect(sleep).toHaveBeenCalledWith(1);
    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);
  });

  it('does not retry an unrelated push while the current PR head is stale', async () => {
    const input = fixture();
    const stale = { ...input.pr, headRefOid: input.base };
    const sleep = vi.fn(async () => undefined);
    const queryPr = vi.fn(async () => stale);
    const app = await harness(input, [], {
      queryPr,
      headRetryDelaysMs: [0, 1, 3],
      sleep,
    });
    await app.emit('tool_result', boundary('git push origin unrelated', 'push-unrelated-stale'));

    expect(queryPr).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(app.sent).toHaveLength(0);
  });

  it('keeps unrelated PR reopen delivery inert', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('gh pr reopen 99', 'reopen-unrelated'));
    await app.emit('tool_result', boundary('gh --repo other/repo pr reopen 42', 'reopen-other-repo'));

    expect(app.prompts).toHaveLength(0);
    expect(app.sent).toHaveLength(0);
  });

  it('repeats after cancellation and stays silent after marking complete', async () => {
    const input = fixture();
    const app = await harness(input, [undefined, 'Mark review complete']);
    await app.emit('tool_result', boundary('git pull'));
    await app.emit('tool_result', boundary('git pull'));
    await app.emit('tool_result', boundary('git pull'));

    expect(app.prompts).toHaveLength(2);
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
    expect(app.sent).toHaveLength(0);
  });

  it('honors an existing user-scoped marker without prompting', async () => {
    const input = fixture();
    writeCompletion(input.identity, {
      root: join(input.home, '.codeflare/review-state/v1'),
    });
    const app = await harness(input);
    await app.emit('session_start', { reason: 'resume' });
    await app.emit('tool_result', boundary('git push origin feature'));

    expect(app.prompts).toHaveLength(0);
    expect(app.sent).toHaveLength(0);
  });

  it('launches current contextual reviewers and CI and suppresses dialogs while active', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-1'));
    await app.emit('tool_result', boundary('git pull', 'pull-2'));

    expect(app.prompts).toHaveLength(0);
    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);
    expect(app.sent[0]?.details).toMatchObject({
      head: input.head,
      requiredLanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
      ciEvent: 'push',
    });
    expect(app.sent[0]?.content).toContain('output_file=/tmp/codeflare-pr-42-');
  });

  it('keeps concurrent delivery identities independent while suppressing only an active exact round', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-first'));
    write(input.repo, 'src/next.ts', 'export const next = true;\n');
    git(input.repo, 'add', 'src/next.ts');
    git(input.repo, 'commit', '-m', 'next review head');
    input.head = git(input.repo, 'rev-parse', 'HEAD');
    input.pr.headRefOid = input.head;
    input.identity.head = input.head;
    await app.emit('tool_result', boundary('git push origin feature', 'push-next'));

    expect(app.sent.filter((message) => message.customType === 'pr-boundary-launch-plan').map((message) => message.details?.head))
      .toEqual([expect.any(String), input.head]);
  });

  it('acknowledges a valid zero-lane delta and emits only independent CI', async () => {
    const input = fixture();
    writeCompletion(input.identity, {
      root: join(input.home, '.codeflare/review-state/v1'),
    });
    write(input.repo, 'graphify-out/graph.json', '{}\n');
    git(input.repo, 'add', 'graphify-out/graph.json');
    git(input.repo, 'commit', '-m', 'refresh graph');
    input.head = git(input.repo, 'rev-parse', 'HEAD');
    input.pr.headRefOid = input.head;
    input.identity.head = input.head;
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-generated'));

    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.details?.requiredLanes).toEqual([]);
    expect(app.sent[0]?.content).toContain('No reviewer launch is required; start CI now.');
    expect(app.sent[0]?.content).not.toContain('JOINT TRIAGE');
    expect(app.sent[0]?.content).not.toContain('FIX');
  });

  it.each([
    () => 'git push origin feature',
    (input: ReturnType<typeof fixture>) => originalVariablePathPush(input),
  ])('stamps completion only after terminal evidence and canonical triage, then emits FIX', async (command) => {
    const input = fixture();
    const app = await harness(input, []);
    const commandText = command(input);
    if (commandText.includes('git -C')) app.ctx.cwd = dirname(input.repo);
    await app.emit('tool_result', boundary(commandText, 'push-1'));
    await app.emit('agent_end');

    const plan = app.sent[0]!;
    const lanes = plan.details?.requiredLanes as ReviewLane[];
    const launches = lanes.flatMap((lane, index) => {
      const id = `review-${index}`;
      return [
        toolCall(id, 'subagent', {
          subagent_type: lane,
          run_in_background: true,
          inherit_context: false,
          prompt: reviewerPrompt(input.head, lane),
        }),
        toolResult(id, 'subagent'),
        notification(id),
      ];
    });
    const ciId = 'ci-1';
    append(input.sessionFile,
      ...launches,
      toolCall(ciId, 'subagent', {
        subagent_type: 'ci-monitor',
        run_in_background: true,
        inherit_context: false,
        prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
      }),
      toolResult(ciId, 'subagent'),
      notification(ciId, `<result>CI_RESULT success\npr=42 head=${input.head} repo=owner/repo</result>`),
      triage(),
    );
    await app.emit('agent_end');

    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-fix-follow-up',
    ]);
  });

  it('treats every exact-head CI result as terminal and writes completion before FIX', async () => {
    for (const result of ['success', 'failure', 'timeout'] as const) {
      const input = fixture();
      const app = await harness(input, []);
      await app.emit('tool_result', boundary('git push origin feature', `push-${result}`));
      await app.emit('agent_end');
      const lanes = app.sent[0]!.details?.requiredLanes as ReviewLane[];
      append(input.sessionFile,
        ...lanes.flatMap((lane, index) => {
          const id = `${result}-review-${index}`;
          return [
            toolCall(id, 'subagent', {
              subagent_type: lane,
              run_in_background: true,
              inherit_context: false,
              prompt: reviewerPrompt(input.head, lane),
            }),
            toolResult(id, 'subagent'),
            notification(id),
          ];
        }),
        toolCall(`${result}-ci`, 'subagent', {
          subagent_type: 'ci-monitor',
          run_in_background: true,
          inherit_context: false,
          prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
        }),
        toolResult(`${result}-ci`, 'subagent'),
        notification(`${result}-ci`, `<result>CI_RESULT ${result}\npr=42 head=${input.head} repo=owner/repo</result>`),
        triage(result === 'success' ? undefined : result, true),
      );
      await app.emit('agent_end');

      const marker = readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') });
      const fix = app.sent.find((message) => message.customType === 'pr-boundary-fix-follow-up');
      expect(marker.status).toBe('complete');
      expect(fix).toBeDefined();
    }
  });

  it('keeps a fully terminal round until canonical triage arrives', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-awaiting-triage'));
    await app.emit('agent_end');
    const lanes = app.sent[0]!.details?.requiredLanes as ReviewLane[];
    append(input.sessionFile,
      ...lanes.flatMap((lane, index) => {
        const id = `awaiting-review-${index}`;
        return [
          toolCall(id, 'subagent', {
            subagent_type: lane,
            run_in_background: true,
            inherit_context: false,
            prompt: reviewerPrompt(input.head, lane),
          }),
          toolResult(id, 'subagent'),
          notification(id),
        ];
      }),
      toolCall('awaiting-ci', 'subagent', {
        subagent_type: 'ci-monitor',
        run_in_background: true,
        inherit_context: false,
        prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
      }),
      toolResult('awaiting-ci', 'subagent'),
      notification('awaiting-ci', `<result>CI_RESULT success\npr=42 head=${input.head} repo=owner/repo</result>`),
    );
    await app.emit('agent_end');
    expect(app.sent.some((message) => message.customType === 'pr-boundary-fix-follow-up')).toBe(false);

    append(input.sessionFile, triage());
    await app.emit('agent_settled');
    expect(app.sent.some((message) => message.customType === 'pr-boundary-fix-follow-up')).toBe(true);
  });

  it('reports malformed reviewer and CI launches once, then accepts corrected launches', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-rejected-launches'));
    await app.emit('agent_end');
    const requiredLanes = app.sent[0]?.details?.requiredLanes;
    expect(Array.isArray(requiredLanes)).toBe(true);
    const lane = (requiredLanes as ReviewLane[])[0]!;

    append(input.sessionFile,
      toolCall('bad-review', 'subagent', {
        subagent_type: lane,
        run_in_background: true,
        inherit_context: false,
        max_turns: 7,
        prompt: reviewerPrompt(input.head, lane),
      }),
      toolResult('bad-review', 'subagent'),
      toolCall('bad-inherit', 'subagent', {
        subagent_type: lane,
        run_in_background: true,
        prompt: reviewerPrompt(input.head, lane),
      }),
      toolResult('bad-inherit', 'subagent'),
      toolCall('bad-ci', 'subagent', {
        subagent_type: 'ci-monitor',
        run_in_background: true,
        inherit_context: false,
        prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: '0'.repeat(40), cwd: input.repo }),
      }),
      toolResult('bad-ci', 'subagent'),
    );

    await app.emit('agent_settled');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-launch-rejection',
      'pr-boundary-launch-rejection',
      'pr-boundary-launch-rejection',
    ]);
    expect(app.sent[1]?.content).toContain('max_turns must be omitted');
    expect(app.sent[2]?.content).toContain('inherit_context must be false');
    expect(app.sent[3]?.content).toContain(`prompt head must equal ${input.head}`);

    await app.emit('agent_settled');
    expect(app.sent).toHaveLength(4);

    appendSuccessfulRound(input, app.sent[0]!.details?.requiredLanes as ReviewLane[], 'corrected');
    await app.emit('agent_settled');
    expect(app.sent.at(-1)?.customType).toBe('pr-boundary-fix-follow-up');
  });

  it('requests one triage republish when the table predates the final terminal result', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-early-triage'));
    await app.emit('agent_end');
    const lanes = app.sent[0]!.details?.requiredLanes as ReviewLane[];
    const codeId = 'early-code';
    const specId = 'early-spec';
    const docId = 'early-doc';
    append(input.sessionFile,
      ...[codeId, specId].flatMap((id, index) => {
        const lane = lanes[index]!;
        return [
          toolCall(id, 'subagent', {
            subagent_type: lane,
            run_in_background: true,
            inherit_context: false,
            prompt: reviewerPrompt(input.head, lane),
          }),
          toolResult(id, 'subagent'),
          notification(id),
        ];
      }),
      toolCall(docId, 'subagent', {
        subagent_type: lanes[2],
        run_in_background: true,
        inherit_context: false,
        prompt: reviewerPrompt(input.head, lanes[2]!),
      }),
      toolResult(docId, 'subagent'),
      toolCall('early-ci', 'subagent', {
        subagent_type: 'ci-monitor',
        run_in_background: true,
        inherit_context: false,
        prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
      }),
      toolResult('early-ci', 'subagent'),
      notification('early-ci', `<result>CI_RESULT success\npr=42 head=${input.head} repo=owner/repo</result>`),
      triage(),
    );

    await app.emit('agent_settled');
    expect(app.sent.map((message) => message.customType)).toEqual(['pr-boundary-launch-plan']);

    append(input.sessionFile,
      notification(docId),
      { type: 'message', id: `unchanged-${sequence += 1}`, message: { role: 'assistant', content: [{ type: 'text', text: 'Triage remains unchanged.' }] } },
    );
    await app.emit('agent_settled');
    await app.emit('agent_settled');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-triage-correction',
    ]);
    expect(app.sent[1]?.content).toContain('published before the final result');
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).not.toBe('complete');

    append(input.sessionFile, triage());
    await app.emit('agent_settled');
    await app.emit('agent_settled');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-triage-correction',
      'pr-boundary-fix-follow-up',
    ]);
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
  });

  it('requests one canonical triage correction when a terminal CI failure row is malformed', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-correct-triage'));
    await app.emit('agent_end');
    const lanes = app.sent[0]!.details?.requiredLanes as ReviewLane[];
    append(input.sessionFile,
      ...lanes.flatMap((lane, index) => {
        const id = `correct-triage-review-${index}`;
        return [
          toolCall(id, 'subagent', {
            subagent_type: lane,
            run_in_background: true,
            inherit_context: false,
            prompt: reviewerPrompt(input.head, lane),
          }),
          toolResult(id, 'subagent'),
          ...(index === lanes.length - 1 ? [] : [notification(id)]),
        ];
      }),
      triage(),
      notification('correct-triage-review-2'),
      toolCall('correct-triage-ci', 'subagent', {
        subagent_type: 'ci-monitor',
        run_in_background: true,
        inherit_context: false,
        prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: input.head, cwd: input.repo }),
      }),
      toolResult('correct-triage-ci', 'subagent'),
      notification('correct-triage-ci', `<result>CI_RESULT failure\npr=42 head=${input.head} repo=owner/repo</result>`),
      malformedFailureTriage(),
    );

    await app.emit('agent_end');
    await app.emit('agent_settled');

    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).not.toBe('complete');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-triage-correction',
    ]);
    expect(app.sent[1]?.content).toContain('| Exact-head CI | Terminal exact-head failure | `CI_RESULT failure` | Required exact contract | Address exact-head CI before FIX |');

    append(input.sessionFile, triage('failure', true));
    await app.emit('agent_settled');

    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-triage-correction',
      'pr-boundary-fix-follow-up',
    ]);
  });

  it('preserves review-owned Goal pause and releases it only after acknowledged FIX handoff', async () => {
    const input = fixture();
    append(input.sessionFile, { type: 'custom', customType: 'goal-state', data: { goal: { id: 'goal-1', status: 'active' } } });
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-goal'));
    await app.emit('agent_end');

    const pause = readFileSync(input.sessionFile, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((entry) => entry.customType === 'pr-boundary-goal-pause').at(-1);
    expect(pause.data).toEqual({ head: input.head, goalId: 'goal-1' });

    appendSuccessfulRound(input, app.sent[0]!.details?.requiredLanes as ReviewLane[], 'goal');
    await app.emit('agent_end');

    expect(app.goalActions).toEqual(['pause', 'resume']);
    expect(app.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-fix-follow-up',
    ]);
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).toBe('complete');
  });

  it('keeps launch and FIX fail-open while clearing unavailable or manually resumed Goal ownership', async () => {
    const unavailable = fixture();
    append(unavailable.sessionFile, { type: 'custom', customType: 'goal-state', data: { goal: { id: 'goal-1', status: 'active' } } });
    const unavailableApp = await harness(unavailable, [], { goalControlAvailable: false });
    await unavailableApp.emit('tool_result', boundary('git push origin feature', 'push-goal-unavailable'));
    await unavailableApp.emit('agent_end');
    appendSuccessfulRound(unavailable, unavailableApp.sent[0]!.details?.requiredLanes as ReviewLane[], 'goal-unavailable');
    await unavailableApp.emit('agent_end');
    expect(unavailableApp.sent.map((message) => message.customType)).toEqual([
      'pr-boundary-launch-plan',
      'pr-boundary-fix-follow-up',
    ]);
    expect(unavailableApp.goalActions).toEqual([]);

    const resumed = fixture();
    append(resumed.sessionFile, { type: 'custom', customType: 'goal-state', data: { goal: { id: 'goal-2', status: 'active' } } });
    const resumedApp = await harness(resumed, []);
    await resumedApp.emit('tool_result', boundary('git push origin feature', 'push-goal-resumed'));
    await resumedApp.emit('agent_end');
    append(resumed.sessionFile, { type: 'custom', customType: 'goal-state', data: { goal: { id: 'goal-2', status: 'active' } } });
    appendSuccessfulRound(resumed, resumedApp.sent[0]!.details?.requiredLanes as ReviewLane[], 'goal-resumed');
    await resumedApp.emit('agent_end');
    expect(resumedApp.goalActions).toEqual(['pause']);
    expect(resumedApp.sent.at(-1)?.customType).toBe('pr-boundary-fix-follow-up');
  });

  it('clears stopped work without a recovery message or marker', async () => {
    const input = fixture();
    const app = await harness(input, ['Launch review', undefined]);
    await app.emit('tool_result', boundary('git pull', 'pull-1'));
    await app.emit('agent_end');
    append(input.sessionFile, notification('stopped-review', 'Stopped'));
    await app.emit('agent_end');
    await app.emit('tool_result', boundary('git pull', 'pull-2'));

    expect(app.prompts).toHaveLength(2);
    expect(app.sent.filter((message) => /follow-up|missing/i.test(message.customType))).toHaveLength(0);
    expect(readCompletion(input.identity, { root: join(input.home, '.codeflare/review-state/v1') }).status).not.toBe('complete');
  });

  it('fails closed for child sessions, GitHub outages, and unrelated pushes', async () => {
    const child = fixture({ child: true });
    const childApp = await harness(child);
    await childApp.emit('session_start');
    expect(childApp.prompts).toHaveLength(0);

    const input = fixture();
    const { registerReviewEnforcement, PR_LOOKUP_FAILED } = await import('../../../preseed/agents/pi/extensions/review-enforcement');
    const app = await harness(input, [undefined]);
    input.pr.state = 'CLOSED';
    await app.emit('tool_result', boundary('git pull'));
    await app.emit('tool_result', boundary('git push origin unrelated'));
    expect(app.prompts).toHaveLength(0);
    expect(PR_LOOKUP_FAILED).toBeTypeOf('symbol');
    expect(registerReviewEnforcement).toBeTypeOf('function');
  });

  it('supports linked worktrees and writes outside clone-local Git metadata', async () => {
    const input = fixture();
    const worktree = tempRoot('review-worktree-');
    rmSync(worktree, { recursive: true, force: true });
    git(input.repo, 'branch', 'worktree-branch');
    git(input.repo, 'worktree', 'add', worktree, 'worktree-branch');
    input.repo = worktree;
    input.pr.headRefName = 'worktree-branch';
    input.identity.branch = 'worktree-branch';
    input.sessionFile = join(worktree, 'session.jsonl');
    writeFileSync(input.sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: 'worktree', cwd: worktree })}\n`);
    const app = await harness(input, ['Mark review complete']);
    await app.emit('tool_result', boundary('git pull'));

    expect(completionPath(input.identity, join(input.home, '.codeflare/review-state/v1'))).not.toContain('/.git/');
    expect(app.prompts).toHaveLength(1);
  });
});
