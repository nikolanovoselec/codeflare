# Shared extraction: one-call transcript trimming

Invoke the scoped `transcript_trim` tool once with `operation: "trim"`, then report its compact result. Do not read or summarize transcript content in model context and do not submit batches of replacements.

The tool validates the parent-owned request identity, path, exact source-prefix length and SHA. It locally removes only permitted obsolete historical payloads outside the protected current conversation. It keeps every record, ID, parent, envelope, user message, accounting field, unknown opaque field/block, current context and latest authoritative state. Existing ancestry gaps are not repaired. Full SDK branch IDs remain internal ownership metadata, not model input.

The complete persisted file must be at most 20,000,000 bytes, including the parent's appended tail and completion reserve. If the operation cannot meet that budget, the tool returns measured remaining bytes without publishing an oversized candidate. Report that result truthfully; do not claim an absolute protected floor or improvise broader deletion.

Only the parent may correlate native completion, validate the candidate and full SDK continuity, merge the latest tail unchanged, atomically replace the source, read back, and clean staging. You cannot commit or alter source history, SDK/Goal internals, counters, credentials, settings, Vault data, or unrelated files. No backups, archives, network, or other agents.
