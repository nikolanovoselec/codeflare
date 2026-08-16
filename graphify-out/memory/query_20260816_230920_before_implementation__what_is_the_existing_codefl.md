---
type: "query"
date: "2026-08-16T23:09:20.782703+00:00"
question: "Before implementation, what is the existing Codeflare VS Code state across current source, session captures, history, documentation, packaged runtime, and tests?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Browser IDE", "welcome-extension.ts", "MANAGED_OPENVSCODE_SETTING_KEYS", "smoke-openvscode-sidebar-image.mjs", "entrypoint-openvscode.test.js", "REQ-IDE-024: Codeflare Browser IDE welcome", "AD120: Browser IDE uses fixed public workspace selection and exported UI-state continuity"]
---

# Q: Before implementation, what is the existing Codeflare VS Code state across current source, session captures, history, documentation, packaged runtime, and tests?

## Answer

Codeflare currently pins code-server 4.132.0 and Code OSS 1.132.0, removes bundled Copilot, packages immutable Pi/Claude/empty base inventories, selects one base directory from tab one, and launches it directly as the ephemeral extensions-dir beside ephemeral User data. The built-in codeflare-welcome activates onStartupFinished in every inventory and is the only cross-inventory extension seam. R2 persists only the bounded ide-ui-state.json after generation reap; extension registries, bytes, global/workspace storage, SecretStorage, authentication, and arbitrary settings remain ephemeral. Managed settings are reapplied after UI restore and their key list is the authoritative exclusion boundary. Existing CLI/workbench support already provides Open VSX install/update/uninstall, while the Fable plan's runtime evidence proves symlink-seeded bases, live activation, registry-truth uninstall, and extensions.allowed publisher bypass. Prior session work proposed hashed artifact CAS, but the later Fable plan deliberately supersedes it with a 64 KiB manifest-only, no-VSIX-byte, lazy in-session restore design. Current CI uses shell/Node/package and complete-image smoke seams without browser automation; the user explicitly forbids local tests, Playwright, Chromium, and manual tests. The running development container's /opt image is older than repository HEAD (for example Claude 2.1.223 and no packaged welcome), so repository source and CI-built image—not local /opt—are authoritative.

## Outcome

- Signal: useful

## Source Nodes

- Browser IDE
- welcome-extension.ts
- MANAGED_OPENVSCODE_SETTING_KEYS
- smoke-openvscode-sidebar-image.mjs
- entrypoint-openvscode.test.js
- REQ-IDE-024: Codeflare Browser IDE welcome
- AD120: Browser IDE uses fixed public workspace selection and exported UI-state continuity