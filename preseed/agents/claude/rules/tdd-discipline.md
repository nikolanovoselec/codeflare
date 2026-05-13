# Test Discipline (Core)

Applies to any project with tests. Defines what counts as a real test. The 8-antipattern catalogue, positive patterns, severity table, and migration policy live in the `tdd-enforce` skill.

Siblings: `spec-discipline.md` (spec-reviewer), `documentation-discipline.md` (doc-updater). Together they define what real-world artifacts look like for spec, docs, and tests.

## What a real test is

Every test must answer YES to:

> If I delete or break the implementation this test is supposed to cover, will this test fail?

If you can refactor freely, gut the implementation, replace it with a no-op, or rename a public function while the test stays green, the test is theater. Theater tests look reassuring on the dashboard but catch zero regressions.

When you finish writing a test, mentally run the gut-check: "what would I have to change in production code for this to fail?" If the answer is "delete the file" or "rename a string literal in a doc", the test is text-matching theater and must be replaced.

## Severity classification

| Severity | Definition |
|---|---|
| **HIGH** | Real coverage gap: text-matching theater, tautology, missing assertions |
| **MEDIUM** | Test-quality smell, weaker coverage: bare call-counts, silent skips, name-lies, mock-only theater |

Full antipattern-to-severity mapping lives in `tdd-enforce`. Mode-dependent action mirrors `spec-discipline.md`'s mode table (interactive confirms; auto fixes CRITICAL+HIGH+MEDIUM, defers LOW; unleashed fixes everything).

## The `enforce_tdd` lever

The only user-controlled lever is `enforce_tdd: true | false` in `sdd/config.yml`.

- `enforce_tdd: true` (default): code-reviewer flags antipatterns at HIGH/MEDIUM; `spec-enforce-truth` auto-demotes Implemented REQs without test coverage.
- `enforce_tdd: false`: both report findings to `sdd/.coverage-report.md` without modifying the spec. Project-level opt-out only, for domains that genuinely don't admit automated testing (pure visual design systems, etc.).

**No per-test opt-out.** Inline comment shortcuts like `// tdd-allow:` are explicitly NOT supported, by design. Per-test opt-outs are agent-writable bypasses; they degrade into "every test the agent doesn't want to fix" markers and defeat the rule. If a test legitimately can't fit the discipline, delete it; the absence of a useless test is more honest than a flagged-and-allowed one.

`unleashed` mode refuses to run on `enforce_tdd: false` (no silent override).

## Enforcement skill

The 8-antipattern catalogue (text-matching theater, tautology, mock-only, call-count, empty body, silent skip, trivial assertion, name-lies), positive patterns (run the real thing, fixture-driven, contract not implementation, one bug-class per test), severity application table, enforce_tdd interaction details, and migration policy all live in `tdd-enforce`.

| Skill | Contents | When invoked |
|---|---|---|
| `tdd-enforce` | 8 antipatterns with BAD/GOOD examples; positive patterns; severity application; migration policy | code-reviewer when test files in diff; tdd-guide before authoring new tests |

### Binding invocation rules

- **code-reviewer**: invoke `tdd-enforce` as a first action when any test file appears in the diff.
- **tdd-guide**: invoke `tdd-enforce` before authoring new tests.

Skipping invocation when test files are in scope is itself a HIGH finding `tdd-enforce-skill-not-invoked`.

## Migration policy (summary)

Existing tests that predate this rule are migrated as the surrounding production code changes, not rewritten speculatively. When you touch a file with antipattern tests, fix the tests in the same commit.

Full migration detail in `tdd-enforce`.
