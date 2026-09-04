# Managed skills, policy, and curation

## What I can do

I can work with an agent environment whose skills, rules, specialists, hooks, extensions, and runtime projections are delivered as reviewed managed content. The curation repository owns that source. One compiler projects portable content into Claude, Pi, Codex, OpenCode, Antigravity, and the supported rule surfaces without pretending every runtime has identical APIs.

I publish reviewed policy and skills as signed immutable releases across supported agent runtimes without rebuilding the container image when the change stays inside the existing compiler and runtime contract. The publication pipeline compiles every target, rebuilds the bundle twice, compares the bytes, signs the exact gzip payload, and publishes a monotonically increasing release. Each running image selects the newest verified release compatible with its runtime dependency hash.

I update an organization's engineering policy or specialist workflow without rebuilding an entire workstation image. It also keeps the update auditable. “The prompt changed somewhere” is not release management.

## Where the boundary sits

I ship through curation only content that the installed runtime already understands. I put a new package, native binary, compiler transform, seed ABI, or image-owned path into the Codeflare image first.

The managed source is authoritative for managed sessions. A separately versioned baked fallback may lag when a task explicitly excludes a Codeflare image change. Signatures prove release identity and integrity; they do not make incompatible content executable.

## Try it

Ask me:

> Add this organization-wide engineering skill, keep it portable, measure its runtime footprint, run managed-seed CI, and publish the next immutable release.

Other useful requests:

- “Add a new portable skill and show which runtimes receive it.”
- “Update this preseeded skill in curation, then align Codeflare’s embedded preseed.”
- “Prepare a managed seed release and verify the compiled bundle is reproducible.”
