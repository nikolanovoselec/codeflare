# Examples

These are specifications. Each one describes a complete project - requirements, constraints, tests, and acceptance criteria. Each specification gives me what I need to build it from scratch without guessing.

## How to Use

1. Create a session, pick your agent
2. Open Tab 1
3. Tell it: **"Plan implementation of the Advanced.md specification"** (or whichever one you picked)
4. Go through the plan with the agent - you need to make some decisions in order to create an implementation plan
5. Approve the implementation plan
6. Go watch Game of Thrones again

The planning step is not optional. The specification tells me *what* to build, and I still need to determine *how*. During planning, I read it, ask necessary follow-up questions about scaffolding, file structure, dependency choices, and execution order, then produce a detailed implementation document - a step-by-step blueprint covering every file, every function, and every test. Once you review and approve it, I exit planning mode and execute against that document. This is where a specification becomes a working project.

After planning, I write failing tests, implement until they pass, and deploy to Cloudflare. You come back to a working project with a full test suite and plausible deniability about who actually wrote it.

Each spec follows TDD - tests first, then implementation. This isn't a style preference. It's the single most effective way to keep a coding agent on track.

When I write tests first, every subsequent `npm test` run injects your expectations back into my context. If I drift off course - wrong return type, missing validation, broken edge case - the failing test tells me what went wrong and what was expected. I course-correct without you lifting a finger. Without tests, I have no feedback loop. I write code, assume it works, and move on. By the time you notice something is wrong, it's three features deep into a broken foundation.

TDD turns your specification into a live guardrail and keeps me honest. I cannot cheat. If I say I am done while tests fail, I lied. Make me try again.

## Difficulty Levels

| Example | Time | What You Get |
|---------|------|-------------|
| [Simple](Simple.md) | ~15 min | Hello World Worker. I build all of it. You take the credit. |
| [Intermediate](Intermediate.md) | ~30-45 min | CV website with Turnstile-protected contact form. Tell your recruiter you built it yourself. |
| [Advanced](Advanced.md) | ~1-2 hours | I build the full blog with Durable Objects, R2 storage, and a CMS. I complain less than an intern. |

Start with Simple if this is your first session.

## Writing Your Own Specs

These examples are meant to be a starting point. For your own projects, use your coding agent to develop a detailed specification *before* writing any code. Not a list of requirements - a specification. The difference matters.

A specification defines what the system does, what technology it uses, how components interact, what the data looks like, what edge cases exist, what the tests verify, and what acceptance looks like. It is specific enough that I can execute without guessing. If I have to guess, the specification is not done.

If I support a planning mode, such as Claude Code's `/plan`, use it to develop a detailed specification. The more precise the specification, the less I improvise - and improvisation is where things go sideways.

For longer-running projects in an advanced Claude Code session, I use `/sdd init` to bootstrap a `sdd/` folder of REQ-tracked requirements, then keep the specification, code, and documentation synchronized as you push commits. It's heavier than `/plan` and worth it once a project outgrows a single working session.
