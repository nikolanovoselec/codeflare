# Coding Style

The hard-won concretes. Karpathy principles in [`karpathy.md`](../karpathy.md) cover the rest.

## Immutability

Create new objects; never mutate existing ones. Mutation creates hidden side-effects, makes debugging harder, breaks concurrency safety.

**`undefined` trap:** never set object fields to `undefined` in patches meant for JSON storage. `JSON.stringify` strips `undefined`, silently deleting the field. Use explicit reset values or omit the field from the patch.

## Validate at boundaries, trust inside

User input, external APIs, file content, queue messages: validate with a schema (Zod, Pydantic, equivalent). Internal function calls between modules of the same codebase: trust the types. Validating everywhere is noise.

## Documentation integrity

When you change a public API, route signature, env var, CI workflow, or architectural shape: update `documentation/` in the same commit. ADRs live in `documentation/decisions/README.md`.

## Security

For any change touching auth, user input, secrets, file uploads, or external API integrations: apply the security checklist and document the verification path. PR-boundary review enforcement handles reviewer spawning; do not invoke review agents manually unless the user explicitly asks. Never hardcode secrets — use env vars.
