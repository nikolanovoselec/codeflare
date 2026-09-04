# Getting Started

You have a full Linux workspace in a browser. Your selected agent waits in the first terminal, five Bash tabs sit behind it, and Browser VS Code is there when editing through a terminal becomes stubborn rather than efficient.

## First session

1. Create a session from the Dashboard.
2. Open it when startup reports ready.
3. Ask the agent:

   > What can you do?

4. Pick one offered deep dive, or give it a repository and objective.
5. Push source work you need to keep, then stop the session when you are done.

The question in step three is not small talk. It opens the guided capability tour and gives you practical tasks to try. You can skip it when you already know the job.

A useful first objective:

> Clone my repository, read its project rules, explain the current architecture, and identify the smallest safe first change. Do not deploy anything.

## Terminal workspace

Tab 1 runs your selected agent. Tabs 2 through 6 are Bash terminals. Drag tabs to reorder them, or tile two to four terminals so the agent, logs, tests, and system monitor can stay visible together.

Every terminal has voice input where the browser supports the Web Speech API. The mobile controls also expose terminal key sequences that are miserable to type on glass. Firefox currently hides voice input because it does not implement that browser API.

The session works from desktop, tablet, or phone. Reopening a live session attaches to its existing terminal process rather than starting another one.

## Files and synchronization

Included files synchronize to your private storage every 15 minutes. **Sync now** starts an immediate user-owned synchronization across your running sessions, and stopping a session starts one final bounded sync before the container is destroyed.

Workspace synchronization follows your configured policy and is disabled by default. Git remains the reliable authority for source code, so push work you cannot afford to lose. A sync that never included the workspace cannot rescue an unpushed branch. Wishful thinking is not a backup format.

The Storage browser works without a running container. Use it to browse, upload, download, safely preview, or delete files in Vault, Uploads, Temporary, and Workspace.

## Vault and memory

Open **Vault** from the header to use the SilverBullet knowledge workspace. It stores ordinary Markdown notes, journal entries, quick notes, screenshots, PDFs, plans, and references. Wikilinks connect related material, and pasted attachments stay beside the note that owns them.

Codeflare’s memory subsystem continuously persists decisions, corrections, observations, debugging discoveries, and source references in the Vault. These captures join the cumulative knowledge graph as permanently queryable content, unless you remove them. I retrieve that history automatically in future sessions and connect it to current requirements, incidents, plans, and code.

Use **Quick Note** for material you want to capture yourself. Use **Sync now** after an important Vault edit when waiting for the next scheduled cycle would be foolish.

## Enterprise sessions

Every Enterprise session runs in advanced mode with the full Codeflare capability scope. Pi is the primary Enterprise agent. Other supported runtimes remain selectable when enabled by administrators, with shared policy and portable skills projected where compatible. Commands, tools, and editor integrations follow each runtime’s native capabilities.

Advanced work includes Spec-Driven Development, behavioral Test-Driven Development, Graphify queries, specialist review, Todo coordination, Browser Run, durable memory, and exact-head CI and release workflows. The agent activates the relevant machinery for the task. You do not need to memorize a command catalog before doing useful work.

In Enterprise deployments, supported reusable credentials remain outside the container and Codeflare injects authorization at approved Worker-side boundaries. The shell may contain non-secret placeholders so ordinary command-line clients still work.

## Settings worth checking

- **Push & Deploy:** Connect approved GitHub and Cloudflare identities for repository and deployment work.
- **Auto-sleep:** Choose how long an idle session remains alive. Typing counts as activity; background reconnect traffic does not.
- **Fast Start:** Keep it on for the quickest terminal startup. Turn it off when you want installed Pi and Codex CLIs updated before readiness.
- **Accent color:** Entirely personal. Software is allowed one harmless preference.

## Next step

Open **Examples** for complete starter specifications, or read **Documentation / Toolchain** to build a GitHub Actions deployment for your own Cloudflare Worker. Better yet, hand Pi a real repository and one bounded objective. Tutorials are useful until they become procrastination with headings.
