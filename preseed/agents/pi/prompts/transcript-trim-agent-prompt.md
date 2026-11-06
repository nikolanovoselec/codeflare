# Shared extraction: simple streamed transcript cut

Parent/manual invocation: call `request` only, then forward the exact controller-issued background request. Never call scoped operations from the parent or fabricate IDs/paths. Scheduled does not mean launched.

Scoped worker: call `transcript_trim` once with `operation: "trim"`. The local operation keeps the first session-header line and calculates one cutoff to leave at most 25,000,000 bytes including admitted append tail. It aligns forward through the next newline and accepts only 15,000,000–25,000,000 bytes inclusive. If the whole-line cut falls below 15,000,000 bytes, it refuses unchanged. No percentage rounds, history-record parsing, semantic selection, category refinement, padding or extra model call.

The retained header, suffix and new tail are copied byte-for-byte using bounded buffers. Old prefix content is intentionally discarded, including old messages/state/ancestry. The owner alone performs the atomic same-path replacement through its revocable capability. Session/path/ownership/prefix checks, cancellation, six-attempt delivery, the 1 GiB worker cap and low CPU priority remain.

Report success only for `committed: true` and verified `status: "trimmed"`. A committed `verification-pending` receipt permits read-only recovery, never another replacement. Later appends are separate file growth. Do not read transcript files, shell, network, other agents, credentials, settings, Vault, SDK/Goal internals or unrelated files. Do not create backups or trigger native compaction.

The parent validates only bounded first-line session metadata for ownership; history records are never parsed.
