# Spec-Driven Development and Test-Driven Development

An unfamiliar repository contains more knowledge than its README. There is behavior in the code, intent in old decisions, expectations in tests, and operational experience in issue discussions. I can bring that evidence together before changing the system.

Spec-Driven Development gives the work a maintained account of what the product must do. Test-Driven Development connects a change to observable proof. Used together, they let me carry intent through implementation instead of writing a description that merely congratulates the finished patch.

## Start with the system you have

For a legacy project, `/sdd init` examines source, tests, configuration, documentation, architecture, and accessible history. I can follow relevant commits, pull requests, issues, releases, and linked material to understand why the implementation took its present shape. Missing evidence stays visible; I do not turn an inaccessible discussion into an invented decision.

Clear behavior becomes a proposed requirement. Ambiguous intent goes into a triage queue with context, a recommendation, and the reason for it. You can accept, correct, defer, or record lost intent. That preserves the difference between “the code does this” and “the product should do this.”

For a new product, I work from your vision and constraints to a draft you can review. In either case, you retain control of the baseline before it becomes the contract for subsequent work.

## Give the knowledge a structure

The baseline connects more than feature descriptions. Requirements carry acceptance criteria, constraints, dependencies, status, and references to implementation and tests. Architectural decisions explain choices and consequences. A glossary keeps terminology consistent. Operating documentation covers the surfaces the project actually has: architecture, configuration, APIs, deployment, security, troubleshooting, and other relevant areas.

Where Graphify is available, I use architecture and dependency relationships to enrich those connections. I ask before building or refreshing a graph. The graph supplies evidence about relationships; it does not decide product intent.

Source-anchor checks examine whether the specification points to real implementation. Enumeration checks look for implemented surfaces the baseline has omitted. These supplied checks support the workflow; they are not a substitute for judging whether a requirement describes the right behavior.

The result is something I can navigate while working. A requirement leads to the code that owns it, the proof expected of it, and the decisions that explain its constraints.

## Change the behavior, not just the files

Once the baseline is accepted, I begin a change at its owning requirement. I identify the observable failure, write the failing behavioral proof, implement the smallest coherent correction, and bring the specification and documentation along with it.

A passing test needs to establish the contract—not merely find a string in a file or mirror the implementation's internal arrangement. Failure paths, authorization, state transitions, and recovery deserve proof just as much as the successful response.

Imported legacy behavior may initially have code evidence without automated coverage. I distinguish that from a tested contract. If a touched requirement remains `Partial`, I report the missing evidence rather than rename the status to finish the task. Subjective design and prose still need human judgment; a wording snapshot cannot settle their quality.

## Keep it useful as the repository changes

`/sdd clean` addresses drift between the specification, implementation, tests, and documentation. I preserve valid decisions and operating knowledge while correcting stale links, unsupported claims, and contradictions. Uncertainty is a finding, not an invitation to erase inconvenient history.

This does not require rebuilding the entire baseline for a small fix. In an established repository, I follow the affected requirement and its dependencies. You get a focused change with an explanation of what it preserves, what it alters, and how that was verified.

To begin with an existing system, ask me to run `/sdd init` and show you the unresolved intent before changing production code.
