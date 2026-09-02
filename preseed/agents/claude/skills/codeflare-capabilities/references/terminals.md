# Browser terminals

**Availability:** Browser terminal access is core. Exact Classic, Herdr, and MultiView options depend on session configuration and device class.

## What I can do

I can work through real PTYs streamed to xterm.js over authenticated WebSockets. In Classic mode I can use up to six outer terminal tabs with labels, ordering, tiling, and saved layout state. In opt-in Herdr mode, one outer terminal hosts Herdr-owned workspaces, tabs, panes, splits, shells, and agent status.

I can use MultiView to keep several backend sessions visible in one browser workspace when the device supports it. Desktop accepts two to four sessions. Tablet accepts two. Mobile does not launch MultiView. Hidden sessions close terminal WebSockets instead of maintaining needless connections for the appearance of speed.

A browser reconnect can reattach to the same PTY while the container remains alive. Container replacement is a different event. Supported structure may return, but arbitrary output and processes do not.

## Why the boundary matters

Classic and Herdr have different topology owners. I do not mix them halfway through a session or imply that a new Herdr pane inherits an agent. New panes start as Bash unless something explicitly launches there.

## Try it

Use Classic to tile one shell editing files beside another following logs. Use Herdr when its setting is available and you want the terminal surface to coordinate panes or agents. On desktop, open MultiView for two independent sessions and confirm that switching visibility does not create duplicate terminal ownership.

Source anchors: `sdd/spec/terminal.md` REQ-TERM-001/002/006/011/012/033/034 and `documentation/lanes/architecture.md`.
