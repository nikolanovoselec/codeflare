# Browser VS Code, native agent workflows, and extensions

## What I do

I work in a full browser-hosted VS Code experience backed by code-server and Code OSS. You get the Explorer, search, source control, diffs, editors, settings, integrated terminals, themes, keyboard layouts, and extension host you already know.

In supported Pi-selected sessions, I continue our conversation through Codeflare Chat. The Inline Chat integration is designed to use the invoking editor, selection, diagnostics, explicit references, unsaved content, and bounded recent history, then return native text edits to the correct document. Its deployed editor-selection and acceptance flow still needs verification; I do not promise those actions work in every session. In Review with Codeflare, I attach a workspace file from the Explorer or editor. I use the integrated terminal with the session's root access and complete engineering toolchain.

I use Codeflare's skills and specialist workflows through the agent. The platform restores user-selected Open VSX extensions through a bounded, versioned manifest, while the packaged agent inventory stays immutable and verified. I start from a clean fixed workspace whose editor suppresses account setup and trust prompts that would otherwise block an isolated session.

## Start from the code you are looking at

Where Inline Chat is available, select the function or diagnostic that needs attention and ask me about it. I use that editor context, including unsaved content, rather than making you copy a large file into a separate conversation. Review with Codeflare is useful when you want me to inspect a whole workspace file instead. For a change spanning several files, I keep the investigation in Codeflare Chat and use the native diffs to make the edits reviewable.

Native Inline Chat proposals use the editor's acceptance flow; I edit files directly from panel and terminal work within your approved scope. I help you compare the diff with the intended behavior and carry the result into the repository's verification workflow. An editor suggestion is a starting point, not proof that a fix works.

## Where the boundary sits

The Browser IDE belongs to one backend session. It is not a permanent workstation shared by every container. Its continuity layer preserves theme, web keyboard layout, Explorer expansion, open files, and the bounded extension selection where supported.

Credentials, authentication, SecretStorage, extension runtime databases, chat history, logs, and arbitrary User settings remain temporary. Root access is confined to the isolated session, but it is still root. A trusted terminal command can change the filesystem, and a trusted extension can execute code. Hiding the menu item would not change that fact.

## Try it

After selecting the failing function in Browser VS Code, paste this request:

> Use Inline Chat to propose the smallest tested correction for this selection. Show me the native diff before saving, then guide me through exact-head CI in the integrated terminal.

Other useful requests:

- “Open the selected file in Browser VS Code and explain the failing path using editor references.”
- “Use Inline Chat on this selection, then show me the native diff before saving.”
- “Restore my preferred Open VSX extension set without persisting extension secrets.”
