# Browser terminals

Codeflare streams real PTYs to xterm.js over authenticated WebSockets. Classic sessions can expose up to six outer terminal tabs with labels, ordering, tiling, and saved layout state. Opt-in Herdr sessions expose one outer terminal while Herdr owns the workspaces, tabs, panes, splits, shells, and agent status inside it.

MultiView lets one browser workspace show several backend sessions at once. Desktop accepts two to four sessions, tablet accepts two, and mobile does not launch MultiView. Hidden sessions do not keep terminal WebSockets open just to look instant.

Try Classic when you want a few independent shells in one session: open another Bash tab, tile two terminals, and inspect files in one while reading logs in the other. Try Herdr when the session setting is available and you want the terminal itself to coordinate panes or agents. New Herdr panes start as plain Bash unless you explicitly launch something.

A browser disconnect can reattach to the same PTY while its container is still alive. Container replacement is different: only supported structural state can return, not prior output or arbitrary processes.

Source anchors: `sdd/spec/terminal.md` REQ-TERM-001/002/006/011/012/033/034 and `documentation/lanes/architecture.md`.
