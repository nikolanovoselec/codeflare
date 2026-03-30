# Coding Style

## Immutability (CRITICAL)

ALWAYS create new objects, NEVER mutate existing ones:

```
// Pseudocode
WRONG:  modify(original, field, value) → changes original in-place
CORRECT: update(original, field, value) → returns new copy with change
```

Rationale: Immutable data prevents hidden side effects, makes debugging easier, and enables safe concurrency.

NEVER set object fields to `undefined` in patches meant for JSON storage.
`JSON.stringify` strips `undefined` values, silently deleting fields.
Use explicit reset values or omit the field from the patch.

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large modules
- Organize by feature/domain, not by type

## Error Handling

ALWAYS handle errors comprehensively:
- Handle errors explicitly at every level
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

## Input Validation

ALWAYS validate at system boundaries:
- Validate all user input before processing
- Use schema-based validation where available
- Fail fast with clear error messages
- Never trust external data (API responses, user input, file content)

## Documentation Integrity

When you change any of the following, update the relevant project documentation in the same commit:
- Public APIs or route signatures
- Environment variables or configuration
- CI/CD workflows
- Architecture or data flow

Look for README, docs/, TECHNICAL.md, ADR files, or similar. If the project has no docs, suggest creating them for significant changes.

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No hardcoded values (use constants or config)
- [ ] No mutation (immutable patterns used)
- [ ] No `undefined` in objects destined for JSON serialization
- [ ] All callers of modified functions checked for compatibility
- [ ] Documentation updated for public API/config/architecture changes (if project has docs)
