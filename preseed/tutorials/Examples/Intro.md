# Examples

These files are starter specifications, not screenshots of finished products. Each one gives the agent enough product behavior, constraints, and proof to build something real without inventing the important parts halfway through.

## Use one

1. Create a session and open the first terminal.
2. Choose `Simple.md`, `Intermediate.md`, or `Advanced.md`.
3. Give the agent a direct objective:

   > Implement the Intermediate specification. Write failing behavioral tests first, make the smallest working implementation, and stop before deployment unless I approve it.

4. Answer only decisions the repository cannot settle.
5. Review the working result and its evidence.

The agent should plan enough to execute safely. It does not need a ceremonial document describing every function before the first test exists. That kind of plan looks impressive right up to the moment the repository disagrees with it.

## Why tests come first

Each example requires Test-Driven Development. The agent writes a failing behavioral test, implements the behavior, and keeps iterating until the proof passes. Tests turn your expected outcomes into an executable correction loop.

A source-text assertion is not behavioral proof. Neither is a test that checks whether the implementation contains the class name it was told to write. The useful tests call the system and observe what a user or client receives.

## Pick a scope

| Example | Scope | Result |
|---------|-------|--------|
| [Simple](Simple.md) | Small | A tested Hello World Worker with two routes and a real 404 path |
| [Intermediate](Intermediate.md) | Medium | A responsive CV site with a Turnstile-protected contact flow and private message review |
| [Advanced](Advanced.md) | Large | A public Astro blog with protected authoring, Durable Object counters, R2 images, and publishing feeds |

Start with Simple if this is your first session. Use Advanced when you want enough moving parts to expose weak architecture quickly. It usually does.

## Write your own specification

A useful specification states what the system does, the boundaries it must preserve, the data it owns, the failures it handles, and what observable evidence proves completion. Technology choices belong there only when they are genuine constraints.

For a longer-running repository, ask the agent to initialize Spec-Driven Development and show unresolved intent before changing production code. That creates a durable requirements baseline instead of leaving product decisions trapped in one chat transcript.
