# Getting Started

You have a full Linux container in your browser. An AI agent is loaded and waiting in Tab 1. Five more terminals behind it. Your files sync every 60 seconds to cloud storage that outlives every container you'll ever start. Here's what to do with all of that.

---

## The 30-Second Version

1. **Create a session** from the Dashboard - pick your agent
2. **Open it** - Tab 1 is ready, no loading screen, no "please wait"
3. **Clone a repo** in Tab 4 and point your agent at it
4. **Work** - the agent has full root access. It can read, write, build, test, and deploy. Let it cook.
5. **Stop when you're done** - final sync happens automatically. The container dies. Your files don't.

That's it. The rest of this page is for the curious.

---

## What's in Each Tab

| Tab | What | Why it's there |
|-----|------|---------------|
| 1 | Your AI agent | Pre-warmed during container startup. Already loaded when you click Open. |
| 2 | htop | Because "why is this slow" is always the first question. |
| 3 | yazi | Terminal file manager. Like `ls` and `cd` had a baby that actually cares about UX. |
| 4-6 | bash | Three blank canvases. Run servers, tests, scripts, or `cowsay`. I don't judge. |

Tabs 2-6 are draggable. Rearrange them however you want - your order is saved.

**Tiling mode** - button in the top-right corner. View 2-4 terminals side by side instead of switching tabs. Agent in one pane, dev server in another, htop keeping an eye on things in the third. Once you tile, you don't go back.

---

## Your Files Persist (You Don't Have to Think About It)

A daemon syncs your home directory to Cloudflare R2 every 60 seconds. When you stop a session, a final sync runs before the container self-destructs. When you start a new one, everything is restored. Even if a session dies before you remember to `git push`, R2 sync has got your back. Sync conflicts will happen - Codeflare cleans them up automatically on the next cycle. Don't worry about it.

What carries over: `.profile`, `.bashrc`, `.gitconfig`, `~/.claude/` (API keys, settings, project memory), and anything else in your home directory. Set your API key once. It's there forever.

The **R2 File Browser** on the Dashboard lets you browse, upload, download, and delete synced files between sessions - without starting a container.

---

## API Keys

Your agent needs a key. Set it once, sync takes care of the rest.

| Agent | First-Time Setup |
|-------|-----------------|
| Claude Unleashed | `echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.profile` |
| Codex | `echo 'export OPENAI_API_KEY=sk-...' >> ~/.profile` |
| Gemini | `echo 'export GEMINI_API_KEY=...' >> ~/.profile` |
| OpenCode | `echo 'export OPENAI_API_KEY=sk-...' >> ~/.profile` (or configure via `opencode` TUI - supports 75+ providers) |

Next session, the key is already there. Magic. (It's rclone, but magic sounds better.)

---

## What Now

Three paths. Pick whichever matches your personality:

1. **Check the Examples** - copy-paste prompts from beginner to expert. Your agent does the work, you take the credit.
2. **Read the Documentation** - architecture, sync internals, terminal features, troubleshooting. It's thorough.
3. **Just wing it** - create a session, clone something, and tell your agent what you want. Worst case, you lose an ephemeral container. Best case, you ship before lunch.

Examples and docs are in the `tutorials/` folder, or browse them in the R2 File Browser on the Dashboard.
