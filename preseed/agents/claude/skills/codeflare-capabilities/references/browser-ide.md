# Browser VS Code, native agent workflows, and extensions

## What I can do

I can work in a full browser-hosted VS Code experience backed by code-server and Code OSS. The user gets the Explorer, search, source control, diffs, editors, settings, integrated terminals, themes, keyboard layouts, and extension host they already know.

I work inside that same workspace. Codeflare Chat can carry a continuing agent conversation. Inline Chat can use the invoking editor, selection, diagnostics, explicit references, unsaved content, and bounded recent history, then return native text edits to the correct document. Review with Codeflare can attach a workspace file from the Explorer or editor. The integrated terminal keeps the session's root access and complete engineering toolchain.

Codeflare's skills and specialist workflows remain available through the agent. User-selected Open VSX extensions can return through a bounded, versioned manifest, while the packaged agent inventory stays immutable and verified. The editor starts from a clean fixed workspace and suppresses account setup and trust prompts that would otherwise block an isolated session.

## Where the boundary sits

The Browser IDE belongs to one backend session. It is not a permanent workstation shared by every container. Safe continuity can preserve theme, web keyboard layout, Explorer expansion, open files, and the bounded extension selection.

Credentials, authentication, SecretStorage, extension runtime databases, chat history, logs, and arbitrary User settings remain temporary. Root access is confined to the isolated session, but it is still root. A trusted terminal command can change the filesystem, and a trusted extension can execute code. Hiding the menu item would not change that fact.

## Try it

Open a repository in Browser VS Code, select one failing function, ask Codeflare Inline Chat for the smallest tested correction, inspect the native diff, then use the integrated terminal to follow exact-head CI.

Other useful requests:

- “Open the selected file in Browser VS Code and explain the failing path using editor references.”
- “Use Inline Chat on this selection, then show me the native diff before saving.”
- “Restore my preferred Open VSX extension set without persisting extension secrets.”

Source anchors: `sdd/spec/browser-ide.md` REQ-IDE-001/002/005/006/007/009/011/012/014/015/016/019/020/024/025/033/035/036 and `documentation/lanes/container.md`.
