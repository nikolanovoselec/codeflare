# Any-device terminals, Herdr, continuity, and notifications

Your investigation can stay open while you leave the desk. I keep the engineering environment in the backend and let you reach it from a desktop, tablet, or phone. The device needs a browser—not another checkout, agent installation, or development toolchain.

These are real terminals connected to real PTYs. You can run a shell, follow an agent, inspect logs, arrange parallel work, and intervene directly. I handle authenticated transport, attachment, resizing, reconnection, and display recovery around that work.

## Arrange the work at the right scale

**Classic** gives you up to six outer terminal tabs within a session, with labels, ordering, tiling, and saved layout. A shell can sit beside an agent conversation without starting another backend environment.

**Herdr** owns the organization inside one outer terminal: workspaces, tabs, panes, splits, shells, and tracked agents. It is useful when you want several ongoing workstreams in view. In a live Herdr workspace, I can help arrange panes, inspect supported agent state, steer work within your scope, and collect results while preserving your focus.

**MultiView** puts separate backend sessions into one larger-screen view. It changes how you see them; it does not merge their files, identity, or runtime ownership. Desktop and tablet layouts support it; a phone uses its own terminal experience.

Classic and Herdr are session choices, not two competing managers of the same topology. I keep those ownership boundaries explicit so a split, a tab, and a new session mean what you expect.

## The phone gets terminal controls, not a scaled-down desktop

Touch input, sticky control sequences, virtual-keyboard geometry, orientation changes, and supported voice input address the parts of terminal work that are awkward on glass. I account for the keyboard and visible viewport rather than leaving the prompt hidden behind them.

You can return to a live session from another device and answer a structured question or inspect the current state. The work has not moved into the phone. Authentication and session ownership still govern the connection, and the backend must remain alive for its processes to continue.

On a larger screen, visible panes own their connections and resize behavior. Reconnection and recovery have explicit lifecycles, so an old browser view should not become the authority over a newer attachment.

## Know when your attention is needed

I distinguish a question that needs an answer from work that appears to have finished. Supported structured questions produce an immediate input-required signal. Herdr tracks supported agent readiness across panes before producing its delayed completion signal; a working, blocked, or unknown state must not be mistaken for completion.

Away notifications depend on device permission, enrollment, and the configured Web Push service. Herdr's completion producer is different from Classic terminal behavior, and accepted push delivery is not a guarantee that a device displayed it. In-session prompts remain the dependable place to see what is waiting for you.

This lets you step away without pretending that silence means success—or that every line of output deserves an interruption.

## Reconnect and restore are different operations

While the container and PTY remain alive, I can reconnect the browser and restore bounded terminal output. After container replacement, the process itself is gone.

Supported synchronized agent transcripts can survive that replacement. Classic restores conversation history through `/resume`; Herdr restores supported agent sessions from persisted references. That is conversation continuity, not resurrection of arbitrary shell output, process memory, or the old process tree.

I help you choose the right arrangement and preserve the right state. You remain able to see the work, interrupt it, and take over a shell instead of surrendering the whole environment to an opaque background task.
