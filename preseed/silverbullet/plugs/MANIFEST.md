# Preseeded SilverBullet Plugs

Auto-loaded on container boot via `init_user_vault()`. Copied into
`Vault/Library/Codeflare/` as "rogue plugs" (loaded by SilverBullet's
plug discovery, no Library Manager manifest needed).

**Each `.plug.js` here is an upstream-built distributable**, downloaded
verbatim from the source repos pinned below. Do not edit the files in
place. They contain bundled `console.{log,warn,error}` calls that
originate from the upstream plug authors; the project rule against
`console.log` in production code applies to first-party source under
`src/` and `web-ui/src/`, not to vendored binaries. To refresh, re-
download from the pinned releases / commits and bump the entries below.

| Plug | Source | Pin |
|---|---|---|
| pdf | MrMugame/silverbullet-pdf | release 1.1.6 |
| treeview | joekrill/silverbullet-treeview | commit `c67dec213e8c31086fb0dc391965ae36aaefffba` |
| github | silverbulletmd/silverbullet-github | commit `932906be525927fe96b9f3d82dd0314465dad7fe` |
| graph | simone-viozzi/silverbullet-graph | commit `84f2e2dafa1a68f5f395611033def977459267ea` |
