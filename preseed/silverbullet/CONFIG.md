#meta

SilverBullet runtime config for the Codeflare vault. See [[Library/Std/Config]] for all built-in options.

Add custom config in the block below:

```space-lua
-- Codeflare-managed config. Hand-edits survive but this page is
-- overwritten on every container boot. See preseed/silverbullet/CONFIG.md
-- in the codeflare repo to make changes that persist across releases.

-- REQ-VAULT-008 AC7: treeview exclude patterns. Hidden because they
-- are either derived/agent-owned (graphify-out, Library), editor
-- state (.silverbullet, dotted - SB hides by default), SB's own
-- library-manager mirror (Repositories), or top-level preseed pages
-- the user should not accidentally edit (CONFIG, Index, README,
-- STYLES). The server-side /.fs filter (AC6) handles graphify-out at
-- the response layer; this block is the parallel UI-side guard.
--
-- Schema is the silverbullet-treeview plug's v2 config: top-level key
-- `treeview` (NOT `plug.treeview`), field `exclusions` (NOT `exclude`),
-- each entry is `{ type = "regex", rule = "<regex>" }`. Bare-string
-- glob patterns are silently dropped by the plug. See PLUG.md in
-- preseed/silverbullet/plugs/treeview/ for the upstream schema.
config.set {
  treeview = {
    exclusions = {
      { type = "regex", rule = "^(Library|Repositories|graphify-out)/" },
      { type = "regex", rule = "^(CONFIG|Index|README|STYLES)$" },
    },
  },
}
```
