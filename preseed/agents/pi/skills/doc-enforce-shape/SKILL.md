---
name: doc-enforce-shape
description: Pi-native canonical documentation shape enforcement for indexed lanes and API references.
version: 3.0.0
---

# Pi Documentation Shape Enforcement

Run on canonical/index/API files supplied by `doc-enforce`; run every canonical file only for `scope=all`.

## Pass 5: required fields

Check each in-scope canonical element has its required fields:

- API endpoint: method/path heading, auth, request, responses, errors, and REQ backlink;
- configuration item: variable, required/default semantics, consumer, and security note when secret;
- deployment operation: prerequisites, command/action, verification, rollback;
- troubleshooting entry: symptom, cause, fix, verification;
- ADR: status, context, decision, alternatives, consequences, related REQs.

A field may say `None` only when that is a real contract value.

## Pass 6: consistent file shape

Sibling elements in one file use one rendering shape. Headings are hierarchical, jump links resolve, the README index links every valid lane, and no index link dangles. Project-specific lanes may define their own repeated template; enforce the established template within that file.

## Pass 7: API endpoint rendering

Each endpoint appears once in canonical API reference. Split route families across `api-reference-*.md` only when each file is indexed. Verify method/path, auth, inputs, success/error status contracts, response shape, and REQ link against source.

Do not require prose duplication already owned by security, deployment, or configuration; use links.

## Element budgets

Flag unreadable elements, not file length:

- paragraph over roughly 120 words or carrying multiple unrelated ideas;
- table cells that become mini-essays;
- list item over roughly 60 words;
- fenced example too large to explain one task;
- heading sections that combine unrelated operational jobs.

These are MEDIUM unless shape loss hides a public contract.

## Output

Return evidence for Passes 5-7 with element counts and findings. Each finding identifies the exact element and missing/inconsistent field. Review purpose never edits; clean purpose preserves content while normalizing shape.
