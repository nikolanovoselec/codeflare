#meta

SilverBullet runtime config for the Codeflare vault. See [[Library/Std/Config]] for all built-in options.

Add custom config in the block below:

```space-lua
-- Codeflare-managed config. Hand-edits survive but this page is
-- overwritten on every container boot. See preseed/silverbullet/CONFIG.md
-- in the codeflare repo to make changes that persist across releases.

-- REQ-VAULT-008 AC7: treeview exclude patterns. The folders / pages
-- listed below are hidden from the SB tree pane because they are
-- either derived/agent-owned (graphify-out, Library), editor state
-- (.silverbullet), or top-level preseed pages the user should not
-- accidentally edit (CONFIG, Index, README, STYLES). The server-side
-- /.fs filter (AC6) handles graphify-out at the response layer; this
-- block is the parallel UI-side guard.
config.set("plug.treeview", {
  exclude = {
    "Library/*",
    "Repositories/*",
    "graphify-out/*",
    ".silverbullet/*",
    "CONFIG",
    "Index",
    "README",
    "STYLES",
  },
})
```
