# Graphify routing

When a repository graph exists, use Graphify before broad architecture, dependency, ownership, call-flow, or where-implemented searches. Use available Graphify query tools; Pi activates hidden `graphify_query`, `graphify_path`, or `graphify_explain` tools through `capability`.

Skip Graphify for known-file edits, Git or CI state, and code changed during the current task. Current source outranks stale graph evidence. Never build or refresh a graph without explicit user authorization; advanced sessions load `graphify` for that workflow.
