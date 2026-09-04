# Getting Started

You have a full Linux container in your browser. An AI agent is loaded and waiting in Tab 1. Five more terminals behind it. Files included by your sync settings move to cloud storage that outlives every container you'll ever start (every 15 minutes plus a final sync on stop, with a Sync-now button when you want it sooner). Your notes sync too. I recall captured context from prior sessions. Your hands are free if you want them to be. Here's what to do with all of that.

---

## The 30-Second Version

1. **Create a session** from the Dashboard - pick your agent
2. **Open it** - Tab 1 is ready, no loading screen, no "please wait"
3. **Tell your agent** to clone a repo and start working on it
4. **Work** - I have full root access. I can read, write, build, test, and deploy. Let me cook.
5. **Stop when you're done** - final sync happens automatically. The container dies. Files included in synchronization persist.

That's it. The rest of this page is for the curious.

---

## What's in Each Tab

| Tab | What | Why it's there |
|-----|------|---------------|
| 1 | Your AI agent | Pre-warmed during container startup. Already loaded when you click Open. |
| 2-6 | bash | Five blank canvases. Run whatever you want. I don't judge. |

Tabs 2-6 are draggable. Rearrange them however you want.

**Tiling mode** - button in the top-right corner. View 2-4 terminals side by side instead of switching tabs. Agent in one pane, lazygit in another, htop keeping an eye on things in the third. Once you tile, you don't go back.

---

## Voice Input

There's a mic button in every terminal - bottom-right corner on desktop, in the floating controls on mobile. Tap it, talk, and what you say goes straight into the terminal as if you typed it. Web Speech API, no extension needed, no key to configure. It's the fastest way to brief an agent from a phone without thumb-typing a paragraph.

Browser support: Chrome, Edge, Safari (recent). Firefox does not implement the Web Speech API yet, so the button is hidden there.

---

## Your Files Persist (You Don't Have to Think About It)

A daemon syncs included home-directory content to Cloudflare R2 every 15 minutes. When you stop a session, a final sync runs before the container self-destructs. When you start a new one, included content is restored. If you want a sync sooner, for example after uploading a file in the R2 panel, hit the **Sync now** button (cloud icon) at the top of that panel. This user-owned action fans out to every running session you own; if you have none, you'll see a "no running sessions to sync" notice. Synchronization is periodic and conflicts can occur. Codeflare resolves them on a later cycle.

What carries over includes `.gitconfig`, supported agent settings and memory, your vault, and your uploads, subject to the documented filters. Your **workspace** (`~/workspace/`) is excluded from sync by default, so R2 cannot recover unpushed workspace content in that mode. Clone fresh in each session. You can opt in to full or metadata workspace sync in Settings, but a fresh clone is usually more reliable than restoring a half-built dependency tree.

The **R2 File Browser** on the Dashboard lets you browse, upload, download, and delete synced files between sessions - without starting a container. Vault, Uploads, and Temporary are surfaced as special folders alongside your Workspace.

---

## Your Second Brain: The Vault

`~/Vault/` is a persistent note store backed by [SilverBullet](https://silverbullet.md), an Obsidian-compatible markdown editor running inside your container. Open it from the **Vault** button in the header (next to the storage panel). It loads in a new tab.

What it's for:

- Long-running notes that survive every container teardown
- Pasted screenshots, PDFs, anything you want to keep
- Daily journal entries (`Journal: Today` button)
- Quick capture (`Quick Note` button - the timestamped note lands in `Inbox/`)
- Automatic session capture every 20 real user messages, plus an uncaptured tail after resume, so I can look up prior decisions in a future session

Bisync mirrors the vault to R2 every 15 minutes - same plumbing as the rest of `~`. If you want an edit you just made in SilverBullet pushed to R2 right now (or want a freshly-pasted note picked up from another device), hit the Sync-now button on the R2 panel and it fans out to every running session. Vault contents on a fresh container appear as soon as the first bisync round completes.

There's a built-in dashboard at the vault root (`Index`) that surfaces recent quick notes, recent journal entries, open tasks, and recently modified pages. Wikilinks (`[[Concept Name]]`) cross-reference notes inside the vault. Image and PDF pasting works (`Ctrl+V` or drag-drop into a note); the file is written next to the note you are editing (a Quick Note in `Inbox/2026-05-18/` puts attachments in the same folder).

---

## Pro Mode (Advanced Sessions)

If you picked the **Claude Code** agent and enabled advanced mode on the session, you get a bigger toolbelt:

- **`/sdd`** - I use `/sdd init` to bootstrap a `sdd/` folder with REQ-tracked requirements for the project you're in, then work against the specification instead of vibes.
- **`/review`** - I use `/review` to launch applicable specialist perspectives, cross-reference findings, filter against your ADRs, apply the Reality Filter, and triage interactively with you. I use `--diff` during active work, `--all` for a whole-codebase pass, `--deep` to verify SDD requirements against implementation, and `--verify-high` for configured external cross-checks. This remains distinct from automatic PR-boundary review.
- **`/debug`** - I use `/debug` for systematic root-cause analysis when something is broken and the cause is unclear.
- **`/deploy`** - I use `/deploy` to drive a release through CI to Cloudflare.
- **`/brainstorm`** - I use `/brainstorm` for structured ideation.
- **Knowledge graph (Graphify)** - I use Graphify to index supported repository and Vault content into a unified graph, then answer structural questions through graph queries instead of grepping blindly.
- **Auto review agents** - at an eligible protected pull-request boundary, I use the classifier to launch the smallest required review set for the changed scope. Reviewers report findings; they don't auto-merge.

Preseeded hook plugins capture session memory, gate destructive actions, and keep your specification synchronized. I work under those controls without requiring extra configuration in a fresh advanced session.

Agent runtimes receive runtime-specific projections and do not all use identical rules, tools, or workflow surfaces. Use the capabilities exposed by the selected runtime rather than assuming Claude-specific commands exist everywhere.

---

## Settings Worth Knowing About

The cog icon in the header opens Settings.

- **Push & Deploy** - connect GitHub and Cloudflare once. Every session starts pre-authenticated. `git push`, `gh`, and `wrangler deploy` just work.
- **Auto-sleep timeout** - default 15 minutes. Paid tiers can extend to 30m, 1h, or 2h. Sleep is input-aware: typing keeps the session alive, background WebSocket reconnects do not.
- **Fast Start** - on by default. Agent auto-updates are disabled so the terminal boots instantly. Toggle it off to update installed Pi and Codex CLIs explicitly before the terminal becomes ready; startup logs show their before and after versions or a failure.
- **Accent color** - personal preference. Persists across sessions.

---

## What Now

Four paths. Pick whichever matches your personality:

1. **Check the Examples** - copy-paste prompts from beginner to expert. I do the work; you take the credit.
2. **Read the Documentation** - architecture, sync internals, terminal features, vault mechanics, troubleshooting. It's thorough.
3. **Try Pro mode on a real project** - open an advanced session, clone a repo, run `/sdd init`, and let the spec-driven loop shape the work.
4. **Just wing it** - create a session, clone something, and tell your agent what you want. Worst case, you lose an ephemeral container. Best case, you ship before lunch.

**Shipping soon?** Configure Push & Deploy in Settings to connect your GitHub and Cloudflare accounts. Do it once, and every session starts pre-authenticated.

Examples and docs are in the `tutorials/` folder, or browse them in the R2 File Browser on the Dashboard.
