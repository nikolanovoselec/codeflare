# Examples

These are specifications. Each one describes a complete project - requirements, constraints, tests, and acceptance criteria. Everything an AI agent needs to build it from scratch without asking you a single question.

## How to Use

1. Create a session, pick your agent
2. Open Tab 1
3. Tell it: **"Plan implementation of the Advanced.md specification"** (or whichever one you picked)
4. Go through the plan with the agent - you need to make some decisions in order to create an implementation plan
5. Approve the implementation plan
6. Go watch Game of Thrones again

The planning step is not optional. The spec tells the agent *what* to build - the agent still needs to figure out *how*. During planning, the agent reads the spec, asks follow-up questions about scaffolding, file structure, dependency choices, and execution order, then produces a detailed implementation document - a step-by-step blueprint covering every file, every function, every test. Once you review and approve it, the agent exits planning mode and executes against that document. This is where a specification becomes a working project.

After planning, the agent writes failing tests, implements until they pass, and deploys to Cloudflare. You come back to a working project with a full test suite and plausible deniability about who actually wrote it.

Each spec follows TDD - tests first, then implementation. This isn't a style preference. It's the single most effective way to keep a coding agent on track.

When the agent writes tests first, every subsequent `npm test` run injects your expectations back into its context. If it drifts off course - wrong return type, missing validation, broken edge case - the failing test tells it exactly what went wrong and what was expected. The agent course-corrects without you lifting a finger. Without tests, the agent has no feedback loop. It writes code, assumes it works, and moves on. By the time you notice something is wrong, it's three features deep into a broken foundation.

TDD turns your spec into a live guardrail. The agent can't cheat. If it says it's done and the tests don't pass, it lied. Make it try again.

## Difficulty Levels

| Example | Time | What You Get |
|---------|------|-------------|
| [Simple](Simple.md) | ~15 min | Hello World Worker. The agent does all of it. You take the credit. |
| [Intermediate](Intermediate.md) | ~30-45 min | CV website with Turnstile-protected contact form. Tell your recruiter you built it yourself. |
| [Advanced](Advanced.md) | ~1-2 hours | Full blog with Durable Objects, R2 storage, and a CMS. The agent will complain less than an intern. |
| [Expert](Expert.md) | ~1 day | You're rebuilding Codeflare itself. Bring coffee. |

Start with Simple if this is your first session. Start with Expert if you have something to prove.

## Writing Your Own Specs

These examples are meant to be a starting point. For your own projects, use your coding agent to develop a detailed specification *before* writing any code. Not a list of requirements - a specification. The difference matters.

A specification defines what the system does, what technology it uses, how components interact, what the data looks like, what edge cases exist, what the tests verify, and what acceptance looks like. It's specific enough that the agent can execute without asking you a single question. If the agent has to guess, the spec isn't done.

Tools like the `superpowers:brainstorming` skill or the `sequential-thinking` MCP server are built for this. Describe what you want to build, let the agent ask the right questions, and iterate until the spec is tight enough that implementation becomes mechanical. The more precise the spec, the less the agent improvises - and improvisation is where things go sideways.
