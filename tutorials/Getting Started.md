# Getting Started

You have a full Linux container in your browser. An AI agent is loaded and waiting in Tab 1. Five more terminals behind it. Your files sync every 60 seconds to cloud storage that outlives every container you'll ever start. Here's what to do with all of that.

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

## Your Files Persist (You Don't Have to Think About It)

A daemon syncs your home directory to Cloudflare R2 every 60 seconds. When you stop a session, a final sync runs before the container self-destructs. When you start a new one, everything is restored. Even if a session dies before you remember to `git push`, R2 sync has got your back. Sync conflicts will happen - Codeflare cleans them up automatically on the next cycle. Don't worry about it.

What carries over: `.gitconfig`, agent settings and memory (e.g. `~/.claude/`, `~/.gemini/`, `~/.opencode/`), and anything else in your home directory.

The **R2 File Browser** on the Dashboard lets you browse, upload, download, and delete synced files between sessions - without starting a container.

---

## What Now

Three paths. Pick whichever matches your personality:

1. **Check the Examples** - copy-paste prompts from beginner to expert. Your agent does the work, you take the credit.
2. **Read the Documentation** - architecture, sync internals, terminal features, troubleshooting. It's thorough.
3. **Just wing it** - create a session, clone something, and tell your agent what you want. Worst case, you lose an ephemeral container. Best case, you ship before lunch.

Examples and docs are in the `tutorials/` folder, or browse them in the R2 File Browser on the Dashboard.
