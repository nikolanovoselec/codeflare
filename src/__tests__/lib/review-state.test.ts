import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHeadAdvanceRequiresReview, computeReviewStateFrom, isAgentSpawnerToolEvent, shouldReconcileOpenPr, reconcileBoundaryAction, reviewBaselineContinuation, reviewBoundaryStartDecision, reviewInSessionContinuation, reviewWindowStartDecision, mergeGateDecision, resolveReviewRepo, rememberReviewRepo, recallReviewRepo, recallReviewRepos, rememberActiveRepo, recallActiveRepo, activeRepoSentinelForDisplay, compactDurableReviewStatus, formatReviewElapsed, formatReviewTokens, reviewMonitorDecision, workspaceRepoFromPath, type ComputeReviewStateInput, type OpenPrReconcileInput, type ReconcileBoundaryInput, type MergeGateInput } from '../../../preseed/agents/pi/extensions/review-job-helpers';

/**
 * computeReviewStateFrom is the canonical review-state definition (review.md §17.2).
 * These tests pin the lane-status precedence (result > failed > running > pending),
 * the overall aggregation, and the acked/breaker semantics. Break the precedence or
 * the aggregation and a test fails — there is no implementation to gut while staying green.
 */
const base: ComputeReviewStateInput = {
  repo: '/repo',
  head: 'abc123',
  lanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
  laneJobStatus: () => undefined,
  resultLaneExists: () => false,
  runningInMemory: () => false,
  ackHead: '',
  breakerHead: '',
  attempts: 0,
  monitorCompleted: false,
};

describe('computeReviewStateFrom (REQ-AGENT-057 AC1)', () => {
  it('reports all lanes pending when nothing has happened', () => {
    const s = computeReviewStateFrom({ ...base });
    expect(s.overall).toBe('pending');
    expect(s.laneStatus['code-reviewer']).toBe('pending');
    expect(s.summaryReady).toBe(false);
    expect(s.acked).toBe(false);
  });

  it('treats result .md existence as completed even if the job record still says running', () => {
    const s = computeReviewStateFrom({
      ...base,
      laneJobStatus: (lane) => (lane === 'code-reviewer' ? 'running' : undefined),
      resultLaneExists: (lane) => lane === 'code-reviewer',
    });
    expect(s.laneStatus['code-reviewer']).toBe('completed');
  });

  it('reports running when a lane is running and none failed', () => {
    const s = computeReviewStateFrom({ ...base, runningInMemory: (lane) => lane === 'spec-reviewer' });
    expect(s.overall).toBe('running');
    expect(s.laneStatus['spec-reviewer']).toBe('running');
    expect(s.laneStatus['code-reviewer']).toBe('pending');
  });

  it('lets failed dominate the overall verdict over running and pending', () => {
    const s = computeReviewStateFrom({
      ...base,
      laneJobStatus: (lane) => (lane === 'code-reviewer' ? 'failed' : 'running'),
    });
    expect(s.overall).toBe('failed');
  });

  it('is complete + summaryReady only when every lane has a result', () => {
    const s = computeReviewStateFrom({ ...base, resultLaneExists: () => true });
    expect(s.overall).toBe('complete');
    expect(s.summaryReady).toBe(true);
  });

  it('acks only when ackHead equals a non-empty head', () => {
    expect(computeReviewStateFrom({ ...base, ackHead: 'abc123' }).acked).toBe(true);
    expect(computeReviewStateFrom({ ...base, ackHead: 'other' }).acked).toBe(false);
    expect(computeReviewStateFrom({ ...base, head: '', ackHead: '' }).acked).toBe(false);
  });

  it('opens the breaker only when breakerHead equals the head', () => {
    expect(computeReviewStateFrom({ ...base, breakerHead: 'abc123' }).breakerOpen).toBe(true);
    expect(computeReviewStateFrom({ ...base, breakerHead: 'other' }).breakerOpen).toBe(false);
  });

  it('reports none when no lanes are required for the head', () => {
    const s = computeReviewStateFrom({ ...base, lanes: [] });
    expect(s.overall).toBe('none');
    expect(s.summaryReady).toBe(false);
  });
});

/**
 * shouldReconcileOpenPr is the pure decision behind open-PR reconciliation (REQ-AGENT-058 AC1).
 * It encodes the narrow, bounded path REQ-036 AC7 permits: reconcile ONLY an OPEN, non-draft,
 * ENFORCED main/master PR whose resolved head is unacknowledged with no review window and no
 * open breaker. Every other case must NOT reconcile — these tests fail if any gate regresses
 * (which would either re-introduce passive PR-existence triggering, or silently miss boundaries).
 */
describe('shouldReconcileOpenPr (REQ-AGENT-058 AC1)', () => {
  // The one shape that SHOULD reconcile; each test flips exactly one field to prove the gate.
  const reconcilable: OpenPrReconcileInput = {
    prOpen: true,
    prDraft: false,
    enforced: true,
    head: 'abc123',
    acked: false,
    hasReviewJob: false,
    reviewActive: false,
    breakerOpen: false,
  };

  it('reconciles an open, non-draft, enforced PR with an unacked head and no window/breaker', () => {
    expect(shouldReconcileOpenPr(reconcilable).reconcile).toBe(true);
  });

  it('does NOT reconcile when there is no open PR', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, prOpen: false }).reconcile).toBe(false);
  });

  it('does NOT reconcile a draft PR', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, prDraft: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile a non-enforced PR (base not main/master, or not an SDD project)', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, enforced: false }).reconcile).toBe(false);
  });

  it('does NOT reconcile when the enforced head cannot be resolved', () => {
    const d = shouldReconcileOpenPr({ ...reconcilable, head: '' });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('no resolvable enforced head');
  });

  it('does NOT reconcile a head that is already acknowledged', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, acked: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile when a review window already exists (job present or lanes active)', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, hasReviewJob: true }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...reconcilable, reviewActive: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile when the review breaker is open for the head', () => {
    const d = shouldReconcileOpenPr({ ...reconcilable, breakerOpen: true });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('review breaker open for head');
  });
});

/**
 * reconcileBoundaryAction is the action gate for a missed-boundary PR head (REQ-AGENT-058
 * revised). The locked design: an in-session continuation (the missed head DESCENDS from a
 * previously-acked head, i.e. the onToolEnd auto-start was dropped by a compound `&&`/here-doc/
 * `gh pr edit`/reload) AUTO-STARTS the review just like the onToolEnd boundary path; a fresh
 * clone/checkout (no prior ack to descend from) is OFFERED once; a re-offer of an already-offered
 * clone head NOOPs; and a non-reconcilable head always NOOPs. These tests fail if the
 * autostart/offer/noop branching regresses — the reconciler's only behaviour on a missed
 * boundary is one of these three actions.
 */
describe('reviewWindowStartDecision (REQ-AGENT-041: bypass is consumed only by live review starts)', () => {
  it('starts review when no bypass sentinel is present', () => {
    expect(reviewWindowStartDecision({ bypassPresent: false, canConsumeBypass: true, boundaryEvent: true })).toBe('start');
  });

  it('ignores the sentinel during passive status refreshes', () => {
    expect(reviewWindowStartDecision({ bypassPresent: true, canConsumeBypass: true, boundaryEvent: false })).toBe('start');
  });

  it('acks instead of starting review when a live review-start decision can consume the bypass', () => {
    expect(reviewWindowStartDecision({ bypassPresent: true, canConsumeBypass: true, boundaryEvent: true })).toBe('ack_bypass');
  });

  it('waits instead of starting review when a task/subagent context sees the bypass on a review-start decision', () => {
    expect(reviewWindowStartDecision({ bypassPresent: true, canConsumeBypass: false, boundaryEvent: true })).toBe('wait_for_main_session');
  });

  it('preserves the sentinel when an already-acked boundary event would not start review', () => {
    expect(reviewBoundaryStartDecision({
      acked: true,
      breakerOpen: false,
      windowExists: false,
      dedupeAllowed: () => true,
      bypassPresent: true,
      canConsumeBypass: true,
    })).toBe('skip_acked');
  });

  it('preserves the dedupe token when a no-op guard wins before review start', () => {
    let dedupeCalls = 0;
    const decision = reviewBoundaryStartDecision({
      acked: true,
      breakerOpen: false,
      windowExists: false,
      dedupeAllowed: () => { dedupeCalls += 1; return true; },
      bypassPresent: true,
      canConsumeBypass: true,
    });

    expect(decision).toBe('skip_acked');
    expect(dedupeCalls).toBe(0);
  });

  it('preserves the sentinel when a pending review window already exists', () => {
    expect(reviewBoundaryStartDecision({
      acked: false,
      breakerOpen: false,
      windowExists: true,
      dedupeAllowed: () => true,
      bypassPresent: true,
      canConsumeBypass: true,
    })).toBe('skip_window_exists');
  });
});

describe('reconcileBoundaryAction (REQ-AGENT-058 revised: autostart in-session, offer-once on clone)', () => {
  it('AUTO-STARTS an in-session continuation (missed onToolEnd auto-start), even when not yet offered', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: false, inSessionContinuation: true };
    expect(reconcileBoundaryAction(input)).toBe('autostart');
  });

  it('AUTO-STARTS an in-session continuation regardless of a prior offer on the same head', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: true, inSessionContinuation: true };
    expect(reconcileBoundaryAction(input)).toBe('autostart');
  });

  it('offers a fresh-clone reconcilable head (no continuation) that has not been offered yet', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: false, inSessionContinuation: false };
    expect(reconcileBoundaryAction(input)).toBe('offer');
  });

  it('noops on a re-offer of the same already-offered clone head (offered once, not twice)', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: true, inSessionContinuation: false };
    expect(reconcileBoundaryAction(input)).toBe('noop');
  });

  it('noops when the head is not reconcilable, regardless of offered/continuation state', () => {
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: false, inSessionContinuation: false })).toBe('noop');
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: true, inSessionContinuation: false })).toBe('noop');
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: false, inSessionContinuation: true })).toBe('noop');
  });
});

/**
 * reviewBaselineContinuation feeds reconcileBoundaryAction's `inSessionContinuation` flag.
 * It decides continuation from an IN-MEMORY per-session baseline (the head this Pi session
 * first observed), NOT the on-disk ack. That distinction is the bug-A fix: keying off the
 * on-disk ack made every fresh `pi` launch whose head descended from a prior ack report
 * continuation → auto-start reviewers on launch (regression: "offering worked yesterday").
 * Continuation is true ONLY when the head ADVANCED beyond the baseline during this session.
 * These fail if a bare launch (baseline undefined or unchanged) is ever treated as
 * continuation, or if a genuine in-session advance stops being treated as one.
 */
describe('reviewBaselineContinuation (bug-A fix: offer on launch, autostart only on in-session advance)', () => {
  const descends = () => true;   // isAncestor stub: head descends from baseline
  const unrelated = () => false; // isAncestor stub: head does NOT descend from baseline

  it('returns false on the first reconcile of a session (baseline undefined → fresh launch offers)', () => {
    expect(reviewBaselineContinuation(undefined, 'headsha', descends)).toBe(false);
  });

  it('returns false when the head is unchanged since the session baseline (relaunch on same head offers)', () => {
    expect(reviewBaselineContinuation('samehead', 'samehead', descends)).toBe(false);
  });

  it('returns true when the head advanced beyond the baseline and descends from it (dropped in-session push)', () => {
    expect(reviewBaselineContinuation('basehead', 'newhead', descends)).toBe(true);
  });

  it('returns false when the new head does not descend from the baseline (unrelated branch, not a continuation)', () => {
    expect(reviewBaselineContinuation('basehead', 'newhead', unrelated)).toBe(false);
  });

  it('returns false for an empty head regardless of baseline', () => {
    expect(reviewBaselineContinuation('basehead', '', descends)).toBe(false);
  });
});

/**
 * reviewInSessionContinuation is the FULL autostart-vs-offer signal. boundaryActed
 * (a real push happened this session for this repo+branch) is the PRIMARY signal; the baseline
 * descendant check is the backstop for a reload that ate the boundary tool-event. A bare checkout sets
 * neither, so it OFFERS.
 */
describe('isAgentSpawnerToolEvent / agentHeadAdvanceRequiresReview (REQ-AGENT-058 AC7)', () => {
  it('recognizes both Agent and subagent tool event shapes before head-advance reconciliation', () => {
    expect(isAgentSpawnerToolEvent({ toolName: 'Agent' })).toBe(true);
    expect(isAgentSpawnerToolEvent({ toolName: 'subagent' })).toBe(true);
    expect(isAgentSpawnerToolEvent({ tool_name: 'subagent' })).toBe(true);
    expect(isAgentSpawnerToolEvent({ input: { subagent_type: 'code-reviewer' } })).toBe(true);
    expect(isAgentSpawnerToolEvent({ toolName: 'Bash' })).toBe(false);
  });

  const base = {
    beforeHead: 'old-head',
    afterHead: 'new-head',
    enforced: true,
    draft: false,
    acked: false,
    breakerOpen: false,
    windowExists: false,
  };

  it('starts review when an Agent tool advances an enforced PR head', () => {
    expect(agentHeadAdvanceRequiresReview(base)).toBe(true);
  });

  it('honors the bypass sentinel for a live Agent head-advance review start', () => {
    expect(agentHeadAdvanceRequiresReview(base)).toBe(true);
    expect(reviewWindowStartDecision({
      bypassPresent: true,
      canConsumeBypass: true,
      boundaryEvent: agentHeadAdvanceRequiresReview(base),
    })).toBe('ack_bypass');
  });

  it('does not start review for inherited same-head, draft, acked, breaker, or existing-window states', () => {
    expect(agentHeadAdvanceRequiresReview({ ...base, afterHead: 'old-head' })).toBe(false);
    expect(agentHeadAdvanceRequiresReview({ ...base, draft: true })).toBe(false);
    expect(agentHeadAdvanceRequiresReview({ ...base, acked: true })).toBe(false);
    expect(agentHeadAdvanceRequiresReview({ ...base, breakerOpen: true })).toBe(false);
    expect(agentHeadAdvanceRequiresReview({ ...base, windowExists: true })).toBe(false);
  });
});

describe('reviewInSessionContinuation (boundaryActed primary, baseline backstop)', () => {
  const descends = () => true;
  const unrelated = () => false;

  it('autostarts when a boundary command ran this session, even with no/equal baseline', () => {
    // No baseline (e.g. no open PR at launch, PR created mid-session) — boundaryActed alone autostarts.
    expect(reviewInSessionContinuation({ boundaryActed: true, baseline: undefined, head: 'h2', isAncestor: unrelated })).toBe(true);
    expect(reviewInSessionContinuation({ boundaryActed: true, baseline: 'h2', head: 'h2', isAncestor: unrelated })).toBe(true);
  });

  it('autostarts via the baseline backstop when boundaryActed was missed but the head advanced', () => {
    // Reload ate the tool-event: boundaryActed false, but head descends from the session branch baseline.
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: 'h1', head: 'h2', isAncestor: descends })).toBe(true);
  });

  it('OFFERS an inherited head: no boundary command and head equals/does-not-descend baseline', () => {
    // Bare checkout / fresh launch: no push this session, baseline === head (just-seeded) → offer.
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: 'h1', head: 'h1', isAncestor: descends })).toBe(false);
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: undefined, head: 'h1', isAncestor: descends })).toBe(false);
    // Cross-branch checkout to an unrelated descendant: not boundary-acted, does not descend → offer.
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: 'h1', head: 'h9', isAncestor: unrelated })).toBe(false);
  });

  it('keeps the baseline backstop active after an ack so fix-push rounds still autostart if a tool event is lost', () => {
    // A fix-push immediately after an ack is the normal autofix/review loop. If the push event is lost,
    // the descendant baseline is the only remaining signal; suppressing it caused a real pushed head to
    // degrade to boundary_offered instead of creating durable lanes.
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: 'h1', head: 'h3', isAncestor: descends, ackedThisSession: true })).toBe(true);
    expect(reviewInSessionContinuation({ boundaryActed: true, baseline: 'h1', head: 'h3', isAncestor: descends, ackedThisSession: true })).toBe(true);
    expect(reviewInSessionContinuation({ boundaryActed: false, baseline: 'h1', head: 'h3', isAncestor: descends, ackedThisSession: false })).toBe(true);
  });
});

/**
 * Codeflare review routing is intentionally workspace-specific: cloned repos live at
 * /home/user/workspace/<repo>. The resolver must not walk to arbitrary git roots or read the graphify
 * active-cwd sentinel; those generic fallbacks let other agents misroute review delivery.
 */
describe('resolveReviewRepo (Codeflare workspace-child routing only)', () => {
  const gitRepos = new Set(['/home/user/workspace/codeflare', '/home/user/workspace/other-repo']);
  const hasGitDir = (repo: string): boolean => gitRepos.has(repo);

  it('resolves nested paths to their direct workspace child repo', () => {
    expect(workspaceRepoFromPath('/home/user/workspace/codeflare/src/lib', hasGitDir)).toBe('/home/user/workspace/codeflare');
    expect(workspaceRepoFromPath('/home/user/workspace/codeflare', hasGitDir)).toBe('/home/user/workspace/codeflare');
  });

  it('rejects the workspace root, sibling-prefix paths, outside paths, and workspace children without .git', () => {
    expect(workspaceRepoFromPath('/home/user/workspace', hasGitDir)).toBeUndefined();
    expect(workspaceRepoFromPath('/home/user/workspace-other/codeflare', hasGitDir)).toBeUndefined();
    expect(workspaceRepoFromPath('/tmp/codeflare', hasGitDir)).toBeUndefined();
    expect(workspaceRepoFromPath('/home/user/workspace/plain-repo/src', hasGitDir)).toBeUndefined();
  });

  it('prefers command cwd, then session cwd, active repo, remembered review repo, then process cwd', () => {
    expect(resolveReviewRepo({ commandCwd: '/home/user/workspace/codeflare/src', sessionCwd: '/home/user/workspace/other-repo' }, hasGitDir)).toBe('/home/user/workspace/codeflare');
    expect(resolveReviewRepo({ sessionCwd: '/home/user/workspace/codeflare/src' }, hasGitDir)).toBe('/home/user/workspace/codeflare');
    expect(resolveReviewRepo({ sessionCwd: '/home/user/workspace', activeRepo: '/home/user/workspace/codeflare/src' }, hasGitDir)).toBe('/home/user/workspace/codeflare');
    expect(resolveReviewRepo({ sessionCwd: '/home/user/workspace', sessionReviewRepo: '/home/user/workspace/codeflare', processCwd: '/home/user/workspace/other-repo' }, hasGitDir)).toBe('/home/user/workspace/codeflare');
    expect(resolveReviewRepo({ processCwd: '/home/user/workspace/other-repo/src' }, hasGitDir)).toBe('/home/user/workspace/other-repo');
  });

  it('rejects arbitrary git roots outside /home/user/workspace/<repo>', () => {
    const arbitraryGitRoots = (repo: string): boolean => repo === '/tmp/codeflare' || repo === '/repo' || hasGitDir(repo);
    expect(resolveReviewRepo({ commandCwd: '/tmp/codeflare/src', processCwd: '/repo' }, arbitraryGitRoots)).toBeUndefined();
  });

  it('only probes workspace-child candidates derived from supplied paths, never an external sentinel path', () => {
    const seen: string[] = [];
    resolveReviewRepo({ commandCwd: '/home/user/workspace/codeflare/src', sessionCwd: '/home/user/workspace/other-repo', processCwd: '/tmp/codeflare' }, (repo) => { seen.push(repo); return hasGitDir(repo); });
    expect(seen).toEqual(['/home/user/workspace/codeflare']);
    expect(seen).not.toContain('/home/user/.cache/codeflare-hooks/graphify-active-cwd');
  });
});

/**
 * REQ-AGENT-058 AC4: a boundary-shaped command that does not start a review appends a
 * durable `boundary_candidate_ignored` audit event NAMING the gate reason, so a skipped
 * review is always reconstructable from disk (never-silent). reconcileOpenPrReview stamps
 * `decision.reason` from shouldReconcileOpenPr verbatim into that event, so the audit's
 * diagnostic value rests entirely on the decision surfacing a specific, non-empty reason
 * per gate. These fail if any gate regresses to a bare/duplicated reason — which would make
 * one ignored boundary indistinguishable from another in the event log.
 */
describe('REQ-AGENT-058 AC4: every suppressed reconcile gate names its own reason (boundary_candidate_ignored)', () => {
  const reconcilable: OpenPrReconcileInput = {
    prOpen: true,
    prDraft: false,
    enforced: true,
    head: 'abc123',
    acked: false,
    hasReviewJob: false,
    reviewActive: false,
    breakerOpen: false,
  };
  const gates: Array<[string, OpenPrReconcileInput]> = [
    ['no open PR', { ...reconcilable, prOpen: false }],
    ['draft', { ...reconcilable, prDraft: true }],
    ['not enforced', { ...reconcilable, enforced: false }],
    ['no head', { ...reconcilable, head: '' }],
    ['acked', { ...reconcilable, acked: true }],
    ['breaker open', { ...reconcilable, breakerOpen: true }],
    ['window exists', { ...reconcilable, hasReviewJob: true }],
  ];

  it('every suppressed gate yields reconcile=false with a non-empty reason to stamp', () => {
    for (const [, input] of gates) {
      const d = shouldReconcileOpenPr(input);
      expect(d.reconcile).toBe(false);
      expect(d.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('each gate names a DISTINCT reason so the audit event identifies which gate fired', () => {
    const reasons = gates.map(([, input]) => shouldReconcileOpenPr(input).reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

/**
 * Shared in-session review-repo memory. review-enforcement remembers the resolved repo and the
 * no-ctx reaper + the local-statusline footer recall it — the single mechanism that fixes the blank
 * footer, the missing live lane row, and the on-turn summary that never emits for a nested clone.
 */
describe('rememberReviewRepo / recallReviewRepo (shared in-session review-repo memory)', () => {
  let registryDir: string;
  let previousRegistry: string | undefined;

  function clearRepoMemory(): void {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('codeflare.reviewRepo')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('codeflare.reviewRepos')];
  }

  beforeEach(() => {
    previousRegistry = process.env.CODEFLARE_REVIEW_REPO_REGISTRY;
    registryDir = mkdtempSync(join(tmpdir(), 'codeflare-review-repos-'));
    process.env.CODEFLARE_REVIEW_REPO_REGISTRY = join(registryDir, 'repos.json');
    clearRepoMemory();
  });

  afterEach(() => {
    clearRepoMemory();
    if (previousRegistry === undefined) delete process.env.CODEFLARE_REVIEW_REPO_REGISTRY;
    else process.env.CODEFLARE_REVIEW_REPO_REGISTRY = previousRegistry;
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('recall returns the last remembered workspace-child repo so the no-ctx reaper + footer resolve the clone', () => {
    rememberReviewRepo('/home/user/workspace/ai-news-digest');
    expect(recallReviewRepo()).toBe('/home/user/workspace/ai-news-digest');
  });

  it('REQ-AGENT-061: recallReviewRepos returns every remembered workspace-child review repo for the no-ctx reaper', () => {
    rememberReviewRepo('/home/user/workspace/review-one');
    rememberReviewRepo('/home/user/workspace/review-two');
    expect(recallReviewRepos()).toEqual(expect.arrayContaining(['/home/user/workspace/review-one', '/home/user/workspace/review-two']));
  });

  it('remembering undefined or a non-workspace path does NOT clobber a previously remembered repo', () => {
    rememberReviewRepo('/home/user/workspace/ai-news-digest');
    rememberReviewRepo(undefined);
    rememberReviewRepo('/tmp/other');
    expect(recallReviewRepo()).toBe('/home/user/workspace/ai-news-digest');
  });

  it('REQ-AGENT-061: persisted recall ignores stale workspace-child paths without a .git directory', () => {
    writeFileSync(
      process.env.CODEFLARE_REVIEW_REPO_REGISTRY as string,
      JSON.stringify(['/home/user/workspace/not-a-real-review-repo'])
    );

    expect(recallReviewRepos()).toEqual([]);
    expect(recallReviewRepo()).toBeUndefined();
  });
});

/**
 * Shared in-session active-repo memory (display-only). codeflare-pi remembers the git root each
 * time a command resolves one (git -C <repo>, cd <repo> && ..., clone); the footer recalls it so
 * repo:branch renders when the session cwd is a non-repo parent workspace and the work happens
 * in a nested repo via git -C (the footer was blank in exactly that session shape).
 */
describe('rememberActiveRepo / recallActiveRepo (shared in-session active-repo memory)', () => {
  let registryDir: string;
  let previousRegistry: string | undefined;

  function clearRepoMemory(): void {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('codeflare.reviewRepo')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('codeflare.reviewRepos')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('codeflare.activeRepo')];
  }

  beforeEach(() => {
    previousRegistry = process.env.CODEFLARE_REVIEW_REPO_REGISTRY;
    registryDir = mkdtempSync(join(tmpdir(), 'codeflare-review-repos-'));
    process.env.CODEFLARE_REVIEW_REPO_REGISTRY = join(registryDir, 'repos.json');
    clearRepoMemory();
  });

  afterEach(() => {
    clearRepoMemory();
    if (previousRegistry === undefined) delete process.env.CODEFLARE_REVIEW_REPO_REGISTRY;
    else process.env.CODEFLARE_REVIEW_REPO_REGISTRY = previousRegistry;
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('recall returns the last remembered repo so the footer resolves a nested working repo', () => {
    rememberActiveRepo('/home/user/workspace/ai-news-digest');
    expect(recallActiveRepo()).toBe('/home/user/workspace/ai-news-digest');
  });

  it('remembering undefined does NOT clobber a previously remembered repo', () => {
    rememberActiveRepo('/home/user/workspace/ai-news-digest');
    rememberActiveRepo(undefined);
    expect(recallActiveRepo()).toBe('/home/user/workspace/ai-news-digest');
  });

  it('is a separate slot from the review-repo memory (working repo must not leak into review routing)', () => {
    rememberReviewRepo('/home/user/workspace/review-clone');
    rememberActiveRepo('/home/user/workspace/ai-news-digest');
    expect(recallReviewRepo()).toBe('/home/user/workspace/review-clone');
    expect(recallActiveRepo()).toBe('/home/user/workspace/ai-news-digest');
  });
});

/**
 * Guards for the on-disk graphify active-cwd sentinel as the footer's LAST display-only fallback.
 * The sentinel is written by both Claude's hook and Pi's codeflare-pi, so under concurrent agents
 * it flaps to whichever acted last — the inside-session-root guard is what stops an unrelated repo
 * from hijacking this session's footer.
 */
describe('activeRepoSentinelForDisplay (guarded on-disk sentinel fallback)', () => {
  const hasGit = (real: string[]) => (path: string) => real.includes(path);

  it('accepts a git repo nested inside a session root', () => {
    expect(activeRepoSentinelForDisplay({
      sentinelContent: '/home/user/workspace/ai-news-digest\n',
      sessionRoots: ['/home/user/workspace'],
      hasGitDir: hasGit(['/home/user/workspace/ai-news-digest']),
    })).toBe('/home/user/workspace/ai-news-digest');
  });

  it('accepts the session root itself', () => {
    expect(activeRepoSentinelForDisplay({
      sentinelContent: '/home/user/workspace/repo\n',
      sessionRoots: [undefined, '/home/user/workspace/repo'],
      hasGitDir: hasGit(['/home/user/workspace/repo']),
    })).toBe('/home/user/workspace/repo');
  });

  it('REJECTS a repo outside every session root (concurrent-agent hijack guard)', () => {
    expect(activeRepoSentinelForDisplay({
      sentinelContent: '/somewhere/else/other-repo\n',
      sessionRoots: ['/home/user/workspace'],
      hasGitDir: hasGit(['/somewhere/else/other-repo']),
    })).toBeUndefined();
  });

  it('REJECTS a sibling whose path merely string-prefixes the root (boundary match, not prefix match)', () => {
    expect(activeRepoSentinelForDisplay({
      sentinelContent: '/home/user/workspace-other/repo\n',
      sessionRoots: ['/home/user/workspace'],
      hasGitDir: hasGit(['/home/user/workspace-other/repo']),
    })).toBeUndefined();
  });

  it('REJECTS a path that is not a git repo (stale sentinel)', () => {
    expect(activeRepoSentinelForDisplay({
      sentinelContent: '/home/user/workspace/deleted-clone\n',
      sessionRoots: ['/home/user/workspace'],
      hasGitDir: hasGit([]),
    })).toBeUndefined();
  });

  it('returns undefined for missing or empty sentinel content', () => {
    expect(activeRepoSentinelForDisplay({ sentinelContent: undefined, sessionRoots: ['/r'], hasGitDir: hasGit([]) })).toBeUndefined();
    expect(activeRepoSentinelForDisplay({ sentinelContent: '  \n', sessionRoots: ['/r'], hasGitDir: hasGit([]) })).toBeUndefined();
  });
});

describe('compactDurableReviewStatus timer + token badge (footer enhancement)', () => {
  const base = { head: 'h', lanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'], completed: [] as string[], running: ['code-reviewer'] };

  it('renders the bare row with no badge when neither elapsedMs nor tokens are given (back-compat)', () => {
    expect(compactDurableReviewStatus(base)).toBe('Review code | spec | docs');
  });

  it('prepends a leading M:SS timer badge when elapsedMs is given', () => {
    expect(compactDurableReviewStatus({ ...base, elapsedMs: 78_000 })).toBe('Review 1:18 · code | spec | docs');
  });

  it('appends per-lane token totals to the matching lane label', () => {
    const row = compactDurableReviewStatus({ ...base, completed: ['code-reviewer'], laneTokens: { 'code-reviewer': 2_120 } });
    expect(row).toContain('code 2.1k');
  });

  it('omits a lane token figure when its count is absent or zero', () => {
    expect(compactDurableReviewStatus({ ...base, laneTokens: { 'spec-reviewer': 0 } })).toBe('Review code | spec | docs');
  });
});

describe('formatReviewElapsed / formatReviewTokens', () => {
  it('formats elapsed as M:SS, zero-padding seconds', () => {
    expect(formatReviewElapsed(0)).toBe('0:00');
    expect(formatReviewElapsed(9_000)).toBe('0:09');
    expect(formatReviewElapsed(78_000)).toBe('1:18');
    expect(formatReviewElapsed(605_000)).toBe('10:05');
  });

  it('formats tokens compactly (raw < 1k, 1-decimal k, integer k for >= 100k)', () => {
    expect(formatReviewTokens(950)).toBe('950');
    expect(formatReviewTokens(2_000)).toBe('2k');
    expect(formatReviewTokens(2_120)).toBe('2.1k');
    expect(formatReviewTokens(124_000)).toBe('124k');
  });
});

describe('mergeGateDecision (the gh-pr-merge last-line-of-defense)', () => {
  const base: MergeGateInput = {
    prReadable: true, prExists: true, prEnforced: true, prMalformed: false,
    enforcedHead: 'h1', headAcked: false, candidates: [], bypassPresent: false,
  };

  it('blocks an enforced PR whose head is not acked', () => {
    expect(mergeGateDecision(base)).toEqual({ action: 'block', head: 'h1', reason: 'head_not_acked' });
  });

  it('allows an enforced PR whose head is acked', () => {
    expect(mergeGateDecision({ ...base, headAcked: true })).toEqual({ action: 'allow' });
  });

  it('allows a readable non-enforced PR (base not protected / closed) even with the head unacked', () => {
    expect(mergeGateDecision({ ...base, prEnforced: false })).toEqual({ action: 'allow' });
  });

  it('allows when gh is readable but there is genuinely no PR', () => {
    expect(mergeGateDecision({ ...base, prExists: false, prEnforced: false })).toEqual({ action: 'allow' });
  });

  it('fails CLOSED on a transient gh failure when a review is pending unacked (R2)', () => {
    const d = mergeGateDecision({ ...base, prReadable: false, prEnforced: false, enforcedHead: '', candidates: [{ head: 'p1', acked: false }] });
    expect(d).toEqual({ action: 'block', head: 'p1', reason: 'pr_state_unreadable_review_pending' });
  });

  it('allows on a transient gh failure when NOTHING is pending (no basis to block)', () => {
    expect(mergeGateDecision({ ...base, prReadable: false, prEnforced: false, enforcedHead: '', candidates: [] })).toEqual({ action: 'allow' });
  });

  it('does not fail closed on a transient failure when the only pending candidate is already acked', () => {
    expect(mergeGateDecision({ ...base, prReadable: false, prEnforced: false, enforcedHead: '', candidates: [{ head: 'p1', acked: true }] })).toEqual({ action: 'allow' });
  });

  it('fails CLOSED on a readable-but-malformed PR (OPEN, empty base/oid) with a pending review (R1)', () => {
    const d = mergeGateDecision({ ...base, prMalformed: true, prEnforced: false, enforcedHead: '', candidates: [{ head: 'p1', acked: false }] });
    expect(d).toEqual({ action: 'block', head: 'p1', reason: 'pr_state_malformed_review_pending' });
  });

  it('uses a latched-breaker / outstanding-offer head as a fail-closed candidate (R2, no pending.json)', () => {
    const d = mergeGateDecision({ ...base, prReadable: false, prEnforced: false, enforcedHead: '', candidates: [{ head: 'breaker1', acked: false }] });
    expect(d).toEqual({ action: 'block', head: 'breaker1', reason: 'pr_state_unreadable_review_pending' });
  });

  it('converts any would-be block into a bypass when the user-only sentinel is present', () => {
    expect(mergeGateDecision({ ...base, bypassPresent: true })).toEqual({ action: 'bypass', head: 'h1' });
  });

  it('does not consume a bypass when the merge would be allowed anyway', () => {
    expect(mergeGateDecision({ ...base, headAcked: true, bypassPresent: true })).toEqual({ action: 'allow' });
  });
});

/**
 * Review monitor delivery uses durable lane files + summary.md as the gate and Pi's normal
 * background-agent completion notification as the wake-up path.
 */
describe('review monitor delivery', () => {
  it('requires every lane result and summary before requesting autofix from the main session', () => {
    const missingSummary = reviewMonitorDecision({
      lanes: ['code-reviewer', 'spec-reviewer'],
      resultExists: () => true,
      summaryExists: false,
      failedLanes: [],
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      approvalRequired: false,
    });
    const ready = reviewMonitorDecision({
      lanes: ['code-reviewer', 'spec-reviewer'],
      resultExists: () => true,
      summaryExists: true,
      failedLanes: [],
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      approvalRequired: false,
    });

    expect(missingSummary).toEqual({ status: 'waiting', action: 'wait', missing: ['summary'], failed: [] });
    expect(ready).toEqual({ status: 'ready', action: 'autofix_required', missing: [], failed: [] });
  });
});
