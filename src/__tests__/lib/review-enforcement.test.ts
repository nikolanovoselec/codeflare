import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function fixture(options: { child?: boolean } = {}) {
  const home = tempRoot('review-home-');
  const repo = tempRoot('review-repo-');
  git(repo, 'init', '-q');
  git(repo, 'branch', '-M', 'feature');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  write(repo, 'sdd/README.md', '# SDD\n');
  write(repo, 'README.md', '# Repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/review.ts', 'export const changed = true;\n');
  write(repo, 'sdd/spec/review.md', '# Review\n');
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

function boundary(command: string, id = `boundary-${sequence += 1}`) {
  return {
    toolName: 'bash',
    toolCallId: id,
    input: { command },
    args: { command },
    result: { isError: false, content: [{ type: 'text', text: 'ok' }] },
  };
}

async function harness(input: ReturnType<typeof fixture>, decisions: Array<string | undefined> = ['Launch review']) {
  process.env.HOME = input.home;
  process.env.CODEFLARE_SYNC_DAEMON_PIDFILE = join(input.home, 'missing.pid');
  const { registerReviewEnforcement } = await import('../../../preseed/agents/pi/extensions/review-enforcement');
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ customType: string; content?: string; details?: Record<string, unknown> }> = [];
  const prompts: Array<{ title: string; options: string[] }> = [];
  const entries = () => readFileSync(input.sessionFile, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.type !== 'session');
  let activeTools = ['read', 'bash'];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    events: { emit: vi.fn() },
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
  });
  return {
    ctx,
    sent,
    prompts,
    emit: async (event: string, payload: any = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

function optionsHeader(input: ReturnType<typeof fixture>): { parentSession?: string } {
  const header = JSON.parse(readFileSync(input.sessionFile, 'utf8').split('\n', 1)[0]) as { parentSession?: string };
  return header.parentSession ? { parentSession: header.parentSession } : {};
}

afterEach(() => {
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Pi marker-or-dialog review ingress', () => {
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

  it('automatically emits the exact review plan after successful push', async () => {
    await expectAutomaticDeliveryPlan('git push origin feature');
  });

  it('automatically emits the exact review plan after successful PR creation without requiring UI', async () => {
    await expectAutomaticDeliveryPlan('gh pr create --base main', false);
  });

  it('automatically emits the exact review plan after successful PR reopen without requiring UI', async () => {
    await expectAutomaticDeliveryPlan('gh pr reopen 42', false);
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
      requestSync: () => true,
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

  it('acknowledges a valid zero-lane delta and emits only independent CI', async () => {
    const input = fixture();
    writeCompletion(input.identity, {
      root: join(input.home, '.codeflare/review-state/v1'),
      requestSync: () => true,
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

  it('stamps completion only after terminal evidence and canonical triage, then emits FIX', async () => {
    const input = fixture();
    const app = await harness(input, []);
    await app.emit('tool_result', boundary('git push origin feature', 'push-1'));
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
          prompt: `review_base=origin/main output_file=/tmp/${lane}.md`,
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
              prompt: `review_base=origin/main output_file=/tmp/${lane}.md`,
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
            prompt: `review_base=origin/main output_file=/tmp/${lane}.md`,
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

  it('clears stopped work without a recovery message or marker', async () => {
    const input = fixture();
    const app = await harness(input, ['Launch review', undefined]);
    await app.emit('tool_result', boundary('git pull', 'pull-1'));
    await app.emit('agent_end');
    append(input.sessionFile, notification('stopped-review', 'Stopped'));
    await app.emit('agent_end');
    await app.emit('tool_result', boundary('git pull', 'pull-2'));

    expect(app.prompts).toHaveLength(2);
    expect(app.sent.filter((message) => /follow-up|missing/i.test(message.customType)).toHaveLength(0);
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
