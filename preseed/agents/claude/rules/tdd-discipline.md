# Test Discipline

Applies to any project with tests.

**Trigger:**
- Test files in diff → code-reviewer invokes `tdd-enforce`.
- Authoring new tests → tdd-guide invokes `tdd-enforce`.

**Route:** invoke the `tdd-enforce` skill. Carries the 8-antipattern catalogue, positive patterns, severity application, migration policy, and `enforce_tdd` lever semantics.

## Gut-check (mid-task keepsake)

> If I delete or break the implementation this test is supposed to cover, will this test fail?

If you can gut the implementation, rename a function, or replace it with a no-op while the test stays green, the test is theater. Full antipattern catalogue lives in `tdd-enforce` § "Antipatterns".

Skipping `tdd-enforce` invocation when test files are in scope is itself HIGH `tdd-enforce-skill-not-invoked`.
