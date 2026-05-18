# Getting Started

You have a full Linux container in your browser. An AI agent is loaded and waiting in Tab 1. Five more terminals behind it. Your files sync to cloud storage that outlives every container you'll ever start (every 15 minutes plus a final sync on stop, with a Sync-now button when you want it sooner). Your notes sync too. Your agent remembers prior sessions. Your hands are free if you want them to be. Here's what to do with all of that.

---

## The 30-Second Version

1. **Create a session** from the Dashboard - pick your agent
2. **Open it** - Tab 1 is ready, no loading screen, no "please wait"
3. **Tell your agent** to clone a repo and start working on it
4. **Work** - the agent has full root access. It can read, write, build, test, and deploy. Let it cook.
5. **Stop when you're done** - final sync happens automatically. The container dies. Your files don't.

That's it. The rest of this page is for the curious.

---

## What's in Each Tab

| Tab | What | Why it's there |
|-----|------|---------------|
| 1 | Your AI agent | Pre-warmed during container startup. Already loaded when you click Open. |
| 2-6 | bash | Five blank canvases. Run whatever you want. I don't judge. |

Tabs 2-6 are draggable. Rearrange them however you want - save your layout using Bookmarks.

**Tiling mode** - button in the top-right corner. View 2-4 terminals side by side instead of switching tabs. Agent in one pane, lazygit in another, htop keeping an eye on things in the third. Once you tile, you don't go back.

---

## Voice Input

There's a mic button in every terminal - bottom-right corner on desktop, in the floating controls on mobile. Tap it, talk, and what you say goes straight into the terminal as if you typed it. Web Speech API, no extension needed, no key to configure. It's the fastest way to brief an agent from a phone without thumb-typing a paragraph.

Browser support: Chrome, Edge, Safari (recent). Firefox does not implement the Web Speech API yet, so the button is hidden there.

---

## Your Files Persist (You Don't Have to Think About It)

A daemon syncs your home directory to Cloudflare R2 every 15 minutes. When you stop a session, a final sync runs before the container self-destructs. When you start a new one, everything is restored. If you want a sync to happen sooner - say, you uploaded a file in the R2 panel and want a running container to see it now - hit the **Sync now** button (cloud icon) at the top of the R2 panel. It fans out to every running session you own; if you have none, you'll see a "no running sessions to sync" notice. Even if a session dies before you remember to `git push`, R2 sync has got your back. Sync conflicts will happen - Codeflare cleans them up automatically on the next cycle. Don't worry about it.

What carries over: `.gitconfig`, agent settings and memory (e.g. `~/.claude/`, `~/.gemini/`, `~/.opencode/`), your vault, your uploads, and anything else in your home directory. Your **workspace** (`~/workspace/`) is excluded from sync by default - clone fresh in each session. You can opt-in to workspace sync in Settings, but it is not recommended: bigger repos slow every sync cycle, and a fresh clone is more reliable than restoring a half-built node_modules tree from R2.

The **R2 File Browser** on the Dashboard lets you browse, upload, download, and delete synced files between sessions - without starting a container. Vault, Uploads, and Temporary are surfaced as special folders alongside your Workspace.

---

## Your Second Brain: The Vault

`~/Vault/` is a persistent note store backed by [SilverBullet](https://silverbullet.md), an Obsidian-compatible markdown editor running inside your container. Open it from the **Vault** button in the header (next to the storage panel). It loads in a new tab.

What it's for:

- Long-running notes that survive every container teardown
- Pasted screenshots, PDFs, anything you want to keep
- Daily journal entries (`Journal: Today` button)
- Quick capture (`Quick Note` button - the timestamped note lands in `Inbox/`)
- An automatic 15-prompt session capture so a future agent can look up what was decided in a prior conversation

Bisync mirrors the vault to R2 every 15 minutes - same plumbing as the rest of `~`. If you want an edit you just made in SilverBullet pushed to R2 right now (or want a freshly-pasted note picked up from another device), hit the Sync-now button on the R2 panel and it fans out to every running session. Vault contents on a fresh container appear as soon as the first bisync round completes.

There's a built-in dashboard at the vault root (`Index`) that surfaces recent quick notes, recent journal entries, open tasks, and recently modified pages. Wikilinks (`[[Concept Name]]`) cross-reference notes inside the vault. Image and PDF pasting works (`Ctrl+V` or drag-drop into a note); the file is written next to the note you are editing (a Quick Note in `Inbox/2026-05-18/` puts attachments in the same folder).

---

## Pro Mode (Advanced Sessions)

If you picked the **Claude Code** agent and enabled advanced mode on the session, you get a bigger toolbelt:

- **`/sdd`** - spec-driven development. `/sdd init` bootstraps a `sdd/` folder with REQ-tracked requirements for the project you're in. The agent works against the spec, not vibes.
- **`/review`** - multi-perspective static-analysis review. Spawns six parallel agents (security, architect, code-reviewer, refactor-cleaner, tdd-guide, doc-updater), cross-references findings, filters against your ADRs, then runs them through a Reality Filter before triaging interactively with you. Use `/review --diff` during active work or `/review --all` for a whole-codebase pass. Add `--deep` to verify SDD requirements against their implementation, or `--verify-high` to cross-check HIGH/CRITICAL findings with external LLMs (GPT + Gemini). Distinct from the auto review agents that fire on PR-boundary; `/review` is on-demand and heavier.
- **`/debug`** - systematic debugging workflow when something is broken and you can't tell why.
- **`/deploy`** - drive a release through CI to Cloudflare.
- **`/brainstorm`** - structured brainstorming with the agent.
- **Knowledge graph (graphify)** - the agent indexes every repo you clone and your vault into a unified graph. When you ask "what depends on X" or "where is Y decided", it queries the graph instead of grepping blindly.
- **Auto review agents** - when you open a pull request from `develop` to `main`, code-reviewer, spec-reviewer, and doc-updater fire automatically against the diff. They report findings; they don't auto-merge.

Pro mode also installs hook plugins that capture session memory, gate destructive actions, and keep your spec in sync. None of it requires configuration - it's all preseeded into a fresh advanced session.

The other agents (Codex, Gemini, Copilot, OpenCode, Bash) get the same rules and agent definitions, but the slash-command workflow and graph integration are tuned for Claude Code.

---

## Settings Worth Knowing About

The cog icon in the header opens Settings.

- **Push & Deploy** - connect GitHub and Cloudflare once. Every session starts pre-authenticated. `git push`, `gh`, and `wrangler deploy` just work.
- **Auto-sleep timeout** - default 15 minutes. Paid tiers can extend to 30m, 1h, or 2h. Sleep is input-aware: typing keeps the session alive, background WebSocket reconnects do not.
- **Fast Start** - on by default. Agent auto-updates are disabled so the terminal boots instantly. Toggle off if you want bleeding-edge agent versions on every session.
- **Accent color** - personal preference. Persists across sessions.

---

## What Now

Four paths. Pick whichever matches your personality:

1. **Check the Examples** - copy-paste prompts from beginner to expert. Your agent does the work, you take the credit.
2. **Read the Documentation** - architecture, sync internals, terminal features, vault mechanics, troubleshooting. It's thorough.
3. **Try Pro mode on a real project** - open an advanced session, clone a repo, run `/sdd init`, and let the spec-driven loop shape the work.
4. **Just wing it** - create a session, clone something, and tell your agent what you want. Worst case, you lose an ephemeral container. Best case, you ship before lunch.

**Shipping soon?** Configure Push & Deploy in Settings to connect your GitHub and Cloudflare accounts. Do it once, and every session starts pre-authenticated.

Examples and docs are in the `tutorials/` folder, or browse them in the R2 File Browser on the Dashboard.
