---
name: vault-note-capture
description: When user says "take a note", "note this down", "write it down", "save this", "remember this", "make a note of this" (or paraphrase), write a markdown note to ~/Vault/Notes/<Category>/. Invoke this skill on those phrases.
---

# Vault note capture

The user keeps cross-session notes in `~/Vault/Notes/` (a SilverBullet space; persisted to R2; ingested into the unified graphify graph by the vault-monitor daemon). When they ask you to capture something, write a file - don't just acknowledge.

## Workflow

1. **Infer category** from the content. Create the folder if absent:
   - Reminder / TODO / "remind me to X" → `Notes/Reminders/`
   - Architectural / product decision → `Notes/Decisions/`
   - Reading notes / article / paper summary → `Notes/Reading/`
   - API / library / vendor reference → `Notes/References/`
   - Debugging finding → `Notes/Debugging/`
   - Project-specific → `Notes/Projects/<project>/`
   - Unclear → ask once, or default to `Notes/Misc/`.

2. **Filename**: `YYYY-MM-DD-<short-kebab-slug>.md`. Date prefix enables chronological scan; slug is 3-6 words capturing the gist.

3. **Body shape** (tight - user will edit in SilverBullet if needed):

   ```markdown
   # <Short title>

   <One-paragraph capture in the user's framing.>

   ## Why
   <1-2 sentences on context or motivation.>

   ## Links
   - [[ConceptOne]]
   - [[ConceptTwo]]
   - <prose ref to file paths / PRs / URLs>
   ```

4. **Wikilink convention**:
   - `[[PascalCaseConcept]]` for things you want the unified graph to dedup across notes and code (named patterns, product names, function names that are also concepts).
   - File paths, snake_case symbols, PR/issue URLs → leave as prose. They namespace per-project; auto-linking creates noise.

5. **Report back**: just the file path on one line. Don't quote the body - the user opens it in SilverBullet. Do NOT manually trigger extraction; the vault-monitor daemon picks it up on the next 60s tick.

## Hard rules

- **Never write to** `Raw/Sessions/` (agent-capture-only; deterministic).
- **Never write to** the four preseed pages (`Index.md`, `README.md`, `CONFIG.md`, `STYLES.md`) - they're Codeflare-authoritative and overwritten on next boot.
- **Don't sprawl**. If user says "note this about X", capture X - not the whole prior turn. If broader context is needed, ask one short question.

## Edge cases

- **Sensitive content** (secrets, tokens, full file contents pasted in chat): warn before writing; secrets in the vault round-trip to R2.
- **Update vs new**: if a note for the same topic already exists in the same category, ask "extend the existing note or create a new dated one?".
