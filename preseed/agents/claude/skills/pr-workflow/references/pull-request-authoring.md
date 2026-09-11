# Pull Request Authoring Reference

Use this reference for every PR creation or material title/body rewrite, regardless of either branch.

A PR is a review brief and a durable history index. Preserve navigation, not narration. Link established detail, explain why it matters, and do not replay another PR, the diff, CI logs, or the specification.

## Budgets

- Ordinary PR target: at most 5,000 characters.
- Promotion PR target: at most 8,000 characters.
- Exceed 8,000 only when several independently shipped capabilities or acceptance scenarios cannot be linked elsewhere. State why.
- Summary: at most 150 words.
- Traceability table: normally eight rows or fewer.
- One to three short paragraphs per shipped capability.
- Boundaries: normally eight bullets or fewer.
- Review record: normally three bullets or fewer.

## Prepare

Inspect the complete merge range, not the latest commit:

```bash
git log --no-merges <base>..HEAD
git diff --stat <base>...HEAD
git diff --name-status <base>...HEAD
```

Inspect recent comparable repository PRs. For a promotion, inspect earlier promotions between the same branches. Repository history outranks generic style.

Collect only useful relationships: motivating issues, incorporated PRs, requirements, decisions, exact reviewed commits, CI, releases, deployments, acceptance evidence, and linked follow-up work. Verify every claim and URL.

## Canonical shape

Use these sections in order. Scale their depth, not their presence.

### `## Summary`

State the purpose, resulting behavior, and why the change belongs together. Lead with features and improvements.

When exact identity matters, add one facts table with applicable rows:

```markdown
| Fact | Value |
|---|---|
| Base | `<branch>` @ `<full SHA>` |
| Head | `<branch>` @ `<full SHA>` |
| Tree delta | `<files> files, +<adds> / -<deletes>` |
| Exact-head CI | [`<run>`](<url>), `<state>` |
| Release or deployment | [`<identity>`](<url>), `<state>` |
| Production | `<state>` |
```

Mark future evidence `Pending`. Do not repeat these values elsewhere unless context requires it.

### `## What ships`

Group observable features under descriptive `###` headings. Explain what changes, the boundary that matters, and what remains intact.

Do not narrate files or commits. A promotion summarizes each incorporated capability and links its feature PR for implementation detail. Secondary fixes belong in `Additional corrections`, near the bottom.

### `## Links and traceability`

Use one compact table:

```markdown
| Relationship | Reference | Why it matters |
|---|---|---|
| Tracks | #123 | Original problem |
| Promotes | #456 | Reviewed feature included here |
| Requirement | [REQ-AREA-001](<anchor>) | Defines changed behavior |
| Decision | [AD12](<anchor>) | Records the tradeoff |
| Release | [`seed-v12`](<url>) | Publishes matching content |
| Follow-up | #789 | Explicitly deferred work |
```

Every link needs a relationship and a reason. Group related requirements. Never publish a standalone requirement, commit, file, or check catalog.

Use `#123` within the repository and `OWNER/REPOSITORY#123` across repositories. GitHub creates backlinks from these references. Use `Closes`, `Fixes`, or `Resolves` only when targeting the default branch and the merge should close the issue. GitHub ignores closing keywords on other base branches; use `Tracks` or `Related` there.

Use full SHAs for exact identity. Link incorporated PRs, CI runs, releases, deployments, decisions, and issues rather than retelling them.

### `## Verification`

Record exact outcomes and links. Separate automated, deployed/manual, and managed-publication evidence only when all are substantial.

Name the exact head. Distinguish CI, focused local checks, deployments, manual checks, owner reports, and pending work. If a deployment covered an earlier head, say so. Never imply that it tested later bytes.

Link the complete CI run instead of listing every passing job. Keep failed runs only when they changed the design or explain a retained decision.

### `## Boundaries`

State only material non-changes, risks, compatibility limits, migration or rollback behavior, production state, and linked follow-up work. Include screenshots for visual changes and integrity evidence for dependencies when applicable.

### `## Additional corrections`

Use only when secondary fixes travel with a larger change. Keep this below features and boundaries. A fix-only PR describes its main fix under `What ships`.

### `## Completion checklist`

List only real gates. Checked means verified. Keep merge and production authorization separate.

```markdown
- [x] Implementation complete.
- [x] Exact-head review and CI complete.
- [ ] Required acceptance pending.
- [ ] Owner authorizes merge or production action.
```

### `## Review record`

Keep this final. Record only findings that changed behavior, architecture, contracts, or evidence. State the correction and final result. At creation, write `Review pending.` If review was clean, use one sentence.

## Title and lifecycle

Keep the title under 70 characters. Follow the repository convention and name the delivered outcome.

Update the body as evidence arrives. After every head change, replace stale final-head claims. Before merge, reread the full base-to-head range and remove completed TODOs, stale states, duplicated links, and claims not supported by the final tree.

## Writing rules

- Use direct operational prose.
- Mention each run, release, deployment, requirement family, and incorporated PR once.
- Use tables for identity and relationships, not decoration.
- Separate observation, inference, owner report, and pending work.
- Do not use em or en dashes as sentence punctuation.
- Do not claim production deployment without evidence.

## Basis

GitHub recommends a clear purpose, approach, result, reviewer focus, and links to related work. GitHub also documents automatic issue, PR, commit, URL, and backlink behavior, with closing keywords limited to PRs targeting the default branch.

The latest 50 merged Codeflare promotions from `develop` to `main`, reviewed on 8 September 2026, had a median body length of 7,949 characters. Useful recurring evidence included review context in 48, requirement links in 44, checklists in 37, production state in 34, CI links in 32, verification sections in 31, full commit identities in 25, and fact tables in 16. The main recurring waste was repeating feature detail and publishing unexplained catalogs.

Sources:

- [GitHub: Helping others review your changes](https://docs.github.com/en/pull-requests/concepts/helping-others-review-your-changes)
- [GitHub: Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
- [GitHub: Autolinked references and URLs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)
- [Microsoft Engineering Fundamentals: Pull Request Template](https://microsoft.github.io/code-with-engineering-playbook/code-reviews/pull-request-template/)
