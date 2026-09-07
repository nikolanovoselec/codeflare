# Any-device terminals, Herdr, continuity, and notifications

## What I do

I run the same engineering session through a browser on a desktop, tablet, or phone. I do not require a local agent toolchain. When you reconnect, the browser attaches me to the existing PTY while its container remains alive, so the device can change without pretending the process moved into the phone.

I use Classic for up to six outer terminal tabs with labels, ordering, tiling, and saved layout. I use Herdr for workspaces, tabs, panes, splits, shells, and tracked agents inside one outer terminal. With MultiView, I place several backend sessions in one browser workspace on larger screens.

I use the mobile terminal for touch, virtual-keyboard geometry, orientation changes, sticky control sequences, and voice input where the browser supports it. It is a real terminal adapted to glass, not a desktop screenshot shrunk until the text loses the will to live.

When a structured question needs attention, I use Codeflare's immediate input-required signal. I do not promise Web Push delivery; in-session prompts remain the reliable way to see a question. I use Herdr to watch agent state across panes and delay completion until tracked work has actually become ready.

## How I use the workspace with you

For a focused bug fix, one terminal may be enough. For a longer investigation, I help arrange a shell beside the agent conversation in Herdr, or keep separate backend sessions visible in MultiView on a larger screen. You can follow the work without repeatedly swapping away from the error you are trying to understand.

If you leave your desk, reconnect from your phone to the live session and answer the question that is holding up the task. I keep the engineering work in the backend; the phone is a way to reach it, not a machine that needs its own checkout and toolchain. Browser and notification support determine which attention signals you receive, so I do not tell you to rely on a push that may not arrive.

## Where the boundary sits

A blocked or unknown Herdr pane prevents a false completion notification. It does not automatically promise a separate push for every blocked state. Completion timing and input-required signaling are different contracts.

A reconnect recovers bounded output from a live PTY. After container replacement, synchronized agent session transcripts remain durable: Classic restores supported conversation history through `/resume`, while Herdr restores supported agent sessions automatically from persisted references. Arbitrary shell output, process memory, running shells, and the old process tree are not restored.

## Try it

Paste this request:

> Give me a device-handoff checklist for this session. Distinguish live PTY reconnection, Classic `/resume`, Herdr automatic transcript restoration, and state that will not survive container replacement.

Other useful requests:

- “Set up Herdr panes for three agents and wait until each is really ready.”
- “Ask me a structured question that I answer from my phone.”
- “Recover this browser session and tell me what state did not survive.”
