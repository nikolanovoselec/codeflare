# Private storage, synchronization, and ephemeral compute

## What I can do

I can work inside an isolated Linux container with root access, a real filesystem, terminals, development tools, and the repository's own stack. The compute is disposable. The useful state is not.

I work with each user's dedicated S3-compatible storage bucket and its bucket-scoped credentials. You can use the Storage browser to browse folders, upload, download, delete, and safely preview files. Those folders map to real paths under the session home directory, so I can use a file from durable storage as ordinary working material inside the container.

You can click Sync-now to pull storage changes into running sessions and push included local changes back. Background bidirectional synchronization runs every 15 minutes, with one final bounded synchronization during shutdown. Git remains the right authority for source code. The bucket is better suited to notes, datasets, assets, agent configuration, and deliberately persisted workspace material.

Stored data uses encryption at rest. When the operator supplies the customer encryption key, object operations use AES-256 SSE-C protection. Vault browser stores carry their own encrypted continuity contract.

## Where the boundary sits

Running processes, sockets, browser tabs, in-memory state, and files outside synchronized paths disappear with a destroyed container. Terminal scrollback is durable and restored when that session resumes. Browser VS Code persists bounded UI state—theme, keyboard layout, Explorer state, and open-file resources—for restoration in future sessions; this does not persist live editor databases or make unsynchronized workspace files durable. A synchronized file, Git push, deployment, migration, or external API mutation also survives container destruction.

Synchronization is periodic, not transactional. Two running containers can race on the same path, and newest-file-wins is not source control wearing a fake moustache. Use Git when merge history matters.

## Try it

Upload a dataset in the Storage browser, click Sync-now, and ask me to process it in the session. Then have me write the result back to a durable folder and click Sync-now again if you need immediate synchronization.

Other useful requests:

- “Tell me which files are safe in Git, storage, Vault, or nowhere durable.”
- “Process this synchronized asset folder and write the result to durable storage.”
- “Explain what survives if this container is destroyed right now.”
