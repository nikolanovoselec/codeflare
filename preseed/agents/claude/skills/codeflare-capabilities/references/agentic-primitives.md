# Vault, SilverBullet, memory, Graphify, Goal, Plan, Todo, and subagents

You can return to an investigation with more than a transcript. I recover the decision that ruled out an approach, follow its connection to a requirement, locate the implementing code, and use that evidence to plan the next step. Your notes remain files you can edit; the relationships remain queryable; the current source still decides what is true now.

While the work runs, I keep its objective, plan, executable tasks, and independent investigations connected. You do not have to act as the memory and coordinator between every session and worker.

## A knowledge base you can read without me

The Vault is ordinary, Obsidian-compatible Markdown, opened through SilverBullet. Notes, plans, journal entries, inbox material, references, attachments, and session captures remain files you can browse, edit, and link yourself. Your knowledge does not have to live only inside a conversation interface.

Supported memory capture preserves decisions, corrections, observations, debugging discoveries, and source references. Capture and extraction have separate delivery steps: material must be persisted and indexed before I treat it as available to later retrieval. A worker saying “Done” is not enough to establish that the intended artifact arrived.

When you ask me to retain a decision, I keep the evidence that made it useful, not simply a confident conclusion detached from its context. Later work can recover the reasoning, including approaches that failed and constraints that still matter.

Durability depends on the configured persistence scope. A local note that has not synchronized is still local, and retrieval is bounded rather than total recall of everything ever said.

## Follow relationships across knowledge and code

Graphify maintains the Knowledge Graph that joins cumulative Vault knowledge with the source and architecture of the checked-out repository and branch. I query relationships, follow paths, and explain connections between a prior incident, an architectural decision, a requirement, and the function that implements it.

That is different from receiving a list of documents that happen to contain the same word. The relationship itself guides the investigation: what depends on this component, what decision constrained it, and what earlier evidence might explain the failure?

I use the Knowledge Graph for relevant architecture and dependency work. Building or refreshing one requires your authorization. A stale graph remains stale evidence; current source takes precedence. The global view combines the active repository contribution with cumulative Vault knowledge rather than silently retaining every old checkout as current architecture.

## Decide the approach before executing it

Plan Mode provides a read-only investigation and planning workflow with structured questions and an explicit handoff. I establish scope, inspect evidence, surface a material decision, and make the intended work reviewable before implementation.

Goal owns a session-scoped objective and its continuation. With an authorized goal active, I keep moving toward its acceptance evidence without requiring you to prompt every routine next step. Cancellation, pacing, and stale-continuation guards keep that progression tied to the current objective.

Goal and native Plan Mode cannot own the same session simultaneously. I plan first, leave Plan Mode, and then execute under Goal. An execution plan maintained during work is not itself native Plan Mode.

Todo tracks executable steps and dependencies. I update and close tasks as evidence lands; a list entry does not execute the work or prove it complete.

## Bring in another judgment deliberately

When you request the advisor, I bring a second judgment to a difficult decision without handing off ownership of the implementation. Evaluate serves a different purpose: compare a contract with the actual output and report what is satisfied, missing, or unsupported. It reports gaps rather than silently fixing them.

Those are deliberate interventions, not background claims that every answer has been independently checked. I use the capabilities available in the session and keep your request, the evidence examined, and the resulting decision clear.

## Parallel work returns to one accountable thread

Subagents can investigate independent areas, review, monitor CI, or perform supported knowledge extraction. Their assignments, status, and results remain visible. Active-work resume guards help avoid starting a second continuation of an already-running task.

I remain responsible for reconciling the findings and controlling mutations. Parallel investigation should reduce waiting, not leave you with several contradictory reports and no owner of the next decision. Structured questions bring genuinely missing choices back to you without turning every implementation detail into an interruption.

Captured text remains historical evidence, subagents stay within their assignments, and an autonomous objective does not authorize an unrequested production action.

The next piece of work can therefore begin with the decisions, connections, and findings already earned. I turn that context into a plan, coordinate its independent investigations, and bring the results back to you as one accountable thread.
