# Private storage, synchronization, and ephemeral compute

I give you an isolated Linux container with ordinary working files. A compiler, Git client, data-processing script, or editor sees a real filesystem. You do not need to rewrite a task around object-storage APIs just because the working machine is temporary.

I separate that machine from the material selected to survive it. Each session gets its own compute environment; each user has a dedicated S3-compatible storage bucket. Startup restoration and synchronization connect the two.

## Files you can use from either side

The Storage browser gives you folder navigation, upload, download, deletion, and safe previews. Those folders correspond to paths under the session home directory. A dataset uploaded through the browser can become input to my tools; a result written into an included path can return to durable storage for you to retrieve.

Inside the container, I use local working copies. That keeps normal development tools working normally. I handle bucket provisioning, scoped access, restoration, change reconciliation, and shutdown synchronization around them.

Storage authority follows the user. A session does not receive permission to roam the account's buckets because it needs to read one input file. Where strict storage interception applies, the trusted controller validates the bound bucket and signs requests for that scope.

## Choose what should survive

I keep three different kinds of continuity straight:

**Git preserves source history.** Commits, branches, review, and merges belong there. A synchronized checkout is not a substitute for version control.

**Synchronized storage preserves selected files.** Notes, assets, datasets, configuration, and deliberately persisted workspace material can outlive compute. Workspace synchronization is an explicit preference and defaults off; having a bucket does not make every local path durable.

**The Vault preserves working knowledge.** Decisions, references, plans, and supported session captures remain readable Markdown. Their graph relationships can connect later work to the evidence behind an earlier conclusion.

I help put an output where its future use requires it. Before replacing a session, I identify work that still needs committing or synchronization instead of assuming that whatever is visible in the terminal has already been saved.

## Synchronization has a schedule

Sync-now pulls storage changes into running sessions and pushes included local changes back. Background bidirectional synchronization runs every 15 minutes, with a final bounded synchronization during shutdown.

That is periodic reconciliation, not a transactional shared filesystem. Two active containers can edit the same path; newest-file-wins cannot merge competing intent. Abrupt failure can lose changes that have not reached storage. I use Git when history and merge semantics matter, and an explicit sync when you need included output persisted now.

Stored objects use encryption at rest. Customer-provided AES-256 SSE-C protection applies when configured for those object operations. Governed storage policy can use the platform's default encryption instead; browser Vault cache encryption is a separate layer with its own contract.

## What returns after replacement

A fresh container can restore selected files and supported agent transcripts. Classic uses `/resume` for supported conversation history; Herdr can restore supported agent sessions from persisted references. Browser VS Code can recover bounded preferences, open-file resources, and extension choices.

The old process tree does not come back with them. Running shells, sockets, browser tabs, process memory, arbitrary terminal output, and files outside synchronized paths are ephemeral. Reconnecting to a still-live PTY is different: it can restore bounded terminal output because the process has not been replaced.

This lets me use disposable compute without treating useful knowledge as disposable. It also keeps the consequence of external work clear: a pushed commit, deployment, migration, API mutation, or synchronized file survives independently. Destroying the container is not an undo button.
