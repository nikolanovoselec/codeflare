import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { reviewCommandDecision, reviewWorkflowDecision } from '../../../preseed/agents/pi/extensions/review-command';
import { scopeContract } from '../../../preseed/agents/pi/extensions/review-scope';
import { sddCommandDecision, sddWorkflowScopeText } from '../../../preseed/agents/pi/extensions/sdd-helpers';

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
    mkdirSync(cwdRepo);
    mkdirSync(rememberedRepo);
    execFileSync('git', ['init', '-q'], { cwd: cwdRepo });
    execFileSync('git', ['init', '-q'], { cwd: rememberedRepo });

    try {
      expect(reviewWorkflowDecision('--diff', cwdRepo, rememberedRepo)).toMatchObject({ kind: 'workflow', repo: cwdRepo });
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
