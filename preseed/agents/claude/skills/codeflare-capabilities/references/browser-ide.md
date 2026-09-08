# Browser VS Code, native agent workflows, and extensions

Open the repository and stay close to the work. I give you a full browser-hosted VS Code workbench backed by code-server and Code OSS: Explorer, search, editors, source control, diffs, diagnostics, settings, and integrated terminals. You can watch files change, inspect the result, and edit directly.

The workbench uses the session's actual filesystem and toolchain. There is no separate copy of the project to keep aligned with the agent, and no remote IDE server for you to configure before you can participate.

## Read the change while it is being made

An agent conversation can explain a proposed correction; the editor lets you examine it. Open related files, follow references, inspect the diff, compare diagnostics, or run an approved command in the integrated terminal. You can keep the relevant code on screen while the investigation continues.

I bring the supported native agent experience into that workbench. Pi-selected sessions use Codeflare Chat and editor-context workflows; selected Claude sessions use their supported official extension integration. The selected supported integration determines which native actions are available. Your repository determines how the project is built, tested, and operated.

## Ask about the code in front of you

Where native Inline Chat is available, the invoking editor can supply the document, selection, diagnostics, explicit references, and unsaved content. You do not have to copy a function into a separate conversation and hope it remains aligned with the file.

Inline proposals belong to the editor's acceptance flow. Document identity, range, and version matter: an answer for one selection must not be applied to a different document or a newer edit. Broader panel and terminal work can change files directly within your approved scope; it is not the same transaction as accepting an inline proposal.

Review with Codeflare attaches a workspace file from the Explorer or editor. For a multi-file change, I keep the wider investigation in the appropriate conversation and make the resulting diffs inspectable.

## Your workbench preferences persist within scope

Themes, web keyboard layout, Explorer expansion, open-file resources, and supported extension choices have bounded continuity. I restore user-selected Open VSX extensions through a versioned manifest, rather than copying a live extension runtime wholesale between sessions. Managed company extensions can be reconciled alongside that user intent.

This preserves a familiar working surface without treating credentials, SecretStorage, extension databases, chat history, logs, package bytes, or arbitrary settings as durable personal files. Those have different ownership and security implications.

A selected extension can execute code. I make that trust decision explicit rather than suggesting that a browser-hosted editor makes extensions inert.

## A session-owned editor

I handle the editor process, readiness, authenticated HTTP and WebSocket proxying, and recovery around one backend session. The public workspace is fixed; browser-supplied folder selectors cannot choose an arbitrary location or another session's files. Ownership checks sit outside ordinary editor commands.

Inside the isolated environment, the terminal and trusted extensions remain powerful. Root access lets you and the agent use a real engineering toolchain. It does not make the editor a sandbox that can undo every action.

You can move between conversation, source, diagnostics, and shell while retaining a direct view of what is happening. The work stays inspectable at the speed it is being performed.
