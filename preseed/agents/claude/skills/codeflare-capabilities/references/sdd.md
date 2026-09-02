# Spec-driven development

**Availability:** Advanced sessions. Existing repositories may already carry the SDD contract even when the current session cannot initialize a new one.

## What I can do

I can turn an objective into a requirements system that stays connected to code and evidence. I record intent, acceptance criteria, constraints, priority, dependencies, implementation anchors, test anchors, and status. That gives me a contract to work against instead of prose I can reinterpret after the implementation has already drifted.

I can use `/sdd init` to derive a reviewable baseline for a new, legacy, or partially specified repository. For ongoing work, I can find the requirement that owns the behavior, update that contract before changing production code, write a failing behavioral test first when one is justified, make the smallest correction, and keep every touched anchor truthful. I do not leave touched requirements `Partial` while claiming the job is complete.

I can also reconcile drift. `/sdd clean` is for a repository where specification and implementation no longer describe the same system. It is not permission to rewrite requirements until a broken implementation looks compliant.

## Why the boundary matters

Tests must exercise observable behavior or contract values. A test that searches source text, freezes a prompt sentence, or checks for a preferred heading is not evidence that the product works. Subjective design, managed prose, and judgment-heavy presentation stay reviewable by people instead of being nailed to the repository through brittle copy assertions.

## Try it

Ask me:

> Trace this change to its owning requirement. Show which acceptance criterion fails today, write the behavioral test, then implement only that correction.

For an uninitialized repository in an Advanced session, run `/sdd init`, inspect the proposed requirements before implementation, and challenge any criterion that does not describe observable behavior.

Source anchors: `sdd/README.md`, `sdd/spec/agents.md` REQ-AGENT-021/033/034/045, and `documentation/lanes/preseed.md#sdd-bootstrap-contract`.
