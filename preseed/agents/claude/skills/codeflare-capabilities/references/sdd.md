# Spec-Driven Development and Test-Driven Development

## What I can do

I can turn a repository into a system where intent, code, tests, and operating guidance agree with one another. SDD means Spec-Driven Development. TDD means Test-Driven Development. Used together, they stop the familiar trick where a team ships a patch first and writes a requirement afterward that happens to describe the patch perfectly.

For a legacy project, I can run `/sdd init` and reverse-engineer a baseline from source, history, tests, documentation, and architecture. Behavior that the evidence supports becomes a requirement with acceptance criteria, constraints, dependencies, source anchors, test anchors, and status. Unclear intent goes into a visible triage queue. I do not invent a product decision because an old function has an authoritative name.

I can use Graphify to enrich that baseline with architecture links, central concepts, and dependency evidence. Source-anchor and enumeration checks then fail closed when the draft claims code that does not exist or forgets an implemented surface.

Once the baseline is accepted, I trace each change to its owning requirement, write the failing behavioral test first, make the smallest correction, and keep every touched anchor truthful. `/sdd clean` handles drift when a mature specification and implementation no longer describe the same product.

## Where the boundary sits

A behavioral test proves an observable outcome or contract value. It does not grep for a sentence, freeze a prompt, or reward the implementation for containing a fashionable class name. Subjective design and prose remain review judgments.

I also refuse to call work complete while a touched requirement is `Partial`. That status means evidence is missing. Renaming it would not create the evidence.

## Try it

Ask me:

> Run `/sdd init` on this legacy repository. Show me the proposed baseline and every unresolved intent item before you change production code.

Other useful requests:

- “Trace this change to its owning requirement and tell me which tests need to move first.”
- “Find every `Partial` requirement touched by this diff and show the missing evidence.”
- “Use Graphify to map the call path behind this requirement before editing.”
