# Managed curation

**Availability:** Standard and Advanced managed deployments after an operator configures a private curation repository, scoped read credential, and signing key.

## What I can do

I can receive updated skills, rules, specialist agents, hooks, extensions, scripts, plugins, and runtime manifests without waiting for a new container image. The private curation repository owns that managed source. Codeflare keeps an independently built image fallback for startup and recovery.

I can help an operator prepare a portable change in the canonical Claude tree, update runtime manifests, inspect deterministic compiled outputs, open the protected curation pull request, and follow publication of the next immutable `seed-vN` release. Ordinary user-bucket upgrades write added or changed paths while idle. Recreate remains the explicit full-overwrite recovery action.

## Why the boundary matters

The publication workflow compiles every supported runtime, verifies deterministic bytes, signs release assets with Ed25519, and publishes immutable artifacts. The Worker checks repository identity, release metadata, digests, signature, sequence, ABI, path limits, and runtime dependency hash before managed bytes reach user storage. Curation credentials do not enter session containers.

Do not hand-edit generated Pi copies or release archives. That creates bytes no canonical source can reproduce, which is exactly the sort of clever shortcut that becomes an incident six months later.

## Try it

Stop active sessions, let an available Environment update complete, then start a new session and inspect the skill index. The published content should appear without a Codeflare image redeploy.

Operator task: add one portable skill under the canonical curation tree, list every delivered runtime file in its manifest, and verify the signed release plus image fallback through their existing integrity paths.

Source anchors: `documentation/lanes/preseed.md#managed-curation-ownership`, the managed-curation section in `documentation/lanes/architecture.md`, and the curation repository `README.md` plus `docs/operator-runbook.md`.
