# Browser IDE and VS Code

An Advanced session can open a browser-hosted VS Code surface through the Worker proxy. The IDE belongs to that backend session, not to a bucket-stable editor machine. Codeflare prepares a clean workspace, selects the configured agent integration, and keeps browser IDE traffic behind the same authenticated session boundary as the terminal.

The editor supports ordinary code navigation plus Codeflare-owned review entry points. Depending on the selected agent and mode, the sidebar can pass the active selection, diagnostics, native diffs, or an Inline Chat request to the session agent. Browser IDE integrated terminals remain separate from Classic and Herdr terminal topology.

Try it when Browser IDE is available in the current Advanced session:

1. Create or open a session with the VS Code workspace.
2. Open a source file and select the smallest relevant block.
3. Use the Codeflare review or agent action exposed by the sidebar.
4. Inspect the proposed diff before accepting it.

Some editor continuity is durable, but the boundary is intentionally narrow. Open files, theme, keyboard layout, Explorer expansion, and a bounded extension-intent manifest may restore. Live editor databases, authentication, SecretStorage, extension bytes, chat state, and arbitrary settings remain ephemeral.

Source anchors: `sdd/spec/browser-ide.md` REQ-IDE-001 through REQ-IDE-016 and `documentation/lanes/container.md` Browser IDE sections.
