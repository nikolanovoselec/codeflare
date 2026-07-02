// Keep context-mode's bridge idle-reaper governed per-session by context-mode itself (its
// foreground/subagent split, upstream #868) rather than disabling it globally. A global
// CONTEXT_MODE_BRIDGE_IDLE_MS=0 (previously forced here and in entrypoint.sh) also disabled the
// reaper for non-foreground/subagent bridge children, so they never self-released and piled up —
// bun/node server.bundle.mjs helpers accumulating across a long, subagent-heavy session. Clearing
// any inherited override lets context-mode keep the foreground bridge quiet (it sets IDLE_MS=0 for
// the foreground child itself) while subagent/non-interactive children keep the default ~3-min
// idle reaper and self-release. The extension is retained (not deleted) so the managed-extension
// relay overwrites any stale `set-0` copy already synced into a user bucket.
export default function () {
  delete process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
}
