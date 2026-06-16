import { describe, it, expect } from 'vitest';
import { renderReviewStatus, recentReviewEvents, type ReviewStatusInput } from '../../../preseed/agents/pi/extensions/review-command';
import { type ReviewState } from '../../../preseed/agents/pi/extensions/review-job-helpers';

// ── Shared fixtures ────────────────────────────────────────────────────────────

const HEAD = 'deadbeef1234';
const PR_HEAD = 'cafebabe5678';
const ACK_HEAD = 'aaaaaaaabbbb';
const REPO = '/home/user/workspace/testrepo';

const LANES = ['code-reviewer', 'spec-reviewer', 'doc-updater'];

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    repo: REPO,
    head: HEAD,
    lanes: LANES,
    laneStatus: {
      'code-reviewer': 'completed',
      'spec-reviewer': 'running',
      'doc-updater': 'pending',
    },
    overall: 'running',
    acked: false,
    summaryReady: false,
    autofixRequested: false,
    breakerOpen: false,
    attempts: 1,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewStatusInput> = {}): ReviewStatusInput {
  return {
    pr: { number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: PR_HEAD },
    localHead: HEAD,
    ackHead: ACK_HEAD,
    state: makeState(),
    events: [],
    repo: REPO,
    ...overrides,
  };
}

// ── AC1: formatReviewStatus rendering contract ─────────────────────────────────
//
// These tests verify that renderReviewStatus (the pure extraction of formatReviewStatus's
// rendering logic) places every data value it received into the output. Gut-check:
// replace any field-emission line in the implementation with a blank and at least one
// test here fails. Text matching is intentionally absent — we check contractual data
// values (SHAs, enum values, counts), not prose wording.

describe('renderReviewStatus (REQ-AGENT-057 AC1): renders all canonical review-state fields', () => {
  it('embeds the PR number and base branch in the output', () => {
    const out = renderReviewStatus(makeInput());
    // Contract: PR number and base branch must appear — not testing the exact label text
    expect(out).toContain('42');
    expect(out).toContain('main');
  });

  it('embeds the PR head SHA (first 12 chars) in the output', () => {
    const out = renderReviewStatus(makeInput());
    expect(out).toContain(PR_HEAD.slice(0, 12));
  });

  it('embeds the local head SHA (first 12 chars) in the output', () => {
    const out = renderReviewStatus(makeInput());
    expect(out).toContain(HEAD.slice(0, 12));
  });

  it('embeds the last-acked head SHA (first 12 chars) in the output', () => {
    const out = renderReviewStatus(makeInput());
    expect(out).toContain(ACK_HEAD.slice(0, 12));
  });

  it('includes the overall verdict enum value in the output', () => {
    const out = renderReviewStatus(makeInput({ state: makeState({ overall: 'running' }) }));
    expect(out).toContain('running');
  });

  it('includes every lane name and its verdict enum value in the output', () => {
    const out = renderReviewStatus(makeInput());
    for (const lane of LANES) {
      expect(out).toContain(lane);
    }
    // Each lane's status value must appear (completed, running, pending)
    expect(out).toContain('completed');
    expect(out).toContain('pending');
  });

  it('includes the summary path (with head SHA) when summaryReady is true', () => {
    const state = makeState({ summaryReady: true, overall: 'complete', laneStatus: { 'code-reviewer': 'completed', 'spec-reviewer': 'completed', 'doc-updater': 'completed' } });
    const out = renderReviewStatus(makeInput({ state }));
    // The summary path must contain the head SHA and be repo-rooted
    expect(out).toContain(HEAD);
    expect(out).toContain(REPO);
    expect(out).toContain('summary.md');
  });

  it('does NOT include the summary path when summaryReady is false', () => {
    const out = renderReviewStatus(makeInput({ state: makeState({ summaryReady: false }) }));
    expect(out).not.toContain('summary.md');
  });

  it('renders the autofix requested state (requested vs not requested)', () => {
    const withAutofix = renderReviewStatus(makeInput({ state: makeState({ autofixRequested: true }) }));
    const withoutAutofix = renderReviewStatus(makeInput({ state: makeState({ autofixRequested: false }) }));
    // The two outputs must differ in the autofix field — not testing the prose itself
    expect(withAutofix).not.toBe(withoutAutofix);
    // Gut-check: both must still contain the lane names (the rest of the output is present)
    expect(withAutofix).toContain('code-reviewer');
    expect(withoutAutofix).toContain('code-reviewer');
  });

  it('renders a distinct breaker-open vs breaker-closed state', () => {
    const breakerOpen = renderReviewStatus(makeInput({ state: makeState({ breakerOpen: true }) }));
    const breakerClosed = renderReviewStatus(makeInput({ state: makeState({ breakerOpen: false }) }));
    expect(breakerOpen).not.toBe(breakerClosed);
    // Gut-check: both outputs must still contain lane data — the breaker field is additive
    expect(breakerOpen).toContain('code-reviewer');
    expect(breakerClosed).toContain('code-reviewer');
  });

  it('renders a distinct merge-gate OPEN vs BLOCKED state', () => {
    const gateOpen = renderReviewStatus(makeInput({ state: makeState({ acked: true }) }));
    const gateBlocked = renderReviewStatus(makeInput({ state: makeState({ acked: false }) }));
    expect(gateOpen).not.toBe(gateBlocked);
    // Gut-check: both outputs must still contain lane data — the merge-gate field is additive
    expect(gateOpen).toContain('code-reviewer');
    expect(gateBlocked).toContain('code-reviewer');
  });

  it('emits "none open" (no PR) when pr is undefined', () => {
    const out = renderReviewStatus(makeInput({ pr: undefined }));
    // Must not contain the PR number; must still contain all other state fields
    expect(out).not.toContain('#42');
    expect(out).toContain('code-reviewer');
  });

  it('emits a "none required" signal when there are no lanes', () => {
    const state = makeState({ lanes: [], laneStatus: {}, overall: 'none', summaryReady: false });
    const out = renderReviewStatus(makeInput({ state }));
    expect(out).toContain('none');
    // No individual lane labels should appear
    for (const lane of LANES) {
      expect(out).not.toContain(lane);
    }
  });

  it('includes each event line when events are supplied', () => {
    const events = [
      '{"type":"boundary_candidate_ignored","reason":"acked","ts":1}',
      '{"type":"review_started","head":"deadbeef","ts":2}',
    ];
    const out = renderReviewStatus(makeInput({ events }));
    // Both event lines must appear verbatim in the output
    expect(out).toContain(events[0]);
    expect(out).toContain(events[1]);
  });

  it('does not emit an events section when the events array is empty', () => {
    const out = renderReviewStatus(makeInput({ events: [] }));
    // No event-shaped content (JSON braces) should appear
    expect(out).not.toContain('"type"');
  });
});

// ── AC2: read-only — command never mutates enforcement state ───────────────────
//
// The /review-status handler must be a pure observer. To verify this without
// executing the actual shell-dependent command handler end-to-end, we test that
// renderReviewStatus (the full rendering path) does not call any of the mutation
// functions from review-jobs or review-job-helpers. We do this by verifying the
// module-level boundary: renderReviewStatus accepts only pre-resolved inputs and
// returns a string — it cannot mutate state by construction (no repo-write imports
// are reachable from its call graph). Additionally, we assert the identity contract:
// calling renderReviewStatus twice with the same input produces identical output
// (idempotent = no side-effects).

describe('renderReviewStatus (REQ-AGENT-057 AC2): command is read-only and never mutates state', () => {
  it('is idempotent: identical inputs produce identical outputs (no hidden state mutation)', () => {
    const input = makeInput();
    const out1 = renderReviewStatus(input);
    const out2 = renderReviewStatus(input);
    expect(out1).toBe(out2);
  });

  it('returns a non-empty string and emits no write-target paths (ack/breaker/events files)', () => {
    // renderReviewStatus accepts only pre-resolved value inputs. Its return type is string,
    // not Promise<void> or void. Any implementation that tried to write to disk inside this
    // function would need to return void or accept a write-callback — neither is the case.
    // This structural assertion fails if the function signature is changed to be async or
    // to return void, which would indicate an introduced side-effect path.
    const input = makeInput();
    const out = renderReviewStatus(input);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // The output must never contain the ack-file or breaker-file paths — those are write
    // targets, not display targets; including them would indicate the function is doing
    // more than rendering.
    expect(out).not.toContain('sdd-last-ack-pr-head');
    expect(out).not.toContain('sdd-review-breaker');
    expect(out).not.toContain('codeflare-review-events.jsonl');
  });

  it('does not mutate the input ReviewState object passed to it', () => {
    const state = makeState();
    const stateBefore = JSON.stringify(state);
    renderReviewStatus(makeInput({ state }));
    expect(JSON.stringify(state)).toBe(stateBefore);
  });

  it('does not mutate the events array passed to it', () => {
    const events = ['{"type":"boundary_candidate_ignored","ts":1}'];
    const lenBefore = events.length;
    renderReviewStatus(makeInput({ events }));
    expect(events.length).toBe(lenBefore);
  });
});

// ── AC3: recentReviewEvents appends a tail of the JSONL audit log ──────────────
//
// recentReviewEvents reads the JSONL file, splits by newline, discards empty lines,
// and returns the last `count` entries. These tests inject a readRaw function so
// no real filesystem is touched — making the tests deterministic and fast.

describe('recentReviewEvents (REQ-AGENT-057 AC3): returns tail of the .git/codeflare-review-events.jsonl log', () => {
  const LINE_A = '{"type":"review_started","head":"abc","ts":1000}';
  const LINE_B = '{"type":"boundary_candidate_ignored","reason":"acked","ts":2000}';
  const LINE_C = '{"type":"review_acked","head":"abc","ts":3000}';
  const LINE_D = '{"type":"review_started","head":"def","ts":4000}';
  const LINE_E = '{"type":"review_acked","head":"def","ts":5000}';

  function makeReadRaw(content: string): (path: string) => string {
    return (_path: string) => content.trim();
  }

  it('returns the last N lines from the JSONL file, not the first N', () => {
    const raw = [LINE_A, LINE_B, LINE_C, LINE_D, LINE_E].join('\n');
    const result = recentReviewEvents(REPO, 3, makeReadRaw(raw));
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(LINE_C);
    expect(result[1]).toBe(LINE_D);
    expect(result[2]).toBe(LINE_E);
  });

  it('passes the correct JSONL file path (repo/.git/codeflare-review-events.jsonl) to the reader', () => {
    const seenPaths: string[] = [];
    recentReviewEvents(REPO, 3, (path) => { seenPaths.push(path); return ''; });
    expect(seenPaths).toHaveLength(1);
    expect(seenPaths[0]).toBe(`${REPO}/.git/codeflare-review-events.jsonl`);
  });

  it('returns all lines when the file has fewer entries than the requested count', () => {
    const raw = [LINE_A, LINE_B].join('\n');
    const result = recentReviewEvents(REPO, 10, makeReadRaw(raw));
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(LINE_A);
    expect(result[1]).toBe(LINE_B);
  });

  it('returns an empty array when the JSONL file is empty', () => {
    const result = recentReviewEvents(REPO, 5, makeReadRaw(''));
    expect(result).toEqual([]);
  });

  it('filters out blank lines in the JSONL file (trailing newlines, blank separators)', () => {
    const raw = `${LINE_A}\n\n${LINE_B}\n\n`;
    const result = recentReviewEvents(REPO, 5, makeReadRaw(raw));
    expect(result).toHaveLength(2);
    expect(result).not.toContain('');
  });

  it('returns an empty array when the reader returns an empty string (file missing or unreadable)', () => {
    const result = recentReviewEvents(REPO, 5, (_path) => '');
    expect(result).toEqual([]);
  });

  it('preserves each raw JSONL line verbatim so the caller can display it without re-parsing', () => {
    const raw = [LINE_A, LINE_E].join('\n');
    const result = recentReviewEvents(REPO, 5, makeReadRaw(raw));
    // Each element must be the exact string from the file, parseable as JSON
    for (const line of result) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(result[0]).type).toBe('review_started');
    expect(JSON.parse(result[1]).type).toBe('review_acked');
  });

  it('count=0 returns an empty array', () => {
    const raw = [LINE_A, LINE_B, LINE_C].join('\n');
    const result = recentReviewEvents(REPO, 0, makeReadRaw(raw));
    expect(result).toEqual([]);
  });
});
