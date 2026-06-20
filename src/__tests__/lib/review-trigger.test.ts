import { describe, it, expect } from 'vitest';
import { boundaryFallbackHead, boundaryTriggerCommands, commandTextFromEvent, completeTranscriptDelta, gitPushCommandTarget, isFailedToolExecution, isPrBoundaryTrigger, isPrBoundaryCommand, isGhPrMergeCommand, isGitPushOnlyCommand, mergeCommandTarget, prBoundaryCommandBase, prCreateCommandTarget, prEditBoundaryBase, prEditCommandTarget, prEnforcedForPush, prUpdateBranchCommandTarget, classifyReviewFiles, isGeneratedArtifactPath, isGeneratedOnlyDiff, prUrlFromText, enforcedHeadDecision, ghPrCreateBase, startedBoundaryCommandForToolEnd } from '../../../preseed/agents/pi/extensions/review-helpers';

/**
 * isPrBoundaryTrigger is the single "should this command start a review?" predicate.
 * The load-bearing safety property is that `gh pr merge` is NOT a trigger (it is the
 * merge gate) while it IS still a low-level boundary word — these tests fail if that
 * distinction regresses, or if the main/master base gate on `gh pr create` is dropped.
 */
describe('isPrBoundaryTrigger', () => {
  it('treats git push as a boundary', () => {
    expect(isPrBoundaryTrigger('git push origin develop')).toBe(true);
    expect(isPrBoundaryTrigger('git -C /repo push')).toBe(true);
  });

  it('treats gh repo sync as a boundary', () => {
    expect(isPrBoundaryTrigger('gh repo sync')).toBe(true);
  });

  it('treats gh pr update-branch as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr update-branch')).toBe(true);
  });

  it('treats gh pr create targeting main/master (or default base) as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr create --base main --title x')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr create --base master')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr create --title x')).toBe(true);
  });

  it('does NOT treat gh pr create targeting a non-main base, draft, or dry-run as a boundary', () => {
    expect(ghPrCreateBase('gh pr create --base develop --title x')).toBe('develop');
    expect(isPrBoundaryTrigger('gh pr create --base develop --title x')).toBe(false);
    expect(isPrBoundaryTrigger('gh pr create --base main --draft')).toBe(false);
    expect(isPrBoundaryTrigger('gh pr create --base main --dry-run')).toBe(false);
  });

  it('treats gh pr edit retargeting an existing PR onto main/master as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr edit 286 --base main')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr edit --base=master')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr edit 286 -B main')).toBe(true);
  });

  it('does NOT treat gh pr edit onto a non-main base, or a non-base edit, as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr edit 286 --base develop')).toBe(false);
    expect(isPrBoundaryTrigger('gh pr edit 286 --title x --body y')).toBe(false);
  });

  it('does NOT treat gh pr merge as a trigger, but the word matcher still sees it as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr merge 501 --squash')).toBe(false);
    expect(isPrBoundaryCommand('gh pr merge 501 --squash')).toBe(true);
  });

  it('finds the boundary inside a compound command', () => {
    expect(isPrBoundaryTrigger('cd /repo && git add -A && git commit -m x && git push')).toBe(true);
  });

  it('returns false for non-boundary commands, including clone-only setup', () => {
    expect(isPrBoundaryTrigger('git status')).toBe(false);
    expect(isPrBoundaryTrigger('git commit -m "wip"')).toBe(false);
    expect(isPrBoundaryTrigger('git clone https://github.com/o/r.git')).toBe(false);
    expect(isPrBoundaryTrigger('gh repo clone o/r')).toBe(false);
    expect(isPrBoundaryTrigger('ls -la')).toBe(false);
  });

  it('does NOT treat a dry-run / branch-delete push as a boundary (it cannot advance a PR head)', () => {
    // A credential-probe dry run or a branch teardown must not arm review on an inherited unacked head
    // (that would wrongly AUTOSTART where the design says OFFER).
    expect(isPrBoundaryTrigger('git push --dry-run')).toBe(false);
    expect(isPrBoundaryTrigger('git push -n origin main')).toBe(false);
    expect(isPrBoundaryTrigger('git push origin --delete oldbranch')).toBe(false);
    expect(isGitPushOnlyCommand('git push -d origin oldbranch')).toBe(false);
    expect(isPrBoundaryTrigger('git push --tags')).toBe(false);
    expect(isPrBoundaryTrigger('git push origin --tags')).toBe(false);
    expect(isPrBoundaryTrigger('git push origin tag v1')).toBe(false);
    expect(isPrBoundaryTrigger('git push origin refs/tags/v1')).toBe(false);
    // But a real push — including a branch+tags push, follow-tags, or a force push — is still a boundary.
    expect(isPrBoundaryTrigger('git push origin main')).toBe(true);
    expect(isPrBoundaryTrigger('git push origin main --tags')).toBe(true);
    expect(isPrBoundaryTrigger('git push --follow-tags')).toBe(true);
    expect(isPrBoundaryTrigger('git push --force origin main')).toBe(true);
  });
});


describe('command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)', () => {
  it('extracts explicit push refspec target branches and ignores tag/delete-only pushes', () => {
    expect(gitPushCommandTarget('git push origin HEAD:multiview')).toEqual({ advancing: true, branch: 'multiview', source: 'HEAD', targets: [{ branch: 'multiview', source: 'HEAD' }] });
    expect(gitPushCommandTarget('git push origin feature:refs/heads/multiview')).toEqual({ advancing: true, branch: 'multiview', source: 'feature', targets: [{ branch: 'multiview', source: 'feature' }] });
    expect(gitPushCommandTarget('git push origin already-reviewed multiview')).toEqual({ advancing: true, branch: 'already-reviewed', source: 'already-reviewed', targets: [{ branch: 'already-reviewed', source: 'already-reviewed' }, { branch: 'multiview', source: 'multiview' }] });
    expect(gitPushCommandTarget('git push origin HEAD')).toEqual({ advancing: true, branch: undefined, source: 'HEAD', targets: [{ source: 'HEAD' }] });
    expect(gitPushCommandTarget('git push origin @')).toEqual({ advancing: true, branch: undefined, source: '@', targets: [{ source: '@' }] });
    expect(gitPushCommandTarget('git push origin HEAD multiview')).toEqual({ advancing: true, branch: undefined, source: 'HEAD', targets: [{ source: 'HEAD' }, { branch: 'multiview', source: 'multiview' }] });
    expect(gitPushCommandTarget('git push origin :oldbranch')).toEqual({ advancing: false });
    expect(gitPushCommandTarget('git push --tags')).toEqual({ advancing: false });
    expect(gitPushCommandTarget('git push origin --tags')).toEqual({ advancing: false });
    expect(gitPushCommandTarget('git push origin tag v1')).toEqual({ advancing: false });
    expect(gitPushCommandTarget('git push --follow-tags')).toEqual({ advancing: true, branch: undefined, source: undefined, targets: undefined });
  });

  it('extracts target selectors from the same protected-boundary shell segment', () => {
    expect(prEditBoundaryBase('gh pr edit 111 --title x && gh pr edit 222 --base main')).toBe('main');
    expect(prEditCommandTarget('gh pr edit 111 --title x && gh pr edit 222 --base main')).toEqual({ prNumber: 222 });
    expect(prBoundaryCommandBase('gh pr create --base develop --title x && gh pr create --head multiview --base main')).toBe('main');
    expect(prCreateCommandTarget('gh pr create --base develop --title x && gh pr create --head multiview --base main')).toEqual({ headBranch: 'multiview', draft: false, dryRun: false });
  });

  it('extracts gh pr create and update-branch targets without treating flag values as selectors', () => {
    expect(prCreateCommandTarget('gh pr create --repo owner/repo --head feature --base main')).toEqual({ repoSlug: 'owner/repo', headBranch: 'feature', draft: false, dryRun: false });
    expect(prCreateCommandTarget('gh pr create --draft --dry-run --base main')).toEqual({ draft: true, dryRun: true });
    expect(prUpdateBranchCommandTarget('gh pr update-branch 563 --rebase')).toEqual({ prNumber: 563 });
    expect(prUpdateBranchCommandTarget('gh pr update-branch feature-branch --repo owner/repo')).toEqual({ repoSlug: 'owner/repo', prBranch: 'feature-branch' });
  });

  it('selects concrete trigger segments without merging targets across compound commands', () => {
    expect(boundaryTriggerCommands('gh pr create --repo other/repo --base main && git push origin multiview')).toEqual([
      'gh pr create --repo other/repo --base main',
      'git push origin multiview',
    ]);
  });

  it('selects a later real boundary from batched tool commands over an earlier broad non-trigger', () => {
    const event = { input: { commands: [{ command: 'gh pr create --base develop' }, { command: 'git push origin multiview' }] } };
    expect(commandTextFromEvent(event)).toBe('git push origin multiview');
  });

  it('treats failed and nonzero tool executions as failed boundaries', () => {
    expect(isFailedToolExecution({ status: 'failed' })).toBe(true);
    expect(isFailedToolExecution({ exitCode: 1 })).toBe(true);
    expect(isFailedToolExecution({ status: 'success', exitCode: 0 })).toBe(false);
  });
});

/**
 * The merge gate (isGhPrMerge) and head-resolution (isLocalGitPush)
 * predicates must use the SAME wrapper-tolerant command parsing as detection. The old weak
 * inline patterns (`gh\s+pr\s+merge`, `git(?:\s+-C\s+\S+)?\s+push`) let an env-prefixed command be
 * DETECTED as a boundary yet SKIP the gate (unreviewed merge) or take the wrong head branch.
 */
describe('isGhPrMergeCommand / isGitPushOnlyCommand are env-prefix tolerant', () => {
  it('matches gh pr merge with and without an env prefix', () => {
    expect(isGhPrMergeCommand('gh pr merge 501 --squash')).toBe(true);
    expect(isGhPrMergeCommand('GH_TOKEN=abc gh pr merge 501 --squash')).toBe(true);
    expect(isGhPrMergeCommand('GH_PAGER= gh pr merge --admin')).toBe(true);
    expect(isGhPrMergeCommand('cd /repo && gh pr merge')).toBe(true);
  });
  it('does not match non-merge gh commands', () => {
    expect(isGhPrMergeCommand('gh pr create --base main')).toBe(false);
    expect(isGhPrMergeCommand('gh pr view 501')).toBe(false);
    expect(isGhPrMergeCommand('echo gh pr merge')).toBe(false);
  });
  it('matches gh pr merge behind a command wrapper (timeout/env/command/nice) — P2', () => {
    expect(isGhPrMergeCommand('timeout 60 gh pr merge 501 --squash')).toBe(true);
    expect(isGhPrMergeCommand('timeout --signal=KILL 60 gh pr merge')).toBe(true);
    expect(isGhPrMergeCommand('env gh pr merge --admin')).toBe(true);
    expect(isGhPrMergeCommand('env -u GH_TOKEN GH_TOKEN=x gh pr merge --admin')).toBe(true);
    expect(isGhPrMergeCommand('command gh pr merge')).toBe(true);
    expect(isGhPrMergeCommand('nice -n 10 gh pr merge')).toBe(true);
    expect(isGhPrMergeCommand('GH_TOKEN=x timeout 30 gh pr merge 7')).toBe(true);
  });
  it('matches git push with env prefix / global opts', () => {
    expect(isGitPushOnlyCommand('git push origin develop')).toBe(true);
    expect(isGitPushOnlyCommand("GIT_SSH_COMMAND='ssh -i k' git push")).toBe(true);
    expect(isGitPushOnlyCommand('git -C /repo push')).toBe(true);
    expect(isGitPushOnlyCommand('git -c core.sshCommand=ssh push')).toBe(true);
  });
  it('does not match gh repo sync or non-push git', () => {
    expect(isGitPushOnlyCommand('gh repo sync')).toBe(false);
    expect(isGitPushOnlyCommand('git status')).toBe(false);
  });
});

describe('completeTranscriptDelta', () => {
  function bashToolCallLine(command: string): string {
    return `${JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'bash', arguments: { command } }],
      },
    })}\n`;
  }

  function commandFromToolCallLine(line: string): string {
    const entry = JSON.parse(line);
    const part = entry.message.content[0];
    return commandTextFromEvent({ toolName: part.name, input: part.arguments, args: part.arguments, params: part.arguments, arguments: part.arguments });
  }

  it('keeps the first new complete record after an existing cursor', () => {
    const line = bashToolCallLine('cd /repo && git commit -m x && git push origin multiview');
    const delta = completeTranscriptDelta({ text: line, start: 12_345, fromCursor: true });

    expect(delta).toEqual({
      text: line,
      start: 12_345,
      nextCursor: 12_345 + Buffer.byteLength(line, 'utf8'),
    });
    expect(commandFromToolCallLine(delta?.text.trim() || '')).toBe('cd /repo && git commit -m x && git push origin multiview');
  });

  it('drops only the first partial record for fallback scans', () => {
    const line = bashToolCallLine('git push origin multiview');
    const delta = completeTranscriptDelta({ text: `partial-json-record\n${line}`, start: 10, fromCursor: false });

    expect(delta?.text).toBe(line);
    expect(commandFromToolCallLine(delta?.text.trim() || '')).toBe('git push origin multiview');
  });

  it('does not advance past an incomplete trailing record', () => {
    const partial = bashToolCallLine('git push origin multiview').trimEnd();

    expect(completeTranscriptDelta({ text: partial, start: 0, fromCursor: true })).toBeUndefined();
  });
});

describe('startedBoundaryCommandForToolEnd', () => {
  const base = { endToolId: 'tool-1', startedToolId: 'tool-1', ageMs: 500, maxAgeMs: 120_000 };

  it('recovers same-tool PR-boundary commands whose end event lost command text', () => {
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'git push origin multiview' })).toBe('git push origin multiview');
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'gh pr create --base main' })).toBe('gh pr create --base main');
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'gh pr edit 563 --base main' })).toBe('gh pr edit 563 --base main');
  });

  it('does not recover clone-only, stale, or mismatched-tool commands', () => {
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'git clone https://github.com/o/r.git' })).toBeUndefined();
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'gh repo clone o/r' })).toBeUndefined();
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'git push origin multiview', startedToolId: 'other-tool' })).toBeUndefined();
    expect(startedBoundaryCommandForToolEnd({ ...base, startedCommand: 'git push origin multiview', ageMs: 121_000 })).toBeUndefined();
  });
});

describe('mergeCommandTarget (which PR a gh-pr-merge command targets — P1/P3)', () => {
  it('extracts a numeric PR selector', () => {
    expect(mergeCommandTarget('gh pr merge 42 --squash')).toEqual({ prNumber: 42, auto: false });
  });
  it('extracts a PR number from a /pull/<n> URL', () => {
    expect(mergeCommandTarget('gh pr merge https://github.com/o/r/pull/42 --merge')).toEqual({ prNumber: 42, auto: false });
  });
  it('treats a non-numeric positional as a branch selector', () => {
    expect(mergeCommandTarget('gh pr merge feature/login --rebase')).toEqual({ prBranch: 'feature/login', auto: false });
  });
  it('captures --repo and -R slugs', () => {
    expect(mergeCommandTarget('gh pr merge 7 --repo owner/repo')).toEqual({ prNumber: 7, repoSlug: 'owner/repo', auto: false });
    expect(mergeCommandTarget('gh pr merge --repo=owner/repo 9')).toEqual({ prNumber: 9, repoSlug: 'owner/repo', auto: false });
  });
  it('flags --auto', () => {
    expect(mergeCommandTarget('gh pr merge --auto --squash 3')).toEqual({ prNumber: 3, auto: true });
  });
  it('no selector for a bare current-branch merge', () => {
    expect(mergeCommandTarget('gh pr merge --squash')).toEqual({ auto: false });
  });
  it('does not mistake a value-bearing flag value for the selector', () => {
    // --body's value "42" must NOT be read as PR #42.
    expect(mergeCommandTarget('gh pr merge --body 42 --squash')).toEqual({ auto: false });
  });
  it('skips the value of the short value-bearing flags -F / -A / --author-email', () => {
    // The skip-list must cover the real `gh pr merge` value flags, not a phantom one.
    // -F (--body-file) takes a filename; the following "7" is the real PR selector.
    expect(mergeCommandTarget('gh pr merge -F note.txt 7 --squash')).toEqual({ prNumber: 7, auto: false });
    // -A / --author-email take an email; it must NOT be read as a branch selector, and a
    // trailing positional is still the PR number.
    expect(mergeCommandTarget('gh pr merge -A me@example.com 7')).toEqual({ prNumber: 7, auto: false });
    expect(mergeCommandTarget('gh pr merge --author-email me@example.com --merge')).toEqual({ auto: false });
  });
  it('keeps a QUOTED multi-word flag value as one token (does not split it into a phantom selector)', () => {
    // A raw whitespace split would read the tail of `'fix the gateway'` ("gateway") as the PR selector
    // and point the merge gate at the WRONG PR (fail open). The quote-aware tokenizer keeps it one token,
    // so the trailing positional is the real selector.
    expect(mergeCommandTarget("gh pr merge -t 'fix the gateway' 42 --squash")).toEqual({ prNumber: 42, auto: false });
    expect(mergeCommandTarget('gh pr merge --subject "a b c" 7')).toEqual({ prNumber: 7, auto: false });
    // A quoted body value before a branch selector likewise stays intact.
    expect(mergeCommandTarget("gh pr merge -b 'msg here' feature/x")).toEqual({ prBranch: 'feature/x', auto: false });
  });
  it('reads the target through a command wrapper', () => {
    expect(mergeCommandTarget('timeout 60 gh pr merge 88 --merge')).toEqual({ prNumber: 88, auto: false });
    expect(mergeCommandTarget('env -u GH_TOKEN GH_TOKEN=x gh pr merge 89 --merge')).toEqual({ prNumber: 89, auto: false });
  });
});

/**
 * Robustness regression for the stateless-regex boundary parser (the rewrite away from the
 * stateful shell tokenizer that desynced on heredoc bodies). These are the exact shapes Pi
 * pushed with that the old word-tokenizer dropped on the floor, leaving a real PR-to-main with
 * no review offered: a `gh pr create` whose --body carries a heredoc full of markdown pipes and
 * apostrophes (which mis-split the tokenizer); pushes over ssh/https remote URLs; an env-var
 * prefix with a quoted, space-bearing value (`GIT_SSH_COMMAND='ssh -i k' git push`); and a
 * batched create+edit. The regex matches the verb directly in the raw string, so heredoc body
 * content can never desync detection.
 */
describe('isPrBoundaryTrigger robustness (regex parser, not a shell tokenizer)', () => {
  it('detects a gh pr create whose heredoc --body carries markdown pipes and apostrophes', () => {
    const cmd = `gh pr create --base main --title "x" --body "$(cat <<'EOF'\n| col | col |\nit's a test\nEOF\n)"`;
    expect(isPrBoundaryTrigger(cmd)).toBe(true);
  });

  it('detects a push over an ssh or https remote URL', () => {
    expect(isPrBoundaryTrigger('git push git@github.com:org/repo.git main')).toBe(true);
    expect(isPrBoundaryTrigger('git push https://github.com/org/repo.git main')).toBe(true);
  });

  it('detects a push behind an env-var prefix with a quoted, space-bearing value', () => {
    expect(isPrBoundaryTrigger(`GIT_SSH_COMMAND='ssh -i k' git push origin main`)).toBe(true);
  });

  it('detects the protected create/edit inside a batched compound command', () => {
    expect(isPrBoundaryTrigger('gh pr create --base develop && gh pr edit 5 --base main')).toBe(true);
  });

  it('does not false-trigger on a quoted literal or an env-var that merely contains "git"', () => {
    expect(isPrBoundaryTrigger(`printf '%s' 'git push'`)).toBe(false);
    expect(isPrBoundaryTrigger('FOO=git push')).toBe(false);
  });
});

/**
 * REQ-AGENT-040 AC2: a diff that touches ONLY the generated graphify-out/ knowledge graph must
 * classify to zero review lanes so the PR-boundary auto-acknowledges — that checked-in graph is
 * machine-authored and carries no reviewable behavior. A diff that MIXES generated artifacts with
 * real source/sdd/docs is still classified by the non-generated files (the generated ones are
 * skipped, not allowed to suppress a real review).
 */
/**
 * prEditBoundaryBase parses the new base out of a `gh pr edit --base ...` so retargeting an
 * existing PR onto a protected branch arms a review (the create path only fires at creation).
 * It must return the base ONLY for main/master, across the --base / --base= / -B flag forms,
 * and undefined for any other base or a non-base edit.
 */
describe('prEditBoundaryBase (gh pr edit retarget)', () => {
  it('returns the protected base across flag forms', () => {
    expect(prEditBoundaryBase('gh pr edit 286 --base main')).toBe('main');
    expect(prEditBoundaryBase('gh pr edit --base=master')).toBe('master');
    expect(prEditBoundaryBase('gh pr edit 286 -B main')).toBe('main');
  });

  it('returns undefined for a non-main base, a non-base edit, or a non-edit command', () => {
    expect(prEditBoundaryBase('gh pr edit 286 --base develop')).toBeUndefined();
    expect(prEditBoundaryBase('gh pr edit 286 --title x')).toBeUndefined();
    expect(prEditBoundaryBase('gh pr create --base main')).toBeUndefined();
  });

  it('finds the retarget inside a compound command', () => {
    expect(prEditBoundaryBase('cd /repo && gh pr edit 286 --base main')).toBe('main');
  });

  it('extracts the explicit PR selector so retarget review reads that PR, not the current branch', () => {
    expect(prEditCommandTarget('gh pr edit 286 --base main')).toEqual({ prNumber: 286 });
    expect(prEditCommandTarget('gh pr edit feature-branch --base main')).toEqual({ prBranch: 'feature-branch' });
    expect(prEditCommandTarget('gh pr edit https://github.com/o/r/pull/563 --base main')).toEqual({ prNumber: 563 });
    expect(prEditCommandTarget('gh pr edit --repo owner/repo 286 --base main')).toEqual({ repoSlug: 'owner/repo', prNumber: 286 });
    expect(prEditCommandTarget('gh pr edit --base main --title x')).toEqual({});
  });

  it('skips body-file, project, and milestone edit flag values before selecting the explicit PR', () => {
    expect(prEditCommandTarget('gh pr edit --body-file /tmp/body.md --base main')).toEqual({});
    expect(prEditCommandTarget('gh pr edit -F /tmp/body.md 286 --base main')).toEqual({ prNumber: 286 });
    expect(prEditCommandTarget('gh pr edit --add-project Roadmap 286 --base main')).toEqual({ prNumber: 286 });
    expect(prEditCommandTarget('gh pr edit --remove-project Roadmap 286 --base main')).toEqual({ prNumber: 286 });
    expect(prEditCommandTarget('gh pr edit -m Sprint-7 286 --base main')).toEqual({ prNumber: 286 });
  });
});

describe('boundaryFallbackHead', () => {
  it('uses the selected PR head for explicit PR retargets and local HEAD for current-branch boundaries', () => {
    expect(boundaryFallbackHead({ localHead: 'checkout-head', prHead: 'selected-pr-head', preferPrHead: true })).toBe('selected-pr-head');
    expect(boundaryFallbackHead({ localHead: 'checkout-head', prHead: 'current-pr-head', preferPrHead: false })).toBe('checkout-head');
    expect(boundaryFallbackHead({ localHead: 'checkout-head', preferPrHead: true })).toBe('checkout-head');
  });
});

describe('prBoundaryCommandBase', () => {
  it('synthesizes a protected base for create and edit boundary commands', () => {
    expect(prBoundaryCommandBase('gh pr create --base main')).toBe('main');
    expect(prBoundaryCommandBase('gh pr edit 286 --base main', 'develop')).toBe('main');
  });

  it('does not let stale known metadata turn a non-protected edit into a boundary', () => {
    expect(prBoundaryCommandBase('gh pr edit 286 --base develop', 'main')).toBeUndefined();
  });
});

describe('classifyReviewFiles generated-artifact handling', () => {
  it('classifies a graphify-out-only diff to zero lanes (auto-ack)', () => {
    expect(classifyReviewFiles(['graphify-out/graph.json'])).toEqual([]);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'graphify-out/memory/q1.md'])).toEqual([]);
  });

  it('still classifies the non-generated files when a diff mixes them with graphify-out', () => {
    expect(classifyReviewFiles(['graphify-out/graph.json', 'src/lib/access.ts'])).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'sdd/spec/agents.md'])).toEqual(['spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'documentation/lanes/architecture.md'])).toEqual(['doc-updater']);
  });

  it('preserves the undefined (unknowable diff -> full review) and empty (no change -> ack) contracts', () => {
    expect(classifyReviewFiles(undefined)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles([])).toEqual([]);
  });
});

describe('isGeneratedArtifactPath / isGeneratedOnlyDiff', () => {
  it('matches only the top-level graphify-out/ generated tree', () => {
    expect(isGeneratedArtifactPath('graphify-out/graph.json')).toBe(true);
    expect(isGeneratedArtifactPath('graphify-out/memory/q.md')).toBe(true);
    expect(isGeneratedArtifactPath('src/graphify-out/x')).toBe(false);
    expect(isGeneratedArtifactPath('src/lib/access.ts')).toBe(false);
  });

  it('isGeneratedOnlyDiff is true only for a non-empty, all-generated diff', () => {
    expect(isGeneratedOnlyDiff(['graphify-out/graph.json'])).toBe(true);
    expect(isGeneratedOnlyDiff(['graphify-out/graph.json', 'src/b.ts'])).toBe(false);
    expect(isGeneratedOnlyDiff([])).toBe(false);
    expect(isGeneratedOnlyDiff(undefined)).toBe(false);
  });
});

/**
 * REQ-AGENT-058 AC5: the PR-URL fallback recovers a missed `gh pr create` boundary by spotting
 * the PR URL the command printed even when the command text itself was not parsed as a boundary.
 */
describe('prUrlFromText', () => {
  it('extracts the first GitHub PR URL from tool output', () => {
    expect(prUrlFromText('Creating pull request for feature into main\nhttps://github.com/owner/repo/pull/512\n')).toBe('https://github.com/owner/repo/pull/512');
  });

  it('returns undefined for output without a PR URL', () => {
    expect(prUrlFromText('https://github.com/owner/repo/issues/3')).toBeUndefined();
    expect(prUrlFromText('no url here')).toBeUndefined();
    expect(prUrlFromText(undefined)).toBeUndefined();
  });
});

/**
 * enforcedHeadDecision is the pure decision behind resolveEnforcedHead (REQ-AGENT-058 AC3).
 * The load-bearing safety property is that an UNPUSHED local commit (descends from the reported
 * head but localPushed=false) must NOT be enforced — otherwise passive reconciliation arms a
 * review for a commit the PR never had. These fail if that gate, or the metadata-lag tolerance
 * it guards, regresses.
 */
describe('enforcedHeadDecision (REQ-AGENT-058 AC3)', () => {
  const lagging = {
    prHead: 'aaaaaaa',
    local: 'bbbbbbb',
    onPrBranch: true,
    localDescendsFromPrHead: true,
    localPushed: true,
  };

  it('enforces the pushed local head when gh metadata still lags behind the push', () => {
    expect(enforcedHeadDecision(lagging)).toBe('local');
  });

  it('does NOT enforce an unpushed local WIP commit — falls back to the reported PR head', () => {
    expect(enforcedHeadDecision({ ...lagging, localPushed: false })).toBe('prHead');
  });

  it('does NOT enforce a local head on a different branch even if pushed and descending', () => {
    expect(enforcedHeadDecision({ ...lagging, onPrBranch: false })).toBe('prHead');
  });

  it('does NOT enforce a local head that does not descend from the reported head (diverged)', () => {
    expect(enforcedHeadDecision({ ...lagging, localDescendsFromPrHead: false })).toBe('prHead');
  });

  it('trusts the reported PR head when it equals local HEAD', () => {
    expect(enforcedHeadDecision({ ...lagging, prHead: 'ccccccc', local: 'ccccccc', localDescendsFromPrHead: false })).toBe('prHead');
  });

  it('falls back to local only when there is no reported PR head at all', () => {
    expect(enforcedHeadDecision({ ...lagging, prHead: '', localDescendsFromPrHead: false })).toBe('local');
  });

  it('trusts the reported PR head when there is no local checkout', () => {
    expect(enforcedHeadDecision({ ...lagging, local: '', localDescendsFromPrHead: false, localPushed: false })).toBe('prHead');
  });
});

/**
 * prEnforcedForPush is the push-path-only enforcement gate (REQ-AGENT-036 AC1). The load-bearing
 * property is the fail-open on an empty/absent baseRefName (a transient gh/jq parse edge must
 * over-review, never silently skip a PR-to-main) WITHOUT widening to a genuinely non-protected
 * base. Gut the `|| !pr.baseRefName` and the empty/absent cases fail; widen to any base and the
 * develop case fails; drop the OPEN/headRefOid guards and those cases fail.
 */
describe('prEnforcedForPush (push-path fail-open enforcement gate)', () => {
  it('enforces an OPEN PR with a head OID targeting main or master', () => {
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'OPEN', baseRefName: 'main' })).toBe(true);
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'OPEN', baseRefName: 'master' })).toBe(true);
  });

  it('fails OPEN when baseRefName is empty or absent (transient gh/jq parse edge)', () => {
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'OPEN', baseRefName: '' })).toBe(true);
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'OPEN' })).toBe(true);
  });

  it('does NOT enforce a non-protected base, a non-OPEN PR, or a PR with no head OID', () => {
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'OPEN', baseRefName: 'develop' })).toBe(false);
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'MERGED', baseRefName: 'main' })).toBe(false);
    expect(prEnforcedForPush({ headRefOid: 'a1b2c3d', state: 'CLOSED', baseRefName: 'main' })).toBe(false);
    expect(prEnforcedForPush({ state: 'OPEN', baseRefName: 'main' })).toBe(false);
    expect(prEnforcedForPush(undefined)).toBe(false);
  });
});
