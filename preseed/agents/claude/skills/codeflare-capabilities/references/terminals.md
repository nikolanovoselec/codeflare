# Any-device terminals, Herdr, continuity, and notifications

## What I can do

I can run the same engineering session through a browser on a desktop, tablet, or phone. No local agent toolchain is required. A reconnect attaches to the existing PTY while its container remains alive, so the browser can change without pretending the process moved into the phone.

Classic gives me up to six outer terminal tabs with labels, ordering, tiling, and saved layout. Herdr provides a deeper control surface with workspaces, tabs, panes, splits, shells, and tracked agents inside one outer terminal. MultiView can place several backend sessions in one browser workspace on larger screens.

The mobile terminal handles touch, virtual-keyboard geometry, orientation changes, sticky control sequences, and voice input where the browser supports it. It is a real terminal adapted to glass, not a desktop screenshot shrunk until the text loses the will to live.

When a structured question needs attention, Codeflare can emit an immediate input-required signal. With Web Push enrolled, eligible away notifications can reach the device and return to the owning session. Herdr watches agent state across panes and delays completion until tracked work has actually become ready.

## Where the boundary sits

A blocked or unknown Herdr pane prevents a false completion notification. It does not automatically promise a separate push for every blocked state. Completion timing and input-required signaling are different contracts.

A reconnect can recover a live PTY. Container replacement cannot recover arbitrary process memory or old terminal output. Herdr may restore supported structure, but yesterday's shell process is still dead. Anything else would be a séance with ANSI escape codes.

## Try it

Start a task on desktop, leave the browser, then reconnect from a phone. Answer one structured question from the mobile session and confirm that the same terminal continues without starting a second PTY.

Other useful requests:

- “Set up Herdr panes for three agents and wait until each is really ready.”
- “Ask me a structured question that I can answer from my phone.”
- “Recover this browser session and tell me what state did not survive.”

Source anchors: `sdd/spec/terminal.md` REQ-TERM-001/002/006/011/012/023/024/025/029/033/038/039, `sdd/spec/mobile.md` REQ-MOB-001/002/006/007/021/022, and `documentation/lanes/preseed.md` notification sections.
