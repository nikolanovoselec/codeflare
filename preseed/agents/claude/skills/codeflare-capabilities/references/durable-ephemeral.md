# Durable data and ephemeral compute

A Codeflare session gets one isolated container, not a long-lived workstation. Its local disk and live processes are ephemeral. When the container stops or is replaced, arbitrary shells, servers, sockets, terminal output, extension package bytes, editor databases, and in-memory state do not survive.

Durability is explicit. Selected per-user files reconcile through the user's R2 bucket. Git remains the authority for committed repository history. Vault notes, supported agent state, selected Browser IDE continuity, and Herdr's structural `session.json` can return through their own bounded contracts. Herdr can restore workspaces, tabs, panes, layout, working directories, and supported agent references, but it does not pretend the old processes or pane output are alive.

Try the boundary in an Advanced session with Vault available:

1. Save a note through the Vault flow and create an uncommitted process such as a local development server.
2. Let the session sync and stop it.
3. Start the session again. Confirm the durable note returns and the old process does not.

For repository work, commit or push anything that must survive independently of Codeflare storage. For transient experiments, treat the container as disposable by design.

Source anchors: `documentation/lanes/architecture.md`, `documentation/lanes/deployment.md`, `documentation/lanes/storage-and-sync.md`, `sdd/spec/constraints.md`, and `sdd/spec/terminal.md` REQ-TERM-033.
