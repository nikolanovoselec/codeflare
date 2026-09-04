# Vault, SilverBullet, memory, Graphify, Todo, and subagents

## What I can do

I can preserve the useful parts of a long engineering life instead of treating every new session as amnesia with a terminal.

I use the Vault as an Obsidian-compatible Markdown knowledge base opened through SilverBullet. It carries notes, plans, references, journal entries, inbox material, attachments, pasted content, and structured session captures. You can edit it directly, create wikilinks, and keep the source as ordinary files.

Codeflare's memory hooks capture every 20 real user messages and resumed-session tails into `Raw/Sessions/`. They retain decisions, corrections, observations, debugging discoveries, and source references in your durable storage until you remove them. I use that durable context without claiming every uncaptured thought survives forever.

I use Graphify to turn supported Vault content into a cumulative knowledge graph. I can add source and architecture from a checked-out repository, merge it with the Vault contribution, and query the resulting global graph. That lets me connect a prior incident, a playbook, a requirement, and the function that implements it. I can load relevant graph context on a session's first useful prompt and recall recent captures after compaction.

I use Todo to keep executable work and dependencies honest. I delegate investigation, review, CI monitoring, and knowledge extraction to specialist subagents when parallel work helps. I remain the root owner that combines their evidence and controls mutations.

## Goal and Plan

Goal records the desired end state, relevant constraints, non-goals, acceptance evidence, and approval boundaries. For non-trivial work, Plan is the execution path I maintain while working. I update it when repository evidence changes my understanding. I ask only when missing information would materially change the outcome or risk, or force an irreversible decision; routine implementation details come from repository evidence and established conventions.

> **Goal:** Upgrade the authentication boundary without changing the public API. Preserve tenant isolation, pass the existing security checks, and stop before deployment.
>
> **Plan:** I inspect the current boundary, identify affected requirements and tests, propose the smallest safe change, implement it, run the required review lanes, and report evidence plus unresolved decisions.

## Where the boundary sits

The global graph is a structural memory, not an oracle. It includes what capture and extraction have accepted, and the active repository graph may be stale until the user refreshes it. Current source and live system evidence outrank old notes.

I merge one active repository contribution with the cumulative Vault contribution. I do not silently keep every repository ever cloned in the global graph, because a brain made entirely of stale checkouts would be less “collective intelligence” and more attic.

Subagents report within their assigned boundary. Todo records work but does not execute it. Memory cannot authorize a production action.

## Try it

Ask me to find everything connected to one error signature across session captures, notes, architecture decisions, and the active repository, then turn the evidence into a requirement and a focused investigation task.

Other useful requests:

- “Use Graphify to map dependencies around this subsystem before we plan the fix.”
- “Capture this decision into the Vault and link it to the requirement and PR.”
- “Create Todo tasks with owners and dependencies, then close them as the evidence lands.”
