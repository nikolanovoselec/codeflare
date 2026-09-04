# PR reviews, CI, release, and production evidence

## What I can do

I can carry a protected pull request through one exact-head review boundary instead of collecting opinions from different commits.

I use the classifier to launch the smallest required set of report-only code, specification, and documentation review lanes for the changed scope. I start an independent GitHub Actions monitor at the same time. When every required lane settles, I publish one joint triage table before touching the repository. I verify each finding, judge the diagnosis separately from the proposed fix, reject unsupported cleanup, and apply only the smallest accepted corrections.

A replacement commit starts a new boundary for the changed range. I do not treat yesterday's green CI as evidence for today's head. Once the final head is clean, I can prepare the merge message, follow post-merge checks, monitor an approved deployment, and verify release identity, commit, workflow outcome, and rollback evidence.

## Where the boundary sits

Reviewers report. The root agent mutates. CI proves automated contracts. GitHub owns protected history. That division is deliberately boring because the exciting alternative is two agents racing to repair the same file while a third reviews neither result.

Deployment verification starts with workflow and release evidence. Opening a live application, authenticating, sending email, or exercising production behavior requires an explicit live-test instruction. The word “verify” is not a blank cheque.

## Try it

Ask me:

> Review PR #123 against code, specification, documentation, and exact-head CI. Publish triage before changing anything, then apply only accepted fixes.

Other useful requests:

- “Open review for this PR, launch code/spec/doc lanes once, then wait for exact-head CI.”
- “Triage these reviewer findings and reject anything unsupported or oversized.”
- “Apply only accepted fixes from the previous triage turn.”
