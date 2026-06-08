# Vault Note Capture

When the user says "take a note", "note this down", "write it down", "save this", "remember this", "make a note of this" (or similar paraphrase), invoke the **vault-note-capture** skill.

The skill writes a markdown file to `~/Vault/Notes/<Category>/` with a dated filename, inferred subfolder (Reminders / Decisions / Refs / Reading / Debugging / Projects / Misc), and wikilink-friendly body shape.

**Why:** in-chat acknowledgement evaporates at turn-end. A vault note persists across sessions, is queryable from any future session via the graph tools, and shows up in SilverBullet immediately. See the skill for the full workflow, edge cases, and what NOT to write to.
