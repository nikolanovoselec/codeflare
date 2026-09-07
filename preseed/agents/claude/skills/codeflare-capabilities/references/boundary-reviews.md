# PR reviews, CI, release, and production evidence

## What I do

I carry protected pull requests through exact-head review, CI, joint triage, accepted fixes, and approved release evidence instead of collecting opinions from different commits.

For an eligible protected pull request, I follow the review boundary and launch only when its workflow or your explicit review-launch instruction authorizes it. The boundary classifies the changed scope so I start the smallest required set of report-only code, specification, and documentation review lanes together, then start independent exact-head GitHub Actions monitoring. When every required lane settles, I publish one joint triage table before touching the repository. I verify each finding, judge the diagnosis separately from the proposed fix, reject unsupported cleanup, and apply only the smallest accepted corrections.

A replacement commit starts a new boundary for the changed range. I do not treat yesterday's green CI as evidence for today's head. Once the final head is clean, I prepare the merge message, follow post-merge checks, monitor an approved deployment, and verify release identity, commit, workflow outcome, and rollback evidence.

## What you get back

I give you a decision-ready account of the pull request: which findings are real, which proposed fixes are too broad, and what the exact commit's CI actually proved. You can ask me to stop after triage if you want to make the fix decisions yourself. I keep the evidence attached to the commit so you do not have to reconstruct which green check belonged to which version.

When you authorize a release, I follow its workflow and report the deployed commit and release identity. If the workflow fails or evidence is missing, I say so. A deployment link on its own is not a successful release.

## Where the boundary sits

Reviewers report. The root agent mutates. CI proves automated contracts. GitHub owns protected history. That division is deliberately boring because the exciting alternative is two agents racing to repair the same file while a third reviews neither result.

Deployment verification starts with workflow and release evidence. Opening a live application, authenticating, sending email, or exercising production behavior requires an explicit live-test instruction. The word “verify” is not a blank cheque.

## Try it

Ask me:

> Review PR #123 against code, specification, documentation, and exact-head CI. Publish triage before changing anything, then apply only accepted fixes after review closes.

Other useful requests:

- “Open review for this PR, launch code/spec/doc lanes once, then wait for exact-head CI.”
- “Triage these reviewer findings and reject anything unsupported or oversized.”
- “Apply only accepted fixes from the previous triage turn.”
