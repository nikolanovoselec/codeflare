# Browser IDE and VS Code

**Availability:** Core Browser IDE is available in Advanced sessions when enabled. Selected-agent editor integration is available only when visible in the current session; its owning Pi integration requirements remain Partial pending completed exact-head review, CI, and deployed verification.

## What I can do

I can open a browser-hosted VS Code workspace through the authenticated Worker proxy. The editor belongs to the backend session, not to a separate bucket-stable workstation. I can navigate code, edit files, use integrated terminals, inspect diffs, and invoke Codeflare-owned review entry points.

Depending on the selected agent and mode, the sidebar can pass the active selection, diagnostics, native diffs, or an Inline Chat request to the session agent. When visibly enabled in the current session, Pi can expose Codeflare Chat, Inline Chat, and Review with Codeflare. Claude sessions use the pinned official panel. Browser IDE integrated terminals remain separate from Classic and Herdr terminal topology.

## Why the boundary matters

Continuity is deliberately narrow. Theme, selected web keyboard layout, Explorer expansion, open files, and a bounded extension-intent manifest may restore. Authentication, SecretStorage, extension bytes, editor databases, chat history, logs, and arbitrary User settings remain ephemeral. The fixed workspace confines browser navigation. It does not sandbox trusted terminal commands or extensions.

## Try it

Create or open an Advanced session with the VS Code workspace. Select the smallest relevant source block, invoke the available Codeflare review or agent action, and inspect the native diff before accepting anything. Then restart the session and compare which approved continuity fields return and which ephemeral state correctly disappears.

Source anchors: `sdd/spec/browser-ide.md` REQ-IDE-001 through REQ-IDE-016 and the Browser IDE sections in `documentation/lanes/container.md`.
