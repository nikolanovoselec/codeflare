import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { dispatchReview, reviewCommandDecision, reviewDocumentationSurfaceDecision, reviewWorkflowDecision } from '../../../preseed/agents/pi/extensions/review-command';
import { scopeContract } from '../../../preseed/agents/pi/extensions/review-scope';
import { sddCommandDecision, sddWorkflowExecutionText, sddWorkflowScopeText } from '../../../preseed/agents/pi/extensions/sdd-helpers';

const reviewRootResolver = fileURLToPath(new URL(
  '../../../preseed/agents/pi/skills/review/scripts/resolve-project-root.mjs',
  import.meta.url,
));

describe('REQ-AGENT-059: Pi review scope entry points', () => {
  it('AC3: resolves /review diff and all into executable work-set contracts', () => {
    expect(reviewCommandDecision('--diff src/routes')).toEqual({
      kind: 'workflow',
      command: '/review --diff src/routes',
      scope: scopeContract('diff'),
    });
    expect(reviewCommandDecision('--all')).toEqual({
      kind: 'workflow',
      command: '/review --all',
      scope: scopeContract('all'),
    });
  });

  it('REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-review-command-'));
    const cwdRepo = join(workspace, 'cwd-repo');
    const rememberedRepo = join(workspace, 'remembered-repo');
    const linkedWorktree = join(workspace, 'linked-worktree');
    const trailingSpaceRepo = join(workspace, 'trailing-space ');
    mkdirSync(cwdRepo);
    mkdirSync(rememberedRepo);
    mkdirSync(trailingSpaceRepo);
    execFileSync('git', ['init', '-q'], { cwd: cwdRepo });
    execFileSync('git', ['-c', 'user.name=Codeflare Test', '-c', 'user.email=codeflare-test@users.noreply.github.com', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: cwdRepo });
    execFileSync('git', ['worktree', 'add', '-qb', 'linked-worktree', linkedWorktree], { cwd: cwdRepo });
    execFileSync('git', ['init', '-q'], { cwd: rememberedRepo });
    execFileSync('git', ['init', '-q'], { cwd: trailingSpaceRepo });

    try {
      expect(reviewWorkflowDecision('--diff', cwdRepo, rememberedRepo)).toMatchObject({ kind: 'workflow', repo: cwdRepo });
      expect(reviewWorkflowDecision('--diff', linkedWorktree, rememberedRepo)).toMatchObject({ kind: 'workflow', repo: linkedWorktree });
      expect(execFileSync(process.execPath, [reviewRootResolver, linkedWorktree], { encoding: 'utf8' })).toBe(`${linkedWorktree}\n`);
      expect(execFileSync(process.execPath, [reviewRootResolver, trailingSpaceRepo], { encoding: 'utf8' })).toBe(`${trailingSpaceRepo}\n`);
      const invalidRoot = spawnSync(process.execPath, [reviewRootResolver, workspace], { encoding: 'utf8' });
      expect(invalidRoot.status).toBe(1);
      expect(invalidRoot.stderr).toBe('ERROR: /review repository root is unavailable.\n');
      expect(reviewWorkflowDecision('--diff', workspace, rememberedRepo)).toEqual({
        kind: 'workflow',
        command: '/review --diff',
        scope: scopeContract('diff'),
        repo: rememberedRepo,
      });
      expect(reviewWorkflowDecision('--diff', workspace, undefined)).toEqual({
        kind: 'error',
        message: '/review needs an active Git repository.',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-050 AC7: resolves the documentation lane to a stable no-surface report', () => {
    const noSurface = {
      kind: 'no-op',
      report: 'no-op (vibe-coding mode: no sdd/ or no documentation/)',
    };
    expect(reviewDocumentationSurfaceDecision(false, true)).toEqual(noSurface);
    expect(reviewDocumentationSurfaceDecision(true, false)).toEqual(noSurface);
    expect(reviewDocumentationSurfaceDecision(false, false)).toEqual(noSurface);
    expect(reviewDocumentationSurfaceDecision(true, true)).toEqual({ kind: 'review' });
  });

  it('REQ-AGENT-050 AC1/REQ-AGENT-088 AC1: dispatches the dedicated /review workflow contract', async () => {
    const messages: string[] = [];
    await dispatchReview(
      { sendUserMessage: (message: string) => { messages.push(message); } } as never,
      '--diff',
      {
        cwd: '/home/user/workspace/codeflare',
        waitForIdle: async () => undefined,
        ui: { notify: () => undefined },
      } as never,
      () => ({
        kind: 'workflow',
        command: '/review --diff',
        scope: scopeContract('diff'),
        repo: '/home/user/workspace/codeflare',
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('# Pi Review Workflow');
    expect(messages[0]).toContain('This is the user-invoked /review command');
    const executionLine = messages[0].split('\n').find((line) => line.startsWith('Review execution: '));
    expect(JSON.parse(executionLine?.slice('Review execution: '.length) ?? '')).toEqual({
      mode: 'report-only',
      persistenceOwner: 'root',
      sourceMutations: false,
    });
  });

  it('REQ-AGENT-083: suppresses /review workflow dispatch when no repository resolves', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-review-dispatch-'));
    const messages: string[] = [];
    const notifications: Array<{ message: string; level: string }> = [];

    try {
      await dispatchReview(
        { sendUserMessage: (message: string) => { messages.push(message); } } as never,
        '--diff',
        {
          cwd: workspace,
          waitForIdle: async () => undefined,
          ui: { notify: (message: string, level: string) => { notifications.push({ message, level }); } },
        } as never,
        (args, cwd) => reviewWorkflowDecision(args, cwd, undefined),
      );

      expect(messages).toEqual([]);
      expect(notifications).toEqual([{
        message: '/review needs an active Git repository.',
        level: 'error',
      }]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session', () => {
    const init = sddCommandDecision('init new project', {
      dirty: false,
      hasSdd: false,
      hasOpenInitTriage: false,
    });
    expect(init).toMatchObject({
      kind: 'workflow',
      execution: {
        owner: 'root',
        allowsMutations: true,
        reviewerAgents: false,
        enforcementOrder: ['spec-enforce', 'doc-enforce'],
        pushTarget: 'none',
      },
    });

    for (const mode of ['--auto', '--unleashed']) {
      const clean = sddCommandDecision(`clean ${mode}`, {
        dirty: false,
        hasSdd: true,
        hasOpenInitTriage: false,
      });
      expect(clean).toMatchObject({
        kind: 'workflow',
        execution: {
          owner: 'root',
          allowsMutations: true,
          reviewerAgents: false,
          enforcementOrder: ['spec-enforce', 'doc-enforce'],
          pushTarget: 'current-branch',
        },
      });
      if (clean.kind === 'workflow') {
        expect(sddWorkflowExecutionText(clean)).toBe(
          'Execution owner: root session; file and Git mutations allowed; enforcement order: spec-enforce then doc-enforce; push target: current-branch; do not spawn PR-boundary reviewer agents.',
        );
      }
    }
  });

  it('AC4: resolves /sdd clean scope flags through the same contract', () => {
    const state = { dirty: false, hasSdd: true, hasOpenInitTriage: false };

    expect(sddCommandDecision('clean --diff', state)).toMatchObject({
      kind: 'workflow',
      subcommand: 'clean',
      scope: scopeContract('diff'),
    });
    expect(sddCommandDecision('clean --scope=all', state)).toMatchObject({
      kind: 'workflow',
      subcommand: 'clean',
      scope: scopeContract('all'),
    });
  });

  it('dispatches the resolved /sdd clean work set and rejects ambiguous scope flags', () => {
    const state = { dirty: false, hasSdd: true, hasOpenInitTriage: false };
    const decision = sddCommandDecision('clean --scope=all', state);

    expect(decision.kind).toBe('workflow');
    if (decision.kind === 'workflow') {
      expect(sddWorkflowScopeText(decision)).toBe(
        'Resolved scope: {"mode":"all","workSet":"whole-requested-tree"}',
      );
    }
    expect(sddCommandDecision('clean --diff --all', state)).toMatchObject({ kind: 'error' });
    expect(sddCommandDecision('clean --scope=somewhere', state)).toMatchObject({ kind: 'error' });
  });

  it('uses changed hunks plus direct invalidations for diff and the whole tree for all', () => {
    expect(scopeContract('diff').workSet).toBe('changed-hunks-and-direct-invalidations');
    expect(scopeContract('all').workSet).toBe('whole-requested-tree');
  });
});
