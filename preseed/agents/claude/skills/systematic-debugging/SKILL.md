---
name: systematic-debugging
description: Investigate bugs, failures, regressions, and unexpected behavior from evidence before proposing fixes.
license: MIT
---

# Systematic Debugging

Find the root cause before changing production behavior. A plausible symptom fix is still a guess.

## Use this workflow

Use it for bugs, failing CI, regressions, performance problems, integration failures, and unexplained behavior. Use it especially after one attempted fix failed or when urgency makes a quick patch tempting.

## Phase 1: establish facts

1. Read the complete error, stack, status, and surrounding logs. Record exact paths, lines, codes, timestamps, and affected identities.
2. State the observable failure separately from any theory about its cause.
3. Reproduce it consistently. If reproduction is intermittent, gather more evidence instead of treating one successful retry as a fix.
4. Inspect the smallest relevant diff, recent deployment, dependency, configuration, or environment change.
5. Trace the bad value or state backward through callers until reaching the earliest point where it becomes wrong. Fix that source, not the final crash site.

For a multi-component path, inspect each boundary once:

```text
input -> component -> output
```

At every boundary, verify the actual value, configuration propagation, identity, and result. Do not print secrets. Log presence, type, digest, length, or a redacted identifier instead. One evidence-gathering run should identify the first boundary where expected and actual behavior diverge.

## Phase 2: compare the working pattern

Find the nearest working implementation in the same repository or authoritative reference. Read it completely, then list meaningful differences in inputs, ownership, ordering, state, dependencies, configuration, and environment. Do not dismiss a difference before proving it irrelevant.

Check assumptions explicitly:

- Who owns the state?
- Which boundary validates it?
- What ordering or lifecycle does the code require?
- Which runtime, package, schema, permission, or environment does it expect?
- Does the failing path bypass a step used by the working path?

## Phase 3: test one hypothesis

Write one sentence:

```text
I think <cause> produces <failure> because <evidence>.
```

Choose the smallest observation or change that can falsify it. Change one causal variable at a time. If the evidence rejects the hypothesis, remove the experiment and form a new one. Do not stack speculative fixes.

When timing is suspected, wait for the required condition with a bounded deadline. Do not replace an arbitrary delay with a larger arbitrary delay. A correct wait checks the observable condition, reports timeout context, and cleans up resources.

## Phase 4: implement and verify

1. Add the smallest failing behavioral test first. It must exercise the observable contract and fail if the implementation is removed or broken.
2. Respect repository verification policy. In Codeflare, builds and tests run in CI; only the managed `safe-local-checks` wrapper may provide supplemental local syntax or lint feedback.
3. Implement one minimal root-cause fix. Avoid unrelated cleanup and speculative fallback states.
4. Require authoritative tests and CI to pass, then reproduce the original failure path and confirm the intended outcome.
5. Add validation at additional layers only when each layer owns a distinct trust boundary. Redundant checks without different ownership are noise.
6. Do not claim completion while required evidence is failing, missing, stale, or tied to another head.

## Stop conditions

Return to Phase 1 when you notice any of these:

- proposing a fix before identifying where state first becomes wrong;
- changing several variables before observing the result;
- relying on a retry or longer sleep as proof;
- explaining an error without reproducing or tracing it;
- writing a test that matches source text or UI copy instead of behavior;
- assuming configuration, permissions, or dependencies propagated correctly;
- preserving an experiment after its hypothesis failed.

After three failed fix attempts, stop patching. Reassess ownership, coupling, and architecture with the user before attempting another change. Repeated failures in different places usually mean the model of the system is wrong, not that a fourth patch is overdue.

## Completion evidence

A debugging task is complete only when the report identifies:

- the observed failure;
- the root cause and evidence chain;
- the minimal fix;
- the behavioral regression test;
- authoritative verification results;
- any remaining bounded risk.
