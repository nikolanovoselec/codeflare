---
name: code-review-checklist
description: The canonical code-review category checklist, impact analysis and reviewer traps, shared by every runtime's code reviewer so both look for the same defects.
---

# Code review — what to look for

The categories, impact analysis and reviewer traps a code lane applies to a
changed hunk. Shared because a checklist that lives in one runtime's prompt is a
checklist the other runtime cannot apply: on one measured range the runtime
carrying the performance and shell rows returned a quadratic index, a tree
listing shelled three times and a failed scan read as silence, and the runtime
without them returned none of the three. What a reviewer looks for is policy,
not runtime configuration.

## Review checklist

**Security (CRITICAL)** — hardcoded credentials; SQL injection via concatenation instead of parameterised queries; XSS from unescaped input in HTML/JSX; path traversal on user-controlled paths; missing CSRF protection on state-changing endpoints; authentication bypasses on protected routes; known-vulnerable dependencies; secrets or PII in logs.

**Code quality (HIGH)** — functions over ~50 lines; files over ~800; nesting deeper than 4 (early returns, extracted helpers); unhandled rejections and empty catch blocks; mutation where immutable operations belong; leftover `console.log`; new code paths without tests; dead code, unused imports, unreachable branches.

**Test quality (HIGH)** — the `tdd-enforce` policy is binding whenever a test file appears in the diff (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`). Apply its antipattern catalogue and severity table; findings roll into this review. Not applying it when test files are in the diff is HIGH `tdd-enforce-skill-not-invoked`. The gut-check governs regardless of category: *if I delete or break the implementation this test covers, does it fail?*

**React/Next.js (HIGH)** — only when `react`/`next` is in `package.json` or `.tsx`/`.jsx` files are in the diff; skip entirely on Go, Rust, Python, Vue, Svelte, vanilla-DOM, CLI, library or embedded projects. Incomplete `useEffect`/`useMemo`/`useCallback` dependency arrays; setState during render; array index as key on reorderable lists; props drilled 3+ levels; missing memoisation on expensive work; `useState`/`useEffect` in Server Components; data fetching with no loading or error state; stale closures in handlers.

**Backend (HIGH)** — only on backend code (`express`/`fastify`/`hono`/`koa` in `package.json`, or `app.ts`/`server.ts`/`api/` routes). On non-Node backends apply the concepts, not the syntax: unvalidated request bodies and params; public endpoints without rate limiting; unbounded queries on user-facing endpoints; N+1 fetches in a loop where a join or batch belongs; external calls without timeouts; internal error details returned to clients; CORS open to unintended origins.

**Shell scripts (HIGH)** — two passes static review skips:

- **Comments are claims.** Read every `# explanation` as verifiable, not narration, and check the code below confirms it. Drift is a finding even when neither side is wrong alone — the gap is where bugs live.
- **Empty and missing input.** For every conditional ask what happens when the variable is empty, the regex missed, or the command failed, and decide whether it fails *open* (skips enforcement) or *closed*. Awk comparisons are the classic trap: `ts > ""` is true for any non-empty `ts`, so an unset threshold silently disables a filter.
- **Substring versus structural matching.** `grep "git push"` matches `echo "I will git push later"`. Parse shape with `jq` rather than grepping lines.
- **Error swallowing.** `2>/dev/null`, `|| true`, `set +e`, `command || exit 0` are each legitimate and each a place a real failure goes silent. Confirm every one is intentional.
- **External-tool guards.** `command -v gh >/dev/null 2>&1 || exit 0` degrades gracefully; a hard call fails loudly when the tool is absent.

```bash
# BAD: empty PUSH_TS makes (ts > "") always true -> fails open silently
PUSH_TS=$(grep -oE '...' | sed -E 's/.../\1/')
awk -v t="$PUSH_TS" '{ if (ts > t) ... }' transcript

# GOOD: fail closed if extraction failed
[ -n "$PUSH_TS" ] || exit 0

# BAD: substring match -- false positive on echo "git push later"
awk '/"name":"Bash"/ && /git push/'

# GOOD: structural query on the input field
jq -c 'select(.name == "Bash" and (.input.command | test("(^|&&\\s*)git\\s+push\\b")))'
```

**Performance (MEDIUM)** — O(n²) where O(n log n) or better is available; missing memoisation; whole-library imports where tree-shakeable ones exist; repeated expensive computation without caching; unoptimised images; synchronous I/O in async contexts.

**Best practices (LOW)** — TODO/FIXME without an issue reference; exported functions without docs; single-letter names in non-trivial contexts; magic numbers; formatting inconsistent with the file.

## Impact analysis

- **Caller impact.** Every caller of a modified symbol must still work with the new signature. `evidence.callSites` already lists them per symbol, bounded, with generated trees excluded — a row carrying `tooCommon: true` means the name has more sites than the list holds, so search that one symbol yourself; `changedInputs` covers callers changed in the same range. Search yourself only for a symbol neither one names — a dynamic import, a string-keyed route table, a `globalThis['handler']` lookup — and do it in one batched call for all such symbols at once. AI-authored changes routinely alter signatures without updating call sites; this is what catches it.
- **Schema alignment.** When a response shape changes, backend and frontend schemas must both move (Zod, TS types, validation).
- **JSON serialization.** `undefined` in an object bound for `JSON.stringify` silently strips the field. Use an explicit reset value or omit it.
- **Stored-record safety.** Never delete a required field from a stored record — write an explicit value (`'pending'`, not `undefined`).

## Rules that catch reviewers out

- **Over-flagging style the codebase doesn't share.** Before recommending early returns, composition, or an extracted helper, check whether nearby code already does that. Consistency beats taste.
- **Missing dynamic-import, reflection, and string-keyed call sites.** A symbol search finds direct imports; plug registries, string-keyed route tables and `globalThis['handler']` lookups do not appear that way. Search the literal name string too — and remember a NUL byte anywhere in a file makes `grep` call it binary and report nothing, so pass `-a` when that is possible.
- **Flagging test stubs as production bugs.** A fixture returning `null` is a contract stub, not a missing null-check. Read the test first.
- **CSS overrides not checked across selectors and media queries.** Grep every file for the affected class before flagging a layout regression; a hidden `@media` override is the cause more often than the obvious rule.
- **On AI-generated changes** prioritise behavioural regressions and edge cases, security assumptions and trust boundaries, hidden coupling and architecture drift, and caller impact.
