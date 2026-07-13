import { describe, expect, it } from 'vitest';

import { reviewCommandDecision } from '../../../preseed/agents/pi/extensions/review-command';
import { scopeContract } from '../../../preseed/agents/pi/extensions/review-scope';
import { sddCommandDecision } from '../../../preseed/agents/pi/extensions/sdd-helpers';

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

  it('uses changed hunks plus direct invalidations for diff and the whole tree for all', () => {
    expect(scopeContract('diff').workSet).toBe('changed-hunks-and-direct-invalidations');
    expect(scopeContract('all').workSet).toBe('whole-requested-tree');
  });
});
