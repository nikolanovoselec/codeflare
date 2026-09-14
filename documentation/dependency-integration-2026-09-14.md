# September 14 dependency integration

Scope: integrate the 42 open dependency PRs into develop, preserving already-shipped product changes. No production deployment or main merge is authorized. Baseline: `08a6b7101715f5a82e45e8b12821d131f130a74a`.

## Resolution strategy

Historical PR merge bases predate squash promotions and include already-delivered application changes. This integration retains current develop and applies each selected tip's actual dependency delta, then regenerates the seven affected npm locks and embedded seed using existing scripts. All 42 heads are recorded as merge parents; 14 obsolete bumps are resolved to their newer same-package candidate, not installed over it. This is intentional merge conflict resolution, not acceptance of old branch snapshots.

The remaining prompt-caching branch shipped through #1086, with later #1116/#1123 corrections. Closed #1083 was explicitly folded into #1072 (owner closure comment 5616294827); its transient-state behavioral test matches develop. The two backups predate merged #1071/#1072. None requires another code merge.

## Breaking changes and necessary corrections

### Node and Browser IDE

#1081 changes Node 24 host/build/runtime stages to 26.8.1. Node 26 removes legacy `_stream_*` modules, `writeHeader` and experimental transform-types flags, changes crypto APIs and includes a new built-in Undici major. Native PTY compilation and host lifecycle tests must run under the new runtime. The three intentionally Node-22 IDE stages stay at 22.21.1: their engine/type boundary follows the embedded extension host, not the terminal host. Advancing those stages alone would violate the existing contract. No related package requires this mistaken IDE migration.

#1093 advances code-server 4.135.0 → 4.137.0 and embedded Code 1.135 → 1.137. Its checksum placeholder is replaced by upstream release digest `9303165b7fd43532091922f77e2f119ff2fa109c6b6f1c3c966fb02f3d6d9c8b`. The full archive was streamed through SHA-256 without retaining it locally; its actual js-yaml package is 5.4.1. Remove the incompatible 4.3.2 YAML overlay rather than downgrading upstream's 5.x dependency. Keep separate tar/pacote security overlays and update packaged smoke expectations. No changes to authenticated loopback proxying, inventory ownership or extension-host permissions.

Sources: https://github.com/nodejs/node/releases/tag/v26.0.0 ; https://github.com/nodejs/node/releases/tag/v26.8.1 ; https://github.com/coder/code-server/compare/v4.135.0...v4.137.0

### Agent tools

Claude CLI/VSIX 2.1.263 incorporates stricter managed-setting validation, project-local bypass rejection, plugin symlink containment and MCP policy fixes. Existing managed/explicit permission configuration remains; do not move it into project settings or relax plugin containment. Codex 0.153.4 changes its unconfigured default and makes the planner opt-in; preserve explicit model settings, do not enable new defaults. OpenCode 1.18.29 includes OAuth model discovery and Copilot interaction fixes.

Copilot 1.0.83 needs slirp4netns, nsenter and iptables/ip6tables for Linux sandboxing. Add the missing OS packages, retaining util-linux. This does not grant TUN, privilege, local-network access or credential access. The actual platform's restrictions still apply; launch success outside a sandbox is not sandbox qualification.

Herdr 0.9.0 moves clients to the persistent server and changes independent-client selection/resize and prompt-wait behavior. Existing launcher server ownership remains. Update the version-specific live-readiness gate/provenance and skill; waiting for a newly idle agent is not proof that a steering message sent to an already-working agent completed. LazyGit 0.65.1 repairs Esc/daemon handling; replace its invalid checksum placeholder with the authoritative asset digest. Bun 1.4.2 includes fixes for 1.4.1 regressions; skip obsolete intermediate bumps. uv 0.12.10 includes preceding extraction/security corrections.

Sources: https://github.com/anthropics/claude-code/releases/tag/v2.1.263 ; https://github.com/openai/codex/releases/tag/rust-v0.153.4 ; https://github.com/github/copilot-cli/releases/tag/v1.0.83 ; https://github.com/anomalyco/opencode/releases/tag/v1.18.29 ; https://github.com/herdrdev/herdr/releases/tag/v0.9.0 ; https://github.com/jesseduffield/lazygit/releases/tag/v0.65.1

### Pi, tools and skills

Pi remains 0.85.1; runtime/prewarm/override alignment is unchanged. Subagents 21.4.5 adds child ask/notify protocols, fixes tools:none semantics, question/resume outcomes and provider-error classification. A direct executable probe reproduced bootstrap filtering incorrectly removing both registered child protocols. REQ-AGENT-158 and behavioral tests now retain only upstream-registered child protocol tools, without manufacturing ordinary permissions or changing parent/Plan/Goal/Inline ownership.

RPIV 2.9.0 main packages differ only in package metadata/common config; no executable/schema migration. Correct todo's stale lock version and integrity assertions (the original test reproduced 2.9.0 versus 2.8.0 failure). Usage 0.60.3 preserves legacy target settings and requires explicit account selection; do not rewrite user data or add credentials. Web access 0.28.0 adds opt-in providers, concurrent ordered searches and proxy isolation; leave paid providers disabled unless requested.

MCP adapter 2.32.1 fixes public build artifacts after the 2.32 additions. Its mcp-scripting skill becomes manual-only; respect upstream metadata. Keep separate MCP App sandbox origin and existing Pi-ai override (the declared ^0.84.1 range does not include 0.85.1; real pinned-runtime CI matters). No blanket tool exposure or OAuth relaxation.

Graphify 0.9.61 includes import/PDF dependency fixes and earlier undirected BFS/DFS neighborhood exploration. Update query guidance: neighborhood connectivity does not establish a directed path; shortest-path semantics remain separate. No repository graph extraction, refresh or headless semantic work is part of this update.

Sources: https://github.com/gotgenes/pi-packages/compare/pi-subagents-v21.1.0...pi-subagents-v21.4.5 ; https://registry.npmjs.org/@juicesharp/rpiv-todo/2.9.0 ; https://github.com/nicobailon/pi-mcp-adapter ; https://github.com/nicobailon/pi-web-access ; https://github.com/narumiruna/pi-extensions

### Application dependencies and Actions

Root/browser Zod 4.5.4 remains normal parse/safeParse; do not adopt new Function-based compilation in Workers. TypeBox 1.3.25 includes sparse-array/Unicode/interning corrections, not the older 1.3.0 removal migration. Wrangler 4.129 changes unstable_printBindings, but no local consumer exists; actual unstable_readConfig and Workers-pool tests remain the checks. Keep compatibility_date, security overrides, independent workflow Wrangler and intentional duplicated transitive trees.

Jest-dom 7 requires Node >=22 and DOM testing-library >=10 <11; existing dom 10.4.1/Vitest setup satisfy it. xterm beta.304 changes core extended attributes, not merely an unused image addon. Preserve the deliberate exact beta for synchronized-output support and update current mobile documentation, not historical investigation notes. Motion 13 removes automatic React Emotion prop validation; the sole landing caller uses vanilla inView/animate, so no React migration. Astro/happy-dom and Motion require combined build/tests; mocked Motion tests do not prove browser animation completion. Preserve landing SVGO 4.1.0 against stale branch locks.

Oxlint 1.81 changes diagnostics/native bindings; update both image version assertions and smoke fixtures, with no autofix cleanup. Zizmor-action 0.6.3 updates its nested SARIF action but Codeflare's explicit auditor remains 1.29.0; keep least privileges and full SHA.

Sources: https://github.com/colinhacks/zod/releases/tag/v4.5.0 ; https://github.com/sinclairzx81/typebox/compare/1.3.19...1.3.25 ; https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.129.0 ; https://github.com/testing-library/jest-dom/releases/tag/v7.0.0 ; https://github.com/xtermjs/xterm.js/compare/d3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789...c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2 ; https://github.com/motiondivision/motion/blob/e871ba7f175d0609cef84f416f984e8e84be8333/CHANGELOG.md ; https://github.com/oxc-project/oxc/releases/tag/oxlint_v1.81.0

## Verification boundary

Lock generation is script-suppressed and bounded; no local dependency installation or image build. Child protocol probe and todo regression each have observed failing and passing outcomes. Full authoritative verification runs in GitHub PR Checks on the final develop SHA. Image smoke remains owned by the existing image pipeline; this document does not claim deployment, sandbox capability on the live platform, or paid provider acceptance. Upstream release-note gaps (including terse Claude .263 notes) are not filled with invented guarantees.

## PR accounting

| PR | Branch | Resolution |
|---|---|---|
| [#1073](https://github.com/nikolanovoselec/codeflare/pull/1073) | `dependabot/npm_and_yarn/host/develop/npm-host-ce6036253e` | Integrated, with corrections described above |
| [#1074](https://github.com/nikolanovoselec/codeflare/pull/1074) | `dependabot/npm_and_yarn/web-ui/develop/npm-web-ui-baf687c784` | Integrated, with corrections described above |
| [#1075](https://github.com/nikolanovoselec/codeflare/pull/1075) | `dependabot/npm_and_yarn/web-ui/develop/xterm/xterm-6.1.0-beta.304` | Integrated, with corrections described above |
| [#1076](https://github.com/nikolanovoselec/codeflare/pull/1076) | `dependabot/npm_and_yarn/develop/npm-root-ed71323308` | Integrated, with corrections described above |
| [#1077](https://github.com/nikolanovoselec/codeflare/pull/1077) | `dependabot/npm_and_yarn/web-ui/develop/testing-library/jest-dom-7.0.1` | Integrated, with corrections described above |
| [#1078](https://github.com/nikolanovoselec/codeflare/pull/1078) | `dependabot/npm_and_yarn/landing/develop/npm-landing-0af3844c93` | Integrated, with corrections described above |
| [#1079](https://github.com/nikolanovoselec/codeflare/pull/1079) | `dependabot/npm_and_yarn/landing/develop/motion-13.1.0` | Integrated, with corrections described above |
| [#1080](https://github.com/nikolanovoselec/codeflare/pull/1080) | `dependabot/npm_and_yarn/image/oxlint/develop/npm-image-oxlint-4d41d781b3` | Integrated, with corrections described above |
| [#1081](https://github.com/nikolanovoselec/codeflare/pull/1081) | `dependabot/docker/develop/docker/library/node-26.8.1-bookworm-slim` | Integrated, with corrections described above |
| [#1082](https://github.com/nikolanovoselec/codeflare/pull/1082) | `dependabot/github_actions/develop/github-actions-8280b51821` | Integrated, with corrections described above |
| [#1087](https://github.com/nikolanovoselec/codeflare/pull/1087) | `bump/claude-vscode-2.1.260` | Superseded by #1120 |
| [#1088](https://github.com/nikolanovoselec/codeflare/pull/1088) | `bump/uv-0.12.9` | Superseded by #1106 |
| [#1089](https://github.com/nikolanovoselec/codeflare/pull/1089) | `bump/opencode-ai-1.18.27` | Superseded by #1111 |
| [#1090](https://github.com/nikolanovoselec/codeflare/pull/1090) | `bump/openai-codex-0.153.2` | Superseded by #1108 |
| [#1091](https://github.com/nikolanovoselec/codeflare/pull/1091) | `bump/anthropic-ai-claude-code-2.1.260` | Superseded by #1119 |
| [#1092](https://github.com/nikolanovoselec/codeflare/pull/1092) | `bump/bun-1.4.1` | Superseded by #1113 |
| [#1093](https://github.com/nikolanovoselec/codeflare/pull/1093) | `bump/code-server-4.137.0` | Integrated, with corrections described above |
| [#1095](https://github.com/nikolanovoselec/codeflare/pull/1095) | `bump/graphify-0.9.58` | Superseded by #1121 |
| [#1096](https://github.com/nikolanovoselec/codeflare/pull/1096) | `bump/opencode-ai-1.18.28` | Superseded by #1111 |
| [#1097](https://github.com/nikolanovoselec/codeflare/pull/1097) | `bump/pi-ext-gotgenes-pi-subagents-21.4.0` | Superseded by #1125 |
| [#1098](https://github.com/nikolanovoselec/codeflare/pull/1098) | `bump/pi-ext-pi-mcp-adapter-2.32.1` | Integrated, with corrections described above |
| [#1099](https://github.com/nikolanovoselec/codeflare/pull/1099) | `bump/pi-ext-narumitw-pi-usage-0.60.3` | Integrated, with corrections described above |
| [#1100](https://github.com/nikolanovoselec/codeflare/pull/1100) | `bump/pi-ext-juicesharp-rpiv-todo-2.9.0` | Integrated, with corrections described above |
| [#1101](https://github.com/nikolanovoselec/codeflare/pull/1101) | `bump/pi-ext-juicesharp-rpiv-advisor-2.9.0` | Integrated, with corrections described above |
| [#1102](https://github.com/nikolanovoselec/codeflare/pull/1102) | `bump/pi-ext-juicesharp-rpiv-ask-user-question-2.9.0` | Integrated, with corrections described above |
| [#1103](https://github.com/nikolanovoselec/codeflare/pull/1103) | `bump/herdr-0.9.0` | Integrated, with corrections described above |
| [#1104](https://github.com/nikolanovoselec/codeflare/pull/1104) | `bump/github-copilot-1.0.83` | Integrated, with corrections described above |
| [#1105](https://github.com/nikolanovoselec/codeflare/pull/1105) | `bump/claude-vscode-2.1.261` | Superseded by #1120 |
| [#1106](https://github.com/nikolanovoselec/codeflare/pull/1106) | `bump/uv-0.12.10` | Integrated, with corrections described above |
| [#1107](https://github.com/nikolanovoselec/codeflare/pull/1107) | `bump/anthropic-ai-claude-code-2.1.261` | Superseded by #1119 |
| [#1108](https://github.com/nikolanovoselec/codeflare/pull/1108) | `bump/openai-codex-0.153.4` | Integrated, with corrections described above |
| [#1109](https://github.com/nikolanovoselec/codeflare/pull/1109) | `bump/graphify-0.9.59` | Superseded by #1121 |
| [#1110](https://github.com/nikolanovoselec/codeflare/pull/1110) | `bump/pi-ext-pi-web-access-0.28.0` | Integrated, with corrections described above |
| [#1111](https://github.com/nikolanovoselec/codeflare/pull/1111) | `bump/opencode-ai-1.18.29` | Integrated, with corrections described above |
| [#1112](https://github.com/nikolanovoselec/codeflare/pull/1112) | `bump/pi-ext-gotgenes-pi-subagents-21.4.2` | Superseded by #1125 |
| [#1113](https://github.com/nikolanovoselec/codeflare/pull/1113) | `bump/bun-1.4.2` | Integrated, with corrections described above |
| [#1118](https://github.com/nikolanovoselec/codeflare/pull/1118) | `bump/lazygit-0.65.1` | Integrated, with corrections described above |
| [#1119](https://github.com/nikolanovoselec/codeflare/pull/1119) | `bump/anthropic-ai-claude-code-2.1.263` | Integrated, with corrections described above |
| [#1120](https://github.com/nikolanovoselec/codeflare/pull/1120) | `bump/claude-vscode-2.1.263` | Integrated, with corrections described above |
| [#1121](https://github.com/nikolanovoselec/codeflare/pull/1121) | `bump/graphify-0.9.61` | Integrated, with corrections described above |
| [#1122](https://github.com/nikolanovoselec/codeflare/pull/1122) | `bump/pi-ext-gotgenes-pi-subagents-21.4.4` | Superseded by #1125 |
| [#1125](https://github.com/nikolanovoselec/codeflare/pull/1125) | `bump/pi-ext-gotgenes-pi-subagents-21.4.5` | Integrated, with corrections described above |

## First integrated CI result and corrections

[Run 34887375902](https://github.com/nikolanovoselec/codeflare/actions/runs/34887375902) at `0c716490b9e24f5dc3b9a6c3513fa409fde2f773` passed every executed non-host lane. Host failures identified Wrangler's newly nested Sharp 0.35.2/libvips 1.3.1 below existing security floors, a stale Zizmor SHA assertion, and the deliberate subagent-version sentinel. Add the existing fixed Sharp 0.35.4 as an explicit root override and regenerate, preserving the floor test. Update the action assertion without altering its permissions. A probe of the tagged 21.4.5 manager method confirms it still invokes resume for queued/running records; the managed guard rejects both, so retain the guard and advance its reviewed-version sentinel. These corrections require a new exact-head CI run; the preceding run is not green evidence for the corrected tree.
