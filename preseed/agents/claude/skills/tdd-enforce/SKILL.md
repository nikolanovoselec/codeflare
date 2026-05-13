---
name: tdd-enforce
description: Test discipline enforcement. Holds the 8 antipattern catalogue (text-matching theater, tautology, mock-only, call-count, empty body, silent skip, trivial assertion, name-lies), the patterns that produce useful tests, the severity application table, and the migration policy. Invoked by code-reviewer when test files are touched in a diff and by tdd-guide when authoring new tests.
version: 1.0.0
---

# Test Discipline Enforcement

The core rule `tdd-discipline.md` states what a real test is. This skill carries the antipattern catalogue, the positive patterns, the severity table, and the migration policy. Invoked by code-reviewer on diffs that touch any test file and by tdd-guide before authoring new tests.

## Inputs

- `diff`: git diff against base (test files only)
- `scope`: `all` | `diff`
- `enforce_tdd`: from `sdd/config.yml`

## Output

Returns findings array with severity HIGH or MEDIUM per the table below. No auto-fix proposals (tests are rewritten by tdd-guide, not auto-fixed by the reviewer).

## Antipatterns (drawn from this codebase)

### 1. Text-matching theater

A test reads a file (markdown, source, config, prompt) and regex-matches against its contents. The "system under test" is the file's prose, not behavior. Found across `host/__tests__/sdd-workflow-upgrade.test.js` (removed in 2026-05), `host/__tests__/memory-capture-hook.test.js`, `host/__tests__/container-memory.test.js`, `host/__tests__/entrypoint-sync.test.js`, `web-ui/src/__tests__/page-transparency.test.ts`.

```js
// BAD: reads a file, asserts a substring is present
const content = readFileSync(path, 'utf-8');
assert.match(content, /forbidden|banned/i, 'should define forbidden list');

// BAD: same shape with includes()
assert.ok(hookScript.includes('jq'), 'hook should reference jq');

// BAD: same shape on CSS
const cssContent = readFileSync(cssPath, 'utf-8');
expect(parseFloat(cssContent.match(/alpha:\s*([\d.]+)/)[1])).toBe(0.9);
```

These pass if someone types the right string anywhere in the file. They pass if the rest of the file is gibberish. They fail only if the file is deleted or someone renames "forbidden" to "prohibited" in prose. Implementation can be entirely broken; test stays green.

```js
// GOOD: run the actual code with input, assert on output
import { spawnSync } from 'node:child_process';
const result = spawnSync('bash', [HOOK_PATH], {
  input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: fixture }),
  encoding: 'utf-8',
});
expect(result.status).toBe(0);
expect(result.stdout).toContain('"decision":"block"');
expect(result.stdout).toContain('code-reviewer');  // names the missing agent
```

Now the test fails if the hook's exit code, stdout shape, or agent-naming logic regresses, not if someone reformats prose.

### 2. Tautology

An assertion whose truth is given by the test setup itself. Cannot fail. Found in `src/__tests__/lib/agent-seed-manifest.test.ts` and `src/__tests__/lib/agent-seed-ecc-rules.test.ts`.

```js
// BAD: doc.modes is destructured from a literal fixture array
expect(doc.key.length).toBeGreaterThan(0);
expect(Array.isArray(doc.modes)).toBe(true);

// BAD: two hardcoded constants compared
expect(commonRules.length).toBe(ECC_FILES_PER_SUBDIR.common);
// hardcoded {common:3} - if production drifts to 4, this test
// passes if-and-only-if someone manually updates the constant.
// The check has no anchor to ground truth.
```

```js
// GOOD: derive expectation from a source of truth outside the test
import { readdirSync } from 'node:fs';
const filesOnDisk = readdirSync('preseed/agents/claude/rules/common')
  .filter((f) => f.endsWith('.md'));
expect(commonRules.map((r) => basename(r.key))).toEqual(filesOnDisk);
```

Now the test fails if files are added/removed without updating the generator, which is the regression we care about.

### 3. Mock-only theater

Test mocks function X to return value V, calls X, asserts the result is V. The mock IS the system under test. Found in `src/__tests__/routes/storage-stats.test.ts`, `src/__tests__/routes/container-lifecycle-helpers.test.ts`.

```js
// BAD: mock returns paginated data, test asserts the mock was called
mockParseListObjectsXml
  .mockReturnValueOnce({ objects: [...3 items...], isTruncated: true })
  .mockReturnValueOnce({ objects: [...2 items...], isTruncated: false });
await routeHandler(request);
expect(mockFetch).toHaveBeenCalledTimes(2);
// confirms code obeyed the mock; the pagination logic being "tested"
// lives inside the mock setup. If parseListObjectsXml has a real bug,
// this test does not catch it.
```

```js
// GOOD: only mock external dependencies (R2 fetch endpoint), exercise
// your own pagination logic against canned-but-realistic responses
mockFetch
  .mockResolvedValueOnce(realR2XmlPage1())
  .mockResolvedValueOnce(realR2XmlPage2());
const result = await listObjectsAcrossPages(...);
expect(result.objects).toHaveLength(realPage1.length + realPage2.length);
expect(result.objects[0].key).toBe(realPage1[0].Key);
expect(result.isTruncated).toBe(false);  // last page
```

The rule: **only mock what's outside YOUR code** (third-party APIs, network, the platform). Don't mock your own helpers, exercise them.

### 4. Implementation-coupled call counts

`expect(spy).toHaveBeenCalledTimes(N)` without a paired assertion on observable output. Refactor-fragile, regression-blind. Found in `src/__tests__/routes/storage-download.test.ts`, `src/__tests__/routes/container-lifecycle-helpers.test.ts`.

```js
// BAD: only asserts an internal helper was called
expect(mockSign).toHaveBeenCalledTimes(1);
// Refactor to memoize -> test fails despite identical behavior.
// Break signing entirely so URL is invalid but mockSign still
// gets called once -> test passes despite broken behavior.
```

```js
// GOOD: assert on observable output. The signed URL itself.
const response = await routeHandler(req);
const signedUrl = await response.text();
expect(signedUrl).toMatch(/^https:\/\/.+\?X-Amz-Signature=/);
expect(verifySignedUrl(signedUrl, secret)).toBe(true);
```

If you genuinely care about call count (an expensive operation that must not be repeated), pair it with an output assertion AND comment why the count matters as a contract.

### 5. Empty body / missing assertions

Tests with no `expect`/`assert` call. The code runs, but nothing is checked. Linter usually catches these; sometimes they slip in via `it('does X', () => { someCode(); /* assertion forgotten */ })`.

```js
// BAD: no assertion
it('handles edge case', async () => {
  const result = await processInput(edgeCase);
  // ... and nothing
});

// GOOD: every it/test must produce at least one assertion
it('handles edge case', async () => {
  const result = await processInput(edgeCase);
  expect(result.status).toBe('skipped');
  expect(result.reason).toBe('input out of supported range');
});
```

### 6. Skipped tests without justification

`it.skip(...)`, `xit(...)`, `describe.skip(...)` without an inline comment naming the blocker (issue link, upstream bug, environment limitation). Skipped tests rot, without a removal trigger they stay skipped forever and the coverage they were supposed to provide is silently lost.

```js
// BAD: silent skip
it.skip('rejects expired tokens', () => { ... });

// GOOD: skip with explicit removal trigger
it.skip(
  'rejects expired tokens',
  // Skipped pending vitest-pool-workers#412: Date mocking broken in
  // worker pool. Remove .skip when the upstream fix lands.
  () => { ... }
);
```

### 7. Trivial assertions on trivial values

`expect(Array.isArray([1,2,3])).toBe(true)`, `expect(typeof 'foo').toBe('string')` - the truth is given by the literal. The assertion adds nothing.

```js
// BAD: doc.modes is ['advanced'] from the fixture literal
expect(Array.isArray(doc.modes)).toBe(true);

// GOOD: assert types/shapes only on values from outside the test
const response = await routeHandler(req);
const body = await response.json();
expect(Array.isArray(body.users)).toBe(true);  // body came from a real handler
expect(body.users[0]).toHaveProperty('id');
```

### 8. Test name lies about what's asserted

A test whose name claims behavior X but whose assertions check unrelated Y. The test runs, the assertions pass, the dashboard turns green, but the named behavior is never exercised. The most insidious antipattern because every prior check (the test has a name, it has an assertion, the assertion can fail) is satisfied.

```js
// BAD: name says "rejects expired JWT", assertion checks string length
it('rejects expired JWT', async () => {
  const result = await validateToken(expiredJwt);
  expect(result.length).toBeGreaterThan(0);  // wat
});

// BAD: name says "returns 403 for unauthorized user", assertion checks the mock
it('returns 403 for unauthorized user', async () => {
  await routeHandler(unauthorizedReq);
  expect(mockAuth).toHaveBeenCalled();  // does not check the 403
});

// GOOD: assertion matches the named behavior
it('rejects expired JWT', async () => {
  const result = await validateToken(expiredJwt);
  expect(result.valid).toBe(false);
  expect(result.reason).toBe('expired');
});

it('returns 403 for unauthorized user', async () => {
  const response = await routeHandler(unauthorizedReq);
  expect(response.status).toBe(403);
});
```

Detection: the reviewer reads the test name as a one-sentence behavioral contract, then reads the assertions, and asks: "if this implementation is correct and the named behavior is broken (say `validateToken` returns `{ valid: true }` for an expired JWT), does at least one assertion in this test fail?" If the answer is no, the test name lies.

This subsumes a narrower case the other antipatterns miss: a test named `it('REQ-AUTH-001: rejects expired token', ...)` that satisfies the literal REQ-ID-in-test-name rule from spec-discipline but doesn't actually verify the AC. Pairs with `spec-enforce-truth` CQ-1 (REQ-test truth-check) - same gap, two sides.

## Patterns that produce useful tests

### Run the real thing

For shell scripts and hooks: spawn the script with stdin/argv/env, assert exit code + stdout/stderr. Shape used in `host/__tests__/enforce-review-spawn.test.js` and `host/__tests__/git-push-review-reminder.test.js` is the canonical example - those tests caught real bugs (PUSH_TS empty-string fail-open, PUSH_LINE substring false-positives) that text-matching tests did not.

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = mkdtempSync(join(tmpdir(), 'hook-test-'));
mkdirSync(join(cwd, 'sdd'));
writeFileSync(join(cwd, 'sdd/README.md'), '# fixture');

const result = spawnSync('bash', [HOOK_PATH], {
  cwd,
  input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: t }),
  encoding: 'utf-8',
  env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
});

expect(result.status).toBe(0);
expect(result.stdout).toContain('"decision":"block"');
```

### Fixture-driven, not literal-driven

Build fixtures in files (or tmp dirs) that mirror real production data. Read from disk; derive expectations from the same source of truth the production code consults. If the test computes `expected = literal` and compares against a value derived from `literal`, you have tautology.

### Test the contract, not the implementation

For routes: send a real Request, get a real Response, assert on status/headers/body. Don't assert on which internal helper was called.

For libraries: call the public function with real input, assert on the return value or its observable side effect. Don't spy on private internals.

For agents/prompts: extract the testable kernels (helper functions, parsers, formatters) into normal modules and test those. The prompt itself is human/LLM contract - exercise it via end-to-end runs in integration tests, not by regex-matching the prompt text.

### One bug-class per test

Each test should answer: "what specific bug would this catch?" If the answer is vague ("any general regression") or absent, split or rewrite. The test name should make the bug-class explicit: `rejects expired JWT`, `recovers from R2 503 with retry`, `aborts on transcript with no push line`.

## Severity application

`code-reviewer` flags (severity aligned with `tdd-discipline.md` core):

**HIGH** (real coverage gap):
- Tests that read file content + regex/substring match against it (antipattern 1)
- Assertions whose values are destructured from local literal fixtures (antipattern 2)
- Test bodies with no `expect`/`assert` call (antipattern 5)

**MEDIUM** (test-quality smell, weaker coverage):
- `expect(spy).toHaveBeenCalledTimes(N)` without paired output assertion (antipattern 4)
- `it.skip` / `xit` / `describe.skip` without a justification comment (antipattern 6)
- Test name lies about what's asserted (antipattern 8) - pairs with `spec-enforce-truth` CQ-1 (`req-test-name-only-match`) at the same severity

Mock-only theater (antipattern 3), trivial assertions (antipattern 7) are flagged at MEDIUM when uncertain whether the mock surface is truly external. Reviewer judgment.

Mode-dependent action mirrors the spec-discipline mode table (interactive/auto/unleashed).

## enforce_tdd interaction

The only user-controlled lever is `enforce_tdd: true | false` in `sdd/config.yml`. With `enforce_tdd: true` (default), code-reviewer flags antipatterns at the severities above and `spec-enforce-truth` auto-demotes Implemented REQs without test coverage. With `enforce_tdd: false`, both report findings to `sdd/.coverage-report.md` without modifying the spec - project-level opt-out only, intended for domains that genuinely don't admit automated testing (pure visual design systems, etc.).

There is **no per-test opt-out**. Inline comment shortcuts like `// tdd-allow:` are explicitly NOT supported, by design. Per-test opt-outs are agent-writable bypasses - they degrade into "every test the agent doesn't want to fix" markers and defeat the rule. If a test legitimately can't fit the discipline, delete it; the absence of a useless test is more honest than a flagged-and-allowed one.

## Migration policy

Existing tests that predate this rule are migrated as the surrounding production code changes, not rewritten speculatively. The most egregious cluster (`host/__tests__/sdd-workflow-upgrade.test.js`, 416 lines of pure text-matching theater) is the anchor example removed in the same commit that introduced this rule.

When you touch a file with antipattern tests, fix the tests in the same commit. Don't ship new code under coverage that doesn't actually cover anything.

## Binding invocation rules

- **code-reviewer** invokes this skill as a first action when any test file appears in the diff. The skill's antipattern catalogue executes against the touched files; findings flow into the agent's report.
- **tdd-guide** invokes this skill before authoring new tests; the antipatterns inform what *not* to produce and the positive-patterns section informs what to produce.

Skipping invocation when a test file is in the diff is itself a code-reviewer HIGH finding `tdd-enforce-skill-not-invoked`.
