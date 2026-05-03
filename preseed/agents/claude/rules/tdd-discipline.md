# Test Discipline

Rules for what counts as a real test in this project. Applies to every
file under `src/__tests__/`, `host/__tests__/`, `web-ui/src/__tests__/`,
`e2e/`, and any future test directory regardless of test framework
(vitest, node:test, playwright).

This rule is the sibling of `spec-discipline.md` (what counts as a real
requirement) and `documentation-discipline.md` (what counts as real
documentation). Together they define what real-world artifacts look
like for spec, docs, and tests in this project.

## The one question

Every test must answer YES to:

> If I delete or break the implementation this test is supposed to
> cover, will this test fail?

If you can refactor freely, gut the implementation, replace it with a
no-op, or rename a public function while the test stays green, the
test is theater. Theater tests look reassuring on the dashboard but
catch zero regressions.

When you finish writing a test, mentally run the gut-check: "what
would I have to change in production code for this to fail?" If the
answer is "delete the file" or "rename a string literal in a doc",
the test is text-matching theater and must be replaced.

## Antipatterns (drawn from this codebase)

### 1. Text-matching theater

A test reads a file (markdown, source, config, prompt) and regex-matches
against its contents. The "system under test" is the file's prose, not
behavior. Found across `host/__tests__/sdd-workflow-upgrade.test.js`
(removed in 2026-05), `host/__tests__/memory-capture-hook.test.js`,
`host/__tests__/container-memory.test.js`,
`host/__tests__/entrypoint-sync.test.js`,
`web-ui/src/__tests__/page-transparency.test.ts`.

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

These pass if someone types the right string anywhere in the file.
They pass if the rest of the file is gibberish. They fail only if the
file is deleted or someone renames "forbidden" to "prohibited" in
prose. Implementation can be entirely broken — test stays green.

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

Now the test fails if the hook's exit code, stdout shape, or
agent-naming logic regresses — not if someone reformats prose.

### 2. Tautology

An assertion whose truth is given by the test setup itself. Cannot
fail. Found in `src/__tests__/lib/agent-seed-manifest.test.ts` and
`src/__tests__/lib/agent-seed-ecc-rules.test.ts`.

```js
// BAD: doc.modes is destructured from a literal fixture array
expect(doc.key.length).toBeGreaterThan(0);
expect(Array.isArray(doc.modes)).toBe(true);

// BAD: two hardcoded constants compared
expect(commonRules.length).toBe(ECC_FILES_PER_SUBDIR.common);
//                                ^^^^^^^^^^^^^^^^^^^^^^^^^
// hardcoded {common:3} — if production drifts to 4, this test
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

Now the test fails if files are added/removed without updating the
generator — which is the regression we care about.

### 3. Mock-only theater

Test mocks function X to return value V, calls X, asserts the result
is V. The mock IS the system under test. Found in
`src/__tests__/routes/storage-stats.test.ts`,
`src/__tests__/routes/container-lifecycle-helpers.test.ts`.

```js
// BAD: mock returns paginated data, test asserts the mock was called
mockParseListObjectsXml
  .mockReturnValueOnce({ objects: [...3 items...], isTruncated: true })
  .mockReturnValueOnce({ objects: [...2 items...], isTruncated: false });
await routeHandler(request);
expect(mockFetch).toHaveBeenCalledTimes(2);
//      ^^^^^^^^^ confirms code obeyed the mock; the pagination logic
// being "tested" lives inside the mock setup. If parseListObjectsXml
// has a real bug, this test does not catch it.
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

The rule: **only mock what's outside YOUR code** (third-party APIs,
network, the platform). Don't mock your own helpers — exercise them.

### 4. Implementation-coupled call counts

`expect(spy).toHaveBeenCalledTimes(N)` without a paired assertion on
observable output. Refactor-fragile, regression-blind. Found in
`src/__tests__/routes/storage-download.test.ts`,
`src/__tests__/routes/container-lifecycle-helpers.test.ts`.

```js
// BAD: only asserts an internal helper was called
expect(mockSign).toHaveBeenCalledTimes(1);
// Refactor to memoize → test fails despite identical behavior.
// Break signing entirely so URL is invalid but mockSign still
// gets called once → test passes despite broken behavior.
```

```js
// GOOD: assert on observable output. The signed URL itself.
const response = await routeHandler(req);
const signedUrl = await response.text();
expect(signedUrl).toMatch(/^https:\/\/.+\?X-Amz-Signature=/);
expect(verifySignedUrl(signedUrl, secret)).toBe(true);
```

If you genuinely care about call count (an expensive operation that
must not be repeated), pair it with an output assertion AND comment
why the count matters as a contract.

### 5. Empty body / missing assertions

Tests with no `expect`/`assert` call. The code runs, but nothing is
checked. Linter usually catches these; sometimes they slip in via
`it('does X', () => { someCode(); /* assertion forgotten */ })`.

```js
// BAD: no assertion — calling code without checking anything
it('handles edge case', async () => {
  const result = await processInput(edgeCase);
  // ... and nothing
});
```

```js
// GOOD: every it/test must produce at least one assertion
it('handles edge case', async () => {
  const result = await processInput(edgeCase);
  expect(result.status).toBe('skipped');
  expect(result.reason).toBe('input out of supported range');
});
```

### 6. Skipped tests without justification

`it.skip(...)`, `xit(...)`, `describe.skip(...)` without an inline
comment naming the blocker (issue link, upstream bug, environment
limitation). Skipped tests rot — without a removal trigger, they
stay skipped forever and the coverage they were supposed to provide
is silently lost.

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

`expect(Array.isArray([1,2,3])).toBe(true)`,
`expect(typeof 'foo').toBe('string')` — the truth is given by the
literal. The assertion adds nothing.

```js
// BAD: doc.modes is ['advanced'] from the fixture literal
expect(Array.isArray(doc.modes)).toBe(true);

// GOOD: assert types/shapes only on values from outside the test
const response = await routeHandler(req);
const body = await response.json();
expect(Array.isArray(body.users)).toBe(true);  // body came from a real handler
expect(body.users[0]).toHaveProperty('id');
```

## Patterns that produce useful tests

### Run the real thing

For shell scripts and hooks: spawn the script with stdin/argv/env,
assert exit code + stdout/stderr. The shape used in
`host/__tests__/enforce-review-spawn.test.js` and
`host/__tests__/git-push-review-reminder.test.js` is the canonical
example — those tests caught real bugs (PUSH_TS empty-string fail-open,
PUSH_LINE substring false-positives) that text-matching tests did not.

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

Build fixtures in files (or tmp dirs) that mirror real production data.
Read from disk; derive expectations from the same source of truth the
production code consults. If the test computes
`expected = literal` and compares against a value derived from
`literal`, you have tautology.

### Test the contract, not the implementation

For routes: send a real Request, get a real Response, assert on
status/headers/body. Don't assert on which internal helper was called.

For libraries: call the public function with real input, assert on
the return value or its observable side effect. Don't spy on private
internals.

For agents/prompts: extract the testable kernels (helper functions,
parsers, formatters) into normal modules and test those. The prompt
itself is human/LLM contract — exercise it via end-to-end runs in
integration tests, not by regex-matching the prompt text.

### One bug-class per test

Each test should answer: "what specific bug would this catch?"
If the answer is vague ("any general regression") or absent, split
or rewrite. The test name should make the bug-class explicit:
`rejects expired JWT`, `recovers from R2 503 with retry`, `aborts
on transcript with no push line`.

## Enforcement

`code-reviewer` agent (HIGH severity) flags:
- Tests that read file content + regex/substring match against it
- Assertions whose values are destructured from local literal fixtures
- `expect(spy).toHaveBeenCalledTimes(N)` without paired output assertion
- `it.skip` / `xit` / `describe.skip` without a justification comment
- Test bodies with no `expect`/`assert` call

`tdd-guide` agent writes tests in this style by default and refuses
to produce text-matching theater.

The only user-controlled lever is `enforce_tdd: true | false` in
`sdd/config.yml`. With `enforce_tdd: true` (default), code-reviewer
flags antipatterns at HIGH and spec-reviewer auto-demotes Implemented
REQs without test coverage. With `enforce_tdd: false`, both report
findings to `sdd/.coverage-report.md` without modifying the spec —
project-level opt-out only, intended for domains that genuinely don't
admit automated testing (pure visual design systems, etc.).

There is **no per-test opt-out**. Inline comment shortcuts like
`// tdd-allow:` are explicitly NOT supported, by design. Per-test
opt-outs are agent-writable bypasses — they degrade into "every test
the agent doesn't want to fix" markers and defeat the rule. If a
test legitimately can't fit the discipline, delete it; the absence
of a useless test is more honest than a flagged-and-allowed one.

## Migration policy

Existing tests that predate this rule are migrated as the surrounding
production code changes — not rewritten speculatively. The most
egregious cluster (`host/__tests__/sdd-workflow-upgrade.test.js`,
416 lines of pure text-matching theater) is the anchor example
removed in the same commit that introduces this rule.

When you touch a file with antipattern tests, fix the tests in the
same commit. Don't ship new code under coverage that doesn't actually
cover anything.
