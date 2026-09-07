# Managed skills, policy, and curation

A hard-won lesson from an incident can become part of how the next session works. A release procedure can arrive with the agent. Your review standards, design methods, and operating conventions can follow users into their workspaces without somebody rebuilding the configuration each morning.

I maintain and distribute that shared guidance across compatible sessions.

I distribute that working environment as maintained content. Skills, rules, commands, hooks, specialist definitions, scripts, and supported extensions have owners and release identities. The organization can improve them without asking each user to assemble a new agent installation.

## Shared methods, native execution

Different agent runtimes consume instructions differently. Some have native commands and hooks; others use different tool names, configuration layouts, or extension APIs. My compiler projects managed source into the supported runtime surfaces, preserving the native mechanisms instead of copying one agent's configuration into every other agent.

I use the resulting methods in the repository's context. Engineering discipline remains available without loading every specialist manual into the opening prompt. Skills load when the work calls for them; specialized tools can be discovered and activated when needed. That leaves conversation space for the system being investigated.

The available projections are deliberately runtime-aware. Shared standards do not imply identical features in every agent, and a skill describing a service does not create its credentials or connectivity.

## A release has to be both authentic and usable

Managed publication produces an immutable bundle from an exact compiler revision. CI checks the supported projections and deterministic output, then signs the payload with Ed25519. The signing key stays outside user workspaces.

I check more than the signature before accepting a release. Release identity, sequence, document paths, asset integrity, and runtime compatibility must agree. A correctly signed bundle cannot introduce an unsupported runtime dependency simply by declaring itself trustworthy. Extension artifacts have their own identity and integrity checks.

I can then select a verified release compatible with the installed runtime. Discovery, validation, and application are separate stages; an update does not become active merely because a repository contains a newer file. Compatible content can be delivered without rebuilding the container image, while new npm packages, native binaries, or compiler behavior still require the owning runtime change.

## Updates meet a workspace that already contains work

Users may have personal files, extension choices, and active sessions. Managed reconciliation accounts for that state rather than treating every home directory as an empty installation target. Automatic updates and an explicit full Recreate have different purposes and overwrite behavior. Application is coordinated around safe lifecycle conditions; publication does not instantly replace every running session.

Where protected managed-resource policies are configured, I enforce their persistence rules at the storage boundary. The container's own filters are not the authority deciding whether a protected write is permitted. This protects the governed resource surface; it does not turn a signed extension into harmless code or prevent every possible local change.

## Turn experience into the next session's starting point

I can help identify a recurring failure in a workflow, improve the relevant guidance, and prepare it for review and managed-seed CI. A useful change might clarify acceptance evidence, preserve a subtle security boundary, or remove an outdated instruction that sends every new session down the same dead end.

Using a skill is ordinary task work. Changing shared policy or publishing a release affects other sessions and requires the appropriate authorization. I keep that distinction explicit.

Managed content is authoritative for managed sessions; the image-baked fallback is separately versioned. I follow the owning release path and distinguish publication from verified application.

That gives organizational learning a delivery mechanism. You can turn a better way of investigating, reviewing, or shipping into the starting point for future work—complete with provenance and runtime compatibility, rather than another document people must remember to find.
