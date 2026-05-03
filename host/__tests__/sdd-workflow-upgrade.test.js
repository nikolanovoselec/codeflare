// Static-assertion test scaffold for the workflow-upgrade branch.
//
// Asserts every change in the v3.1 plan as a content-presence check
// against the actual preseed files + entrypoint + agent prompts.
//
// At commit 1 this file is RED (every implementation is still pending).
// As commits 2-11 land, individual asserts turn green. Final state on
// merge: all asserts pass.
//
// Lives alongside entrypoint-hooks-merge.test.js — same node:test style,
// same static-grep approach.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf8');
const exists = (p) => existsSync(resolve(repoRoot, p));

// ---------------------------------------------------------------------------
// 1) documentation-discipline.md (#252) — new sibling rule file
// ---------------------------------------------------------------------------
describe('documentation-discipline.md (issue #252)', () => {
  const path = 'preseed/agents/claude/rules/documentation-discipline.md';

  it('exists in the preseed', () => {
    assert.ok(exists(path), `expected ${path} to exist`);
  });

  it('declares forbidden content list', () => {
    const content = read(path);
    assert.match(content, /forbidden|banned/i, 'should define forbidden/banned content list');
    assert.match(content, /implementation rationale/i, 'should ban implementation rationale');
    assert.match(content, /regex/i, 'should ban regex internals in cells');
    assert.match(content, /magic constant/i, 'should ban magic-constant prose');
  });

  it('declares per-file line budgets', () => {
    const content = read(path);
    // Assert filename and budget separately. The original `/file\.md.*350/`
    // single-line regex broke on table reformatting, line wrapping, and
    // column re-padding. Decoupled assertions survive cosmetic edits.
    for (const [file, budget] of [
      ['architecture.md', 350],
      ['api-reference.md', 600],
      ['configuration.md', 200],
      ['deployment.md', 200],
    ]) {
      assert.match(content, new RegExp(`\\b${file.replace('.', '\\.')}\\b`),
        `${file} mentioned`);
      assert.match(content, new RegExp(`\\b${budget}\\b\\s*lines?`, 'i'),
        `${budget}-line budget present`);
    }
  });

  it('declares per-element budgets (≤50 word table cells)', () => {
    const content = read(path);
    assert.match(content, /50 words?/i, 'table cell ≤50 words');
  });

  it('reinforces lane separation between architecture/api-reference/configuration/deployment', () => {
    const content = read(path);
    assert.match(content, /lane separation/i);
    assert.match(content, /api-reference\.md/);
    assert.match(content, /configuration\.md/);
  });

  it('documents enforcement passes for doc-updater', () => {
    const content = read(path);
    assert.match(content, /enforcement pass/i, 'should describe enforcement passes');
    assert.match(content, /per-cell/i);
    assert.match(content, /file-level/i);
  });

  it('documents pattern 13 (dual-narrative ADR detection)', () => {
    const content = read(path);
    assert.match(content, /dual.narrative/i, 'pattern 13 — dual-narrative ADRs');
  });

  it('documents pattern 15 (big-O jargon in narrative)', () => {
    const content = read(path);
    assert.match(content, /pattern\s*15|big.O\s+jargon/i, 'pattern 15 — big-O jargon');
    assert.match(content, /O\(n[^)]*\)/, 'should reference Big-O notation form');
    assert.match(content, /logarithmic|amortized|quadratic/i,
      'should call out plain-language complexity terms too');
  });

  it('provides escape hatch for legitimate exceptions', () => {
    const content = read(path);
    assert.match(content, /<!--\s*doc-allow-large/i, 'should declare <!-- doc-allow-large --> opt-out');
  });
});

// ---------------------------------------------------------------------------
// 2) doc-updater.md (#251) — per-cell + per-file budget enforcement
// ---------------------------------------------------------------------------
describe('doc-updater.md per-cell + per-file budget enforcement (issue #251)', () => {
  const path = 'preseed/agents/claude/agents/doc-updater.md';

  it('references documentation-discipline.md', () => {
    const content = read(path);
    assert.match(content, /documentation-discipline\.md/, 'should load the new rule file');
  });

  it('describes per-cell word budget enforcement', () => {
    const content = read(path);
    assert.match(content, /per-cell|table cell|cell budget/i);
    assert.match(content, /50/, 'should reference the 50-word threshold');
  });

  it('describes per-file line budget enforcement', () => {
    const content = read(path);
    assert.match(content, /file.level|file budget|line budget/i);
  });

  it('describes implementation-prose detection heuristics', () => {
    const content = read(path);
    assert.match(content, /implementation.prose|prose detection/i);
  });

  it('describes lane-violation detection (API contracts in architecture.md)', () => {
    const content = read(path);
    assert.match(content, /lane.violation|lane separation/i);
  });

  it('uses PR-boundary trigger language (not "after every push")', () => {
    const content = read(path);
    assert.doesNotMatch(content, /after every push/i, 'should drop "after every push" language');
    assert.match(content, /PR open|pull.request|PR.boundary/i, 'should describe PR-boundary trigger');
  });
});

// ---------------------------------------------------------------------------
// 3) spec-discipline.md additions (patterns 11, 12, 14)
// ---------------------------------------------------------------------------
describe('spec-discipline.md patterns 11/12/14 (issue #252 extensions)', () => {
  const path = 'preseed/agents/claude/rules/spec-discipline.md';

  it('declares pattern 11 — run-on AC bullets', () => {
    const content = read(path);
    assert.match(content, /run.on AC|AC.bullet.*word|150 word/i, 'pattern 11 — long AC bullets');
  });

  it('declares pattern 12 — mechanism leakage in AC bullets', () => {
    const content = read(path);
    assert.match(content, /mechanism leakage|cookie attribute|HttpOnly|Cf-Access/i,
      'pattern 12 — mechanism tokens in AC bullets');
  });

  it('declares pattern 14 — changelog-entry-discipline drift', () => {
    const content = read(path);
    assert.match(content, /changelog.*discipline|no AC change/i, 'pattern 14 — changelog drift');
  });

  it('references documentation-discipline.md as a sibling', () => {
    const content = read(path);
    assert.match(content, /documentation-discipline\.md/);
  });
});

// ---------------------------------------------------------------------------
// 4) spec-reviewer.md — pattern enforcement + PR-boundary triggers
// ---------------------------------------------------------------------------
describe('spec-reviewer.md trigger + pattern updates', () => {
  const path = 'preseed/agents/claude/agents/spec-reviewer.md';

  it('uses PR-boundary trigger language', () => {
    const content = read(path);
    assert.doesNotMatch(content, /Triggered after every push/i,
      'should not say "Triggered after every push"');
    assert.match(content, /PR open|PR.sync|pull.request/i,
      'should describe PR-boundary trigger');
  });

  it('references patterns 11/12/14 enforcement', () => {
    const content = read(path);
    assert.match(content, /pattern\s*11|run.on AC/i);
    assert.match(content, /pattern\s*12|mechanism leakage/i);
    assert.match(content, /pattern\s*14|changelog.*drift/i);
  });
});

// ---------------------------------------------------------------------------
// 5) code-reviewer.md — diff source for PR context
// ---------------------------------------------------------------------------
describe('code-reviewer.md PR-aware diff source', () => {
  const path = 'preseed/agents/claude/agents/code-reviewer.md';

  it('uses PR-boundary trigger language', () => {
    const content = read(path);
    assert.doesNotMatch(content, /post.push|after every push/i,
      'should drop "post-push" / "after every push" language');
    assert.match(content, /PR open|PR.sync|pull.request|PR.boundary/i,
      'must describe PR-boundary trigger');
  });

  it('describes PR-base-aware diff resolution', () => {
    const content = read(path);
    assert.match(content, /baseRefName|gh pr view.*base|PR.base/i,
      'should resolve diff source from the PR base, not just origin/main');
  });
});

// ---------------------------------------------------------------------------
// 6) git-workflow.md — PR-boundary semantics + branch-protection guidance
// ---------------------------------------------------------------------------
describe('git-workflow.md PR-boundary semantics', () => {
  const path = 'preseed/agents/claude/rules/common/git-workflow.md';

  it('declares PR-boundary as the review trigger', () => {
    const content = read(path);
    assert.match(content, /PR open|pull.request|PR.boundary/i);
  });

  it('documents the recommended feature → develop → main workflow', () => {
    const content = read(path);
    assert.match(content, /feature.*develop.*main/i, 'should show the recommended workflow');
  });

  it('clarifies direct push to develop is fine (deferred review)', () => {
    const content = read(path);
    assert.match(content, /direct push.*develop|develop.*fine|caught.*develop.main PR/i);
  });

  it('surfaces branch protection on main when setting up CI', () => {
    const content = read(path);
    assert.match(content, /branch protection/i,
      'should explain GitHub branch protection on main');
    assert.match(content, /proactively|surface|don.t wait/i,
      'should instruct the agent to surface this proactively, not passively');
  });

  it('provides a concrete gh api command for branch protection', () => {
    const content = read(path);
    assert.match(content, /gh api.*branches\/main\/protection/);
  });
});

// ---------------------------------------------------------------------------
// 7) git-push-review-reminder.sh — PR-aware detection
// ---------------------------------------------------------------------------
describe('git-push-review-reminder.sh PR-aware detection', () => {
  const path = 'preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh';

  it('detects gh pr create as PR-open trigger', () => {
    const content = read(path);
    assert.match(content, /gh pr create/);
  });

  it('checks gh pr view for current branch before emitting on git push', () => {
    const content = read(path);
    assert.match(content, /gh pr view/);
  });

  it('uses cache file with TTL to avoid hammering gh on every push', () => {
    const content = read(path);
    assert.match(content, /sdd-pr-cache|pr.cache/);
  });

  it('still has the cheap raw-input pre-filter for non-push Bash calls', () => {
    const content = read(path);
    assert.match(content, /git push.*\)|gh pr create.*\)/, 'pre-filter on raw input');
  });

  it('does NOT emit any directive on direct push to main without open PR', () => {
    const content = read(path);
    assert.doesNotMatch(content, /Ask the user/i,
      'hook must not prompt the user — manual verification is on the user, not via directive');
    assert.doesNotMatch(content, /informational.*direct push/i,
      'no informational directive on direct main pushes either');
    // Positive companion: confirm the deferred-exit path actually exists.
    // Without this, an empty file or a hook that emits nothing at all
    // would also pass — we want to pin "exits silently on no-PR" as a
    // real code path, not just absence of forbidden phrases.
    assert.match(content, /exit\s+0|deferred/i,
      'must contain a deferred/exit-silently path for no-open-PR case');
  });
});

// ---------------------------------------------------------------------------
// 8) enforce-review-spawn.sh v5 — PR HEAD SHA checkpoint
// ---------------------------------------------------------------------------
describe('enforce-review-spawn.sh v5 PR HEAD SHA checkpoint', () => {
  const path = 'preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh';

  it('uses PR HEAD SHA checkpoint key', () => {
    const content = read(path);
    assert.match(content, /sdd-last-ack-pr-head/, 'new checkpoint key');
  });

  it('queries gh pr view for current branch', () => {
    const content = read(path);
    assert.match(content, /gh pr view/);
  });

  it('exits silently if no open PR for current branch', () => {
    const content = read(path);
    assert.match(content, /open PR|no.*PR.*exit|no.*pull.request.*exit/i);
  });

  it('keeps reflog as truth layer (v4 carryover)', () => {
    const content = read(path);
    assert.match(content, /reflog|update by push/i, 'reflog detection preserved');
  });

  it('keeps three USER-ONLY bypasses', () => {
    const content = read(path);
    assert.match(content, /sdd\/\.skip-next-review/);
    assert.match(content, /skip review/i);
    assert.match(content, /3.strike|strike.*3|circuit breaker/i);
  });

  it('keeps vibe-coding gate', () => {
    const content = read(path);
    assert.match(content, /sdd\/README\.md/);
  });
});

// ---------------------------------------------------------------------------
// 9) entrypoint.sh — hook registration
// ---------------------------------------------------------------------------
describe('entrypoint.sh hook registration', () => {
  const path = 'entrypoint.sh';

  it('does NOT register the deleted warn-direct-push-to-shared.sh', () => {
    const content = read(path);
    assert.doesNotMatch(content, /warn-direct-push-to-shared\.sh/,
      'hook script was deleted; entrypoint must not register it');
  });

  it('still registers all retained hooks', () => {
    const content = read(path);
    assert.match(content, /block-attributed-commits\.sh/);
    assert.match(content, /git-push-review-reminder\.sh/);
    assert.match(content, /enforce-review-spawn\.sh/);
    assert.match(content, /memory-capture\.sh/);
  });

  it('keeps SESSION_MODE=advanced gating', () => {
    const content = read(path);
    assert.match(content, /SESSION_MODE.*advanced/);
  });
});

// ---------------------------------------------------------------------------
// 10) sdd/config.yml — sdd_review section was removed (over-engineered)
// ---------------------------------------------------------------------------
describe('sdd/config.yml schema', () => {
  const path = 'sdd/config.yml';

  it('does NOT contain the removed sdd_review section', () => {
    const content = read(path);
    assert.doesNotMatch(content, /sdd_review:/,
      'sdd_review was over-engineered and removed; branch protection is the enforcement');
    assert.doesNotMatch(content, /protected_branches:/);
    assert.doesNotMatch(content, /warn_on_direct_push:/);
  });
});

// ---------------------------------------------------------------------------
// 11) sdd/agents.md — REQ-AGENT-021 AC#4 + REQ-AGENT-005 updates
// ---------------------------------------------------------------------------
describe('sdd/agents.md REQ updates', () => {
  const path = 'sdd/agents.md';

  it('REQ-AGENT-021 AC#4 uses PR-boundary semantics', () => {
    const content = read(path);
    const reqStart = content.indexOf('## REQ-AGENT-021:');
    const reqEnd = content.indexOf('---', reqStart);
    const reqBlock = content.slice(reqStart, reqEnd);
    assert.doesNotMatch(reqBlock, /After every push/i,
      'AC#4 should not say "after every push"');
    assert.match(reqBlock, /PR open|pull.request|PR.boundary/i,
      'AC#4 should reference PR-boundary trigger');
  });

  it('REQ-AGENT-021 AC#4 references branch protection (not the deleted hook)', () => {
    const content = read(path);
    const reqStart = content.indexOf('## REQ-AGENT-021:');
    const reqEnd = content.indexOf('---', reqStart);
    const reqBlock = content.slice(reqStart, reqEnd);
    assert.match(reqBlock, /branch protection/i,
      'AC#4 should defer direct-push-to-main bypass to GitHub branch protection');
    assert.doesNotMatch(reqBlock, /warn-direct-push-to-shared/,
      'AC#4 must not reference the deleted hook');
  });
});

// ---------------------------------------------------------------------------
// 12) sdd/changes.md — 2026-05-03 changelog entry
// ---------------------------------------------------------------------------
describe('sdd/changes.md changelog entry', () => {
  const path = 'sdd/changes.md';

  it('has a 2026-05-03 entry summarizing the workflow shift', () => {
    const content = read(path);
    assert.match(content, /2026-05-03/);
  });

  it('mentions PR-boundary trigger semantics', () => {
    const content = read(path);
    const date = '2026-05-03';
    const idx = content.indexOf(`## ${date}`);
    if (idx === -1) return;
    const next = content.indexOf('## ', idx + 3);
    const entry = content.slice(idx, next === -1 ? undefined : next);
    assert.match(entry, /PR.boundary|per.PR|PR open|pull.request/i,
      'entry should reference PR-boundary trigger');
  });
});

// ---------------------------------------------------------------------------
// 13) /sdd init template — one-line tables (issue #253)
// ---------------------------------------------------------------------------
describe('/sdd init architecture.md template (issue #253)', () => {
  const skillPath = 'preseed/agents/claude/skills/spec-driven-development/SKILL.md';

  it('SKILL.md exists', () => {
    assert.ok(exists(skillPath));
  });

  it('declares one-line table cell convention for architecture.md', () => {
    const content = read(skillPath);
    assert.match(content, /one.line|≤\s*50 words?|architecture\.md.*template/i);
  });

  it('embeds doc-discipline directive comments in template', () => {
    const content = read(skillPath);
    assert.match(content, /<!--\s*doc-discipline/);
  });
});
