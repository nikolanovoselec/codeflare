# Test Discipline

Applies to any project with tests.

**Trigger:**
- Test files in diff → code-reviewer invokes `tdd-enforce`.
- Authoring new tests → tdd-guide invokes `tdd-enforce`.

**Route:** invoke the `tdd-enforce` skill. It carries the 8-antipattern catalogue, positive patterns, severity application, and migration policy.

## What a real test is

> If I delete or break the implementation this test is supposed to cover, will this test fail?

If you can refactor freely, gut the implementation, replace it with a no-op, or rename a public function while the test stays green, the test is theater. After writing a test, run the gut-check: "what would I have to change in production code for this to fail?" If the answer is "rename a string literal", the test is text-matching theater.

## The `enforce_tdd` lever

The only user-controlled lever is `enforce_tdd: true | false` in `sdd/config.yml`.

- `enforce_tdd: true` (default): code-reviewer flags antipatterns at HIGH/MEDIUM; `spec-enforce-truth` auto-demotes Implemented REQs without test coverage.
- `enforce_tdd: false`: findings report to `sdd/.coverage-report.md`, no spec mutation.

`unleashed` mode refuses to run on `enforce_tdd: false`. No per-test opt-out exists by design.

## Migration

Existing antipattern tests are migrated as the surrounding production code changes — not rewritten speculatively. When you touch a file with antipattern tests, fix the tests in the same commit.

Skipping `tdd-enforce` invocation when test files are in scope is itself HIGH `tdd-enforce-skill-not-invoked`.
