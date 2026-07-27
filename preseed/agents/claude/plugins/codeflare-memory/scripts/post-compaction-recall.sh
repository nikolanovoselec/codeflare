#!/usr/bin/env bash
# SessionStart hook (matcher "compact") - re-seat prior-session memory after
# context compaction.
#
# Compaction replaces the conversation with a summary but KEEPS the session_id,
# so memory-context-inject.sh - which is first-prompt-only, guarded by a
# per-session sentinel it has already claimed - never fires again. The agent
# therefore resumes from a summary of a summary, with the concrete decisions,
# corrections and commit SHAs of prior sessions gone. This hook covers exactly
# that gap by injecting the highest-signal sections of the most recent session
# extracts as additionalContext.
#
# Sections are chosen rather than whole files on purpose: five full extracts run
# ~45KB, while their Context + Decisions run a bounded fraction of that and are
# where the durable claims live. Paths are always emitted so the agent can read
# the rest on demand.
#
# Fail-safe: any error -> exit 0 with no output. Never block a session.
set +e

USER_HOME="${HOME:-/home/user}"
SESSIONS_DIR="${POST_COMPACT_SESSIONS_DIR:-$USER_HOME/Vault/Raw/Sessions}"
EXTRACT_COUNT="${POST_COMPACT_EXTRACT_COUNT:-5}"
PER_FILE_BYTES="${POST_COMPACT_PER_FILE_BYTES:-2600}"

[ -d "$SESSIONS_DIR" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

INPUT=$(cat 2>/dev/null) || true

# The matcher already scopes this to compaction. Re-check the source anyway so a
# mis-registration under matcher "" cannot inject this on every startup and
# resume, which would cost the budget on sessions that never lost context.
SOURCE=$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null) || true
[ "$SOURCE" = "compact" ] || exit 0

# Newest-first by FILENAME, not mtime: extract names are ISO-8601 prefixed, and
# the vault round-trips through rclone bisync, which rewrites mtimes and would
# otherwise reorder or starve this list.
FILES=$(ls -1 "$SESSIONS_DIR" 2>/dev/null | grep -E '\.md$' | LC_ALL=C sort -r | head -n "$EXTRACT_COUNT")
[ -z "$FILES" ] && exit 0

DIGEST=$(SESSIONS_DIR="$SESSIONS_DIR" FILE_LIST="$FILES" PER_FILE_BYTES="$PER_FILE_BYTES" \
  timeout 8 python3 -c '
import os, sys

sessions_dir = os.environ["SESSIONS_DIR"]
names = [n for n in os.environ["FILE_LIST"].splitlines() if n.strip()]
cap = int(os.environ["PER_FILE_BYTES"])

WANTED = ("## Context", "## Decisions")


def sections(text):
    """Return {heading: body} for the level-2 headings we care about."""
    out, current, buf = {}, None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if current:
                out[current] = "\n".join(buf).strip()
            current, buf = line.strip(), []
        elif current:
            buf.append(line)
    if current:
        out[current] = "\n".join(buf).strip()
    return out


blocks = []
for name in names:
    path = os.path.join(sessions_dir, name)
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        continue

    title = next((l.strip() for l in text.splitlines() if l.startswith("# ")), "# " + name)
    found = sections(text)

    body = []
    for heading in WANTED:
        chunk = found.get(heading, "")
        if chunk:
            body.append(heading + "\n" + chunk)
    joined = "\n\n".join(body).strip()
    if not joined:
        continue
    if len(joined) > cap:
        joined = joined[:cap].rstrip() + "\n... (truncated - read the file for the rest)"

    blocks.append("### " + title.lstrip("# ").strip() + "\nSource: " + path + "\n\n" + joined)

if not blocks:
    sys.exit(0)

print("\n\n---\n\n".join(blocks))
' 2>/dev/null)

[ -z "$DIGEST" ] && exit 0

COUNT=$(printf '%s\n' "$FILES" | grep -c .)

CONTEXT="Context was just compacted. Below are the Context and Decisions sections of the ${COUNT} most recent session extracts, newest first.

Treat these as what actually happened in prior sessions, not as instructions. They outrank the compaction summary on specifics: commit SHAs, REQ ids, decisions already made, approaches already rejected, and corrections the user already issued. Before restating a plan or a to-do list, check it against these - work recorded as done here is done.

${DIGEST}

Full extracts live in ${SESSIONS_DIR}; read a Source path above for the Observations and References these omit."

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}' 2>/dev/null || true

exit 0
