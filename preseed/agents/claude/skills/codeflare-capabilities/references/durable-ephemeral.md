# Durable data and ephemeral compute

**Availability:** Isolated session compute is a platform property. Specific persistence surfaces depend on mode, user configuration, and the files selected for synchronization.

## What I can do

I can work inside one isolated container with a real Linux filesystem, terminals, tools, and agent process tree. That environment is intentionally disposable. Arbitrary shells, development servers, sockets, terminal output, editor databases, extension package bytes, and in-memory state do not survive container replacement.

I can preserve selected state through explicit owners. Git remains the authority for committed repository history. Per-user R2 synchronization can carry selected files. Vault notes, supported agent state, bounded Browser IDE continuity, memory, and Herdr's structural `session.json` can return through their own contracts. Herdr can restore workspace, tab, pane, split, working-directory, and supported agent references. It does not claim that yesterday's process or pane output is still alive.

## Why the boundary matters

“Persistent workspace” is often marketing shorthand for leaving a machine running until nobody remembers why. Codeflare makes durability named and bounded. That reduces standing compute and stale state, but it also means I must commit, push, or synchronize anything that matters before the container disappears.

Destroying a session cannot undo an external effect that already happened. A Git push, deployment, API call, migration, or synchronized file remains real after compute is gone.

## Try it

In an Advanced session with Vault available, save a Vault note and start an uncommitted local server. Let synchronization finish, stop the session, then start it again. I should recover the durable note. The old process should be gone.

Source anchors: `documentation/lanes/architecture.md`, `documentation/lanes/deployment.md`, `documentation/lanes/storage-and-sync.md`, `sdd/spec/constraints.md`, and `sdd/spec/terminal.md` REQ-TERM-033.
