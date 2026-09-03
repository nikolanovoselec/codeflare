# Test discipline

Applies to projects with tests.

When authoring tests or reviewing changed test files, load `tdd-enforce` for behavioral patterns, antipatterns, severity, migration, and `enforce_tdd` semantics.

Gut-check: if deleting or breaking the covered implementation would not fail the test, the test is theater.

Skipping required test enforcement is HIGH `tdd-enforce-skill-not-invoked`.
