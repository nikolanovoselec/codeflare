# Vault & SilverBullet

This vault is your personal knowledge layer inside Codeflare. Anything you write here persists across sessions (synced to R2) and feeds the unified knowledge graph that your AI agent queries before answering you.

## Why a vault?

Codeflare sessions are ephemeral - the container is rebuilt every time you start one. Without a vault, every conversation starts cold: prior decisions, architectural notes, snippets, and reading you did yesterday are gone.

The vault solves that. It is the one place where:

- Notes you write survive across sessions.
- The agent's transcript captures (one file per ~15 prompts) land in `Raw/Sessions/`.
- File edits trigger re-extraction into the knowledge graph - so the agent can find what you wrote when you ask it questions later.

## What is SilverBullet?

[SilverBullet](https://silverbullet.md) is a self-hosted, markdown-first note editor. It runs as a small server inside your Codeflare container on `127.0.0.1:3030`, fronted by the Codeflare auth proxy so only you can reach it. Click the **Vault** button in the Codeflare header to open it.

Reasons to use it (instead of just dropping .md files in a folder):

- **Live preview & inline editing**. Markdown renders in place; you edit and read in the same view.
- **Wikilinks** (`[[Page Name]]`) auto-resolve and auto-suggest. Build a web of notes without managing folders.
- **Backlinks**. Every page shows what links to it.
- **Queries**. Embed `${query[[...]]}` blocks that auto-populate lists (recently modified pages, open tasks, etc.). The dashboard on [[Index]] uses this.
- **Plugs** (plugins). PDF viewer, treeview sidebar, GitHub integration, graph view - all preseeded in `Library/Codeflare/`.
- **Drag-and-drop**. Drop images, PDFs, or text snippets directly into a page.

## How to use it

### Capture a quick note

On [[Index]], click the **Quick Note** button. SilverBullet creates a timestamped page under `Inbox/`. Write whatever, hit Esc when done. The note shows up in "Recent quick notes" on the dashboard.

### Create a regular note

Press `Ctrl/Cmd-K` (or click anywhere in the page title bar) to open the page switcher, type a new name, press Enter. You get a blank page. To link to it from anywhere else, type `[[That Name]]`.

Suggested folder layout:

- `Notes/` - durable, organized prose. Concept notes, runbooks, references.
- `Inbox/` - quick captures you'll process later.
- `Journal/` - daily entries (SB has a "Journal: Today" button).
- `Raw/Pasted/` - drop screenshots, PDFs, anything binary here.

### Ask your coding agent to capture for you

You don't have to switch to SilverBullet to file a note. While you're chatting with your coding agent, say any of:

- "Take a note: <thing>"
- "Note this down: <thing>"
- "Document this decision: <thing>"
- "Remind me to <thing>"
- "Save this: <thing>"

The agent writes the file under the right `Notes/<Category>/` subfolder (`Reminders/`, `Decisions/`, `References/`, `Reading/`, `Debugging/`, `Projects/...`), with a dated filename and PascalCase `[[wikilinks]]` for any concepts. The note shows up in SilverBullet within a couple seconds and in the knowledge graph within ~60 seconds. Reports just the file path back; no chat sprawl.

### Drop a PDF or screenshot

Drag the file into the SilverBullet window. SB writes it to `Raw/Pasted/` and inserts an embed. The PDF plug renders it inline; images render as previews.

### Use the agent's memory

Anything you write in the vault gets extracted into the knowledge graph within ~60 seconds. After that, the agent can find it:

- Ask "what did I write about [topic]?" - the agent queries the graph.
- Reference a concept in `[[WikiLinks]]` (PascalCase) - those become first-class graph nodes that connect across vault notes AND across code in your projects.
- File paths and code symbols stay as prose - the graph dedups by exact wikilink label, so PascalCase concepts unify cleanly without false collisions.

### Examples

- **Decision log**: write `Notes/Decisions/2026-05-17-deno-vs-bun.md`. Use `[[Deno]]` and `[[Bun]]` as wikilinks. Later ask the agent "remind me why we picked X" - it surfaces the note.
- **API reference dump**: paste a third-party API doc into `Notes/References/Stripe-Webhooks.md`. Agent can pull from it when writing code.
- **Reading notes**: drop a PDF in `Raw/Pasted/`, write a summary in `Notes/Reading/Title.md` linking to it. Graph connects the summary to whatever concepts you wikilinked.
- **Project journal**: daily entries under `Journal/`. Use the "Journal: Today" button on [[Index]] to create one.

## Vault structure

| Path | Owner | Purpose |
|------|-------|---------|
| `Index.md` | preseed (overwritten each boot) | Dashboard - quick notes, journal, tasks, recently modified |
| `README.md` | preseed (overwritten each boot) | This file |
| `CONFIG.md` | preseed (overwritten each boot) | SilverBullet runtime config (Library/Std federation) |
| `STYLES.md` | preseed (overwritten each boot) | Codeflare theme |
| `Notes/` | you | Curated prose. Write freely. |
| `Journal/` | you (via SB button) | Daily entries. |
| `Inbox/` | you (via SB button) | Quick captures. |
| `Raw/Sessions/` | agent | Transcript captures, ~one per 15 prompts. Don't hand-edit. |
| `Raw/Pasted/` | you | Drag-drop zone for PDFs, images, anything. |
| `Library/Codeflare/` | preseed (overwritten each boot) | Bundled SB plugs (PDF, treeview, github, graph). |
| `Library/Std/` | federated from silverbullet.md on first browser open | SB's standard widget/template library. Required for the dashboard. |
| `graphify-out/` | graphify CLI | Vault knowledge graph (build output - never edit). |
| `.silverbullet/` | editor (config.yaml overwritten each boot) | SB internals. |

## Hooks (cross-session memory)

Two hooks keep the graph current:

- **Transcript capture** fires every 15 chat prompts. A background extraction agent writes a session observation file into `Raw/Sessions/` and re-extracts it.
- **Vault monitor** polls the vault every 60 seconds for edits outside `Raw/Sessions/`. When it finds changes, the next chat prompt spawns an extraction agent that ingests the changed files into the graph.

You don't have to do anything. Just write notes; the graph updates itself.

## Things to avoid

- Don't delete files inside `Raw/Sessions/` (agent-managed; deletes are wasted - the extraction agent regenerates them on the next prompt).
- Don't write into `graphify-out/` (it's regenerated).
- Don't run `git init` in the vault. It syncs via rclone bisync, not git.
- Don't try to access SilverBullet from outside the Codeflare proxy. Port 3030 is bound to localhost; the proxy is the auth boundary.

If you delete preseed-managed files (`Index.md`, `README.md`, `CONFIG.md`, `STYLES.md`, `Library/Codeflare/*`), they're recreated on the next session boot. SB cannot be broken by deletion.
