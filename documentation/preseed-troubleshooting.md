# Preseed System: Troubleshooting

Diagnostic guides for the agent preseed system, hook enforcement, and review-spawn checkpoint.

**Audience:** Developers

See [Preseed System](preseed.md) for session modes, components, deployment pipeline, and multi-agent support.

---

## Common Issues

- **Attribution blocking not working**: Check `~/.claude/settings.json` has `PreToolUse` hook entries pointing to `block-attributed-commits.sh` on two matcher entries covering three tool names: a `Bash` matcher (with `"if": "Bash(git *)"` and `"if": "Bash(gh *)"` predicates) AND a pipe-alternated MCP matcher `"matcher": "mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute"`. Verify the script exists at `~/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh`. If attribution appears via `gh pr create` in a context-mode session, the MCP matcher entry is missing — re-run the entrypoint or check the `SETTINGS_CONFIG` merge in `entrypoint.sh`.

- **Review-spawn enforcement not firing on push**: see [Resetting the review-spawn checkpoint](#resetting-the-review-spawn-checkpoint) below.

- **Default mode has hooks**: If `settings.json` has hook entries in default mode, the entrypoint `SESSION_MODE` gating may have failed. Remove them:
  `jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`.

- **`/dev/fd/63: No such file or directory` from a custom hook**: a bash hook using process substitution (`done < <(...)`) is being invoked in a runner where `/proc/self/fd` is not available, so the kernel cannot resolve the `/dev/fd/<N>` symlink the shell created. Most codeflare hooks default to here-strings (`done <<< "$STR"`) for this reason: here-strings stage through a real temp file and work in every runner. The one documented exception is `enforce-review-spawn.sh`'s `compute_required_lanes` which uses process substitution `done < <(git diff -z ...)` because bash strips NUL bytes from command substitution captures and the `-z`/`read -d ''` pair needs the NUL delimiter preserved; this hook is container-runtime-aware. If you author a custom hook that hits the `/dev/fd/63` error in a different runner, switch the read loop's redirection to a here-string (and accept the NUL-stripping tradeoff if you also need `-z`).

- **Stop hook spawns all three review agents even on a doc-only push (partially-deployed install)**: `enforce-review-spawn.sh` and `git-push-review-reminder.sh` both source `scripts/lib/lane-classifier.sh` (path is relative to the hooks plugin root; in source it lives at `preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`) to determine which lanes a diff requires. If the helper is missing or fails to source, both hooks fail-closed to the legacy all-three-lanes posture (`code-reviewer spec-reviewer doc-updater`) rather than skipping enforcement, so a partially-synced plugin set never disables review. To diagnose, check `ls ~/.claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`; if absent, re-run `entrypoint.sh` or trigger a full R2 sync to restore the complete plugin payload.

---

## Resetting the Review-Spawn Checkpoint

The `Stop` hook (`enforce-review-spawn.sh`) only fires in advanced mode when `sdd/` and `sdd/README.md` are present. It triggers at PR-boundary events: `gh pr create` runs in the session, OR a push lands on a branch that already has an open PR (the hook calls `gh pr view` to check). Enforcement only fires when the open PR targets `main` or `master`. PRs into intermediate branches (`develop`, `staging`) are silently deferred until that branch's own PR-to-`main` opens.

The hook tracks the most recently acknowledged PR HEAD SHA in `.git/sdd-last-ack-pr-head`. Acknowledgment advances only when the full pipeline (code-reviewer + spec-reviewer + doc-updater) is observed for the current PR HEAD.

Three USER-ONLY bypass methods exist (the agent must never invoke these autonomously): the user runs `touch /tmp/review-bypass` (one-shot sentinel; per-session, not committed, auto-deleted on use), the user says "skip review" in a message, or the user waits for the 3-strike circuit breaker to clear after 3 blocks on the same un-acknowledged PR HEAD.

If enforcement fires spuriously after a legitimate pipeline completed, reset both checkpoints:

```bash
rm .git/sdd-last-ack-pr-head .git/sdd-review-block-count
```

The legacy v4 timestamp file `.git/sdd-last-ack-push` (if present from a prior install) is auto-deleted on the first v5 invocation, so no manual cleanup is needed for the v4 to v5 migration path.

---

## Related Documentation

- [Preseed System](preseed.md) - Session modes, components, deployment, multi-agent support
- [Memory](memory.md) - Vault-based cross-session memory, automatic capture, hook mechanics
- [Container](container.md#claude-code-integration) - Claude Code configuration
