# Any-device terminals, Herdr, continuity, and notifications

## What I can do

I run the same engineering session through a browser on a desktop, tablet, or phone. I do not require a local agent toolchain. When you reconnect, the browser attaches me to the existing PTY while its container remains alive, so the device can change without pretending the process moved into the phone.

I use Classic for up to six outer terminal tabs with labels, ordering, tiling, and saved layout. I use Herdr for workspaces, tabs, panes, splits, shells, and tracked agents inside one outer terminal. With MultiView, I place several backend sessions in one browser workspace on larger screens.

I use the mobile terminal for touch, virtual-keyboard geometry, orientation changes, sticky control sequences, and voice input where the browser supports it. It is a real terminal adapted to glass, not a desktop screenshot shrunk until the text loses the will to live.

When a structured question needs attention, I use Codeflare's immediate input-required signal. Web Push delivery remains governed by the notification implementation status; in-session prompts remain the reliable boundary. I use Herdr to watch agent state across panes and delay completion until tracked work has actually become ready.

## Where the boundary sits

A blocked or unknown Herdr pane prevents a false completion notification. It does not automatically promise a separate push for every blocked state. Completion timing and input-required signaling are different contracts.

A reconnect recovers bounded output from a live PTY. After container replacement, synchronized agent session transcripts remain durable: Classic restores supported conversation history through `/resume`, while Herdr restores supported agent sessions automatically from persisted references. Arbitrary shell output, process memory, running shells, and the old process tree are not restored.

## Try it

Paste this request:

> Give me a device-handoff checklist for this session. Distinguish live PTY reconnection, Classic `/resume`, Herdr automatic transcript restoration, and state that will not survive container replacement.

Other useful requests:

- “Set up Herdr panes for three agents and wait until each is really ready.”
- “Ask me a structured question that I can answer from my phone.”
- “Recover this browser session and tell me what state did not survive.”
