# Private storage, synchronization, and ephemeral compute

## What I can do

I can work inside an isolated Linux container with root access, a real filesystem, terminals, development tools, and the repository's own stack. The compute is disposable. The useful state is not.

Every user gets a dedicated S3-compatible storage bucket with bucket-scoped credentials. The Storage browser can browse folders, upload, download, delete, and safely preview files. Those folders map to real paths under the session home directory, so a file placed in durable storage can become ordinary working material inside the container.

The user can click Sync-now to pull storage changes into running sessions and push included local changes back. A background bidirectional sync runs every 15 minutes, and shutdown performs one final bounded sync. Git remains the right authority for source code. The bucket is better suited to notes, datasets, assets, agent configuration, and deliberately persisted workspace material.

Stored data uses encryption at rest. When the operator supplies the customer encryption key, object operations use AES-256 SSE-C protection. Vault browser stores carry their own encrypted continuity contract.

## Where the boundary sits

Processes, sockets, terminal output, editor databases, browser sessions, and unsynchronized files disappear with the container. A synchronized file, Git push, deployment, migration, or external API mutation does not.

Synchronization is periodic, not transactional. Two running containers can race on the same path, and newest-file-wins is not source control wearing a fake moustache. Use Git when merge history matters.

## Try it

Upload a dataset in the Storage browser, click Sync-now, and ask me to process it in the session. Then have me write the result back to a durable folder and click Sync-now again if you need immediate synchronization.

Other useful requests:

- “Tell me which files are safe in Git, storage, Vault, or nowhere durable.”
- “Process this synchronized asset folder and write the result to durable storage.”
- “Explain what survives if this container is destroyed right now.”

Source anchors: `sdd/spec/storage.md` REQ-STOR-001/002/003/004/005/007/008/015/016, `sdd/spec/security.md` REQ-SEC-003/005, and `documentation/lanes/storage-and-sync.md`.
