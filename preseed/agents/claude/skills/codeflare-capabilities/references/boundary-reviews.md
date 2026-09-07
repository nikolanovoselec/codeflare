# PR reviews, CI, release, and production evidence

A pull request can have green checks, several reviewer reports, and no clear answer to a basic question: did they all examine the version you are about to ship?

I keep review, automated evidence, corrections, and authorized delivery attached to the actual revision. You do not have to coordinate a conversation between every reviewer, CI job, agent, and deployment workflow to reconstruct that answer.

## Independent questions about the same change

Code review examines behavior and implementation. Specification review checks whether the contract and its implementation references remain true. Documentation review checks the guidance somebody will use to understand or operate the result. CI executes the automated contracts. These are different kinds of evidence; agreement from three reviewers does not replace a missing test result.

For an eligible protected pull request, I identify the applicable review lanes from the changed scope. I launch them only when the workflow or your explicit review instruction authorizes it. Report-only reviewers start together, and independent monitoring follows CI for the exact head.

The scope matters. A documentation change should not manufacture a system-wide redesign exercise. A source change can also invalidate a requirement or an operating instruction, so I account for those directly affected surfaces rather than looking only at filenames.

## Findings are proposals, not marching orders

When all required results have arrived, I publish joint triage before changing the reviewed work. I check the evidence behind each finding and judge the diagnosis separately from its suggested correction.

That distinction saves real work. A genuine bug may need a narrow guard rather than a new abstraction. Two reports may describe the same defect. A proposed cleanup may be unrelated. I retain the useful diagnosis, reject unsupported expansion, and choose the smallest accepted correction.

Reviewers report; the root agent owns mutations. I do not let several agents race to fix the same files while another reviewer is still examining an earlier version. You can ask me to stop after triage and leave the decisions with you.

## A replacement commit needs its own evidence

Once accepted fixes change the head, the earlier results remain evidence for the earlier head. I follow the applicable boundary for the replacement revision instead of carrying a green badge forward by assumption.

The workflow keeps reviewer results, CI identity, and completion ownership correlated. Interrupted work does not quietly become a completed review. A current-head acknowledgment is also distinguishable from an independently executed reviewer round; I report what actually happened.

Automatic PR boundaries apply to eligible SDD repositories and protected targets. They do not mean every repository action triggers every reviewer. Explicit broader review is a separate request. Your existing CI, branch protections, and repository rules remain in place.

## Follow an approved release beyond the push

When you authorize delivery, I carry the repository's workflow through the next stage: merge preparation where requested, post-merge checks, deployment monitoring, and release evidence. I identify the source revision, workflow outcome, and deployed release or Worker identity. Where the pipeline provides image digests and provenance, I keep those distinct from a fresh build or an independently checked live image.

A workflow failure, missing receipt, or superseded head is something to resolve—not an inconvenient detail to omit from the handoff. I also preserve the relevant rollback or recovery information rather than treating deployment as the end of operational responsibility.

Opening the live application is a separate step. Deployment evidence does not authorize login, email, purchases, production mutations, or browser testing. I perform those only within an explicit live-test scope.

What you get back is a decision about a known revision, with the evidence and remaining decisions attached. Not a pile of opinions that you have to reconcile yourself.
