# Managed curation

Codeflare separates the container image from the agent content that changes more often. The private curation repository owns managed skills, rules, agents, hooks, extensions, scripts, plugins, and their Standard or Advanced membership. Codeflare keeps a baked image fallback, but a managed deployment consumes signed curation releases.

A protected workflow compiles every supported runtime, verifies deterministic bytes, signs the release with Ed25519, and publishes immutable assets. The Worker verifies repository identity, release metadata, digests, signature, sequence, ABI, path limits, and runtime dependency hash before accepting anything. User buckets reconcile only while idle, and ordinary upgrades write the added or changed paths rather than rebuilding a container image.

Users can see this boundary without operating the release system. Stop active sessions, wait for an available environment update to finish, then start a new session and inspect the skill index. The new content should appear without an image redeploy. "Recreate" remains the explicit full-overwrite recovery path.

Operator example: add a portable skill under the canonical curation Claude tree, list every runtime file in its manifest, open a protected curation PR, and let publication produce the next immutable `seed-vN` release. Do not hand-edit generated Pi copies or release assets.

Source anchors: `documentation/lanes/preseed.md#managed-curation-ownership`, `documentation/lanes/architecture.md` managed curation section, and the curation repository `README.md` plus `docs/operator-runbook.md`.
