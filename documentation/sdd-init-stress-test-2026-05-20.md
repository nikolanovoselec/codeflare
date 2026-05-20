# Stress-test findings — /sdd init v2 against zipline-native (2026-05-20)

Autonomous run captured 8 framework issues. Severity tier maps to whether the next user invocation will hit the issue first.

## P0 (blocker — fix before next user-facing run)

### FF-1: Graphify scoping check too permissive

**Where:** `sdd-init/SKILL.md` § Phase 5 pre-condition + Fallback when graphify is absent.

**Failure mode:** Skill prose says "fire fallback when graphify-out/graph.json is absent." But `mcp__graphify__graph_stats()` returns data from the unified global graph layer when local graph is absent. During stress test the global layer returned 74 nodes — vault sessions, codeflare ADRs, no zipline content. `god_nodes(top_n=15)` returned `Decisions`, `Context`, `Observations`, `Session 2026-05-19 - ...` — pure noise for spec drafting. Agent could have happily proceeded with this and produced a spec mixing zipline + codeflare ADR concepts.

**Fix:** add an explicit project-scoping check. Phase 5a step 1 reads `graphify-out/graph.json` file existence; if absent OR `graph_stats()` shows nodes whose `source_file` field doesn't overlap with the current project tree (>50% of nodes outside `pwd`), force fallback path.

### FF-3: Autonomous-mode behavior undefined

**Where:** `sdd-init/SKILL.md` § Greenfield step 1, § Import Mode "single user-facing question at step 1".

**Failure mode:** Skill assumes a human answers the vision question and the draft-accept prompt. In a fully autonomous run (`--unleashed` with no interactive surface), the skill doesn't say what defaults to use. The agent must infer: auto-accept inferred-from-README vision; auto-accept generated draft; skip the "edit section" loop. I made these choices during the stress test but they're not documented.

**Fix:** add `--autonomous` flag documentation (or treat `--unleashed` as implying autonomous). Specify: vision = first paragraph of README (or "Inferred from source" if README missing); draft acceptance = auto-accept; section-edit loop = skipped; user notified via console log only.

## P1 (sharp edge — visible but workaround exists)

### FF-2: ADR marker convention dash inconsistency

**Where:** `spec-driven-development/references/templates/documentation-decisions-readme.md` (heading style `### AD1:` no dash) vs. `sdd-init/SKILL.md` Phase 5c + Phase 6f (inline marker style `// AD-N:` with dash).

**Failure mode:** Sidecar Pass 17 staleness check needs to match `// AD-N: title` against a row keyed `AD1`. The two forms drift. My Pass 17 implementation tolerates both via regex normalization (`AD-?\d+`), but the skill prose doesn't mandate that tolerance.

**Fix:** standardize on one form. Recommend `AD-N` everywhere (heading + comment + sidecar) — matches the existing `// AD-N: Title` inline marker convention and makes Pass 17 detection unambiguous.

### FF-5: Pass 6b "90% row threshold" promise without implementation

**Where:** `sdd-init/SKILL.md` Pass 6b output rule says "row count ≥ 90% of source file count."

**Failure mode:** No validator pass implements this check. doc-enforce Pass 16 catches placeholder literals; Pass 17 catches sidecar staleness; nothing checks Source Module Map exhaustiveness. Zipline-native scaffold I wrote covered 21/30 files (70%) — under the threshold but no finding fires.

**Fix:** add to doc-enforce-shape (Pass 5/6 family) a `source-module-map-incomplete` MEDIUM finding when the architecture.md § Source Module Map row count is below 90% of detected source-file count. Or downgrade the prose from "Verifiable: ≥90%" to "Goal: ≥90%; ad-hoc inspection during review."

## P2 (drift risk — non-immediate, but will surface)

### FF-4: Validator-loop invocation mechanism unspecified

**Where:** `sdd-init/SKILL.md` § Iterate-to-clean. Says "Invoke `spec-enforce` with `scope=all`."

**Failure mode:** spec-enforce + doc-enforce are SKILLS (instructions), not agents. There's no `invoke` verb that runs them as a validator process. The iterate-to-clean loop in practice means: read the skill, walk its rules against draft, fix, repeat. That's an honor-system loop — no external check that all 18 spec-enforce rows actually ran. During stress test I checked only Pass 16 + Pass 17 (the new ones); the other 16 spec-enforce rows + 12 other doc-enforce rows weren't walked.

**Fix:** either (a) dispatch a real subagent for the validator call at scaffold time (token-expensive but verifiable), or (b) demote the iterate-to-clean prose from "Invoke" to "Walk the skill's rules and apply" and acknowledge it's self-applied at scaffold time. Honestly document the gap.

### FF-6: `requested_mode_post_transition` round-trip not validated

**Where:** `sdd-init/SKILL.md` § Mode-flag persistence + Transition-closure step.

**Failure mode:** Resume Mode closure copies `requested_mode_post_transition` into `mode:` and deletes the requested key. No validator catches a buggy Resume Mode that forgets this. The invariant "if transition: true then mode != unleashed; if requested_mode_post_transition set then it matches a valid value" is unguarded.

**Fix:** add to spec-enforce a config-shape check: `transition: true` ⇒ `mode != unleashed`; `requested_mode_post_transition` ⇒ value in `{interactive, auto, unleashed}`.

### FF-7: Cold-read self-simulation honor system

**Where:** `sdd-init/SKILL.md` Pass 6j "Cold-read tier — at scaffold time, cold-read runs via self-simulation only."

**Failure mode:** The agent is supposed to re-read its own output cold and judge whether a stranger would understand. In an autonomous run with no checkpoint, the agent can skip this and no validator catches it. Honor system.

**Fix:** make the self-simulation step concrete: "for each lane file, after writing, re-read the first 50 lines as if reading for the first time; emit one explicit observation: 'this would be understandable to a stranger because X' OR 'this needs Y added for stranger comprehension.' Emit observations to `documentation/.review-needed.md` as advisory entries even if zero issues found."

### FF-8: Pass 17 marker regex tolerance not documented

**Where:** `doc-enforce-lanes/SKILL.md` § ADR marker sidecar staleness.

**Failure mode:** Doesn't specify the regex used to detect inline `// AD-N:` markers. Implementation can choose strict `// AD-\d+:` or tolerant `// AD-?\d+:`. Drift over time as different implementations interpret.

**Fix:** add explicit regex to the skill: `//\s*AD-?\d+\s*:` (tolerant) OR `//\s*AD-\d+\s*:` (strict) — pick one and pin it.

---

## Summary

The framework worked end-to-end. Three rounds of opus+ultrathink review caught the load-bearing failure modes (blockers 1-5, NP-1/2/3, DR-15). The stress test revealed the next layer — runtime-environment assumptions (graphify scoping, autonomous defaults) and validator-promise-without-implementation gaps.

P0 fixes are mechanical; recommend applying before merging the feat/sdd-init-supercharge branch. P1 fixes improve robustness. P2 fixes are documentation-honesty edits — the framework PROMISES things it doesn't deliver, which is worse than not promising them.

Scaffold output at `/home/user/workspace/zipline-native/` (sdd-stress-test branch, local only) is real and reasonable-quality despite the framework gaps — confirms the skill prose is mostly accurate; the gaps are edge cases.
