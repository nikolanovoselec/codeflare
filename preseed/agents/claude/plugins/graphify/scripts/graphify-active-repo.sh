#!/usr/bin/env bash
# Track which repo the agent is currently working in. Writes the resolved
# repo root to ~/.cache/codeflare-hooks/graphify-active-cwd; the graphify
# MCP wrapper (graphify-mcp-lazy.py) polls that file and rebinds its
# in-memory graph to <repo>/graphify-out/graph.json.
#
# Fires PostToolUse on multiple matchers because the active-repo signal
# differs by tool surface and tier:
#
#   - Bash                            -> .cwd (Claude Code's session cwd
#                                        updates on Bash `cd`); also
#                                        detects `git clone X` / `gh repo
#                                        clone X` target dirs.
#   - Edit | Write | Read | NotebookEdit
#                                     -> walk up from .tool_input.file_path.
#                                        Universal signal (these tools are
#                                        the same at every tier; context-mode
#                                        wraps them, does not replace them).
#   - mcp__context-mode__ctx_execute  -> parse `cd X` out of .tool_input.code
#       | ctx_execute_file              (Claude Code does NOT see cwd
#                                        changes inside ctx_execute shells).
#   - mcp__context-mode__ctx_batch_execute
#                                     -> same, but iterate .tool_input.commands[].command.
#
# Resolution: walks up from the candidate dir until a directory containing
# .git/ or graphify-out/ is found. If none, exit 0 silently. Sentinel is
# only rewritten on change (no mtime churn).
#
# Sentinel dir is overrideable via GRAPHIFY_SENTINEL_DIR for testing.

set -e
trap 'exit 0' ERR

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

CANDIDATE=""
SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)

# Last `cd <target>` in a shell snippet, anchored on start / shell separator
# to skip false positives like `echo "cd x"`.
extract_last_cd() {
    printf '%s' "$1" \
        | grep -oE '(^|[;&|]|\n)[[:space:]]*cd[[:space:]]+[^;&|[:space:]]+' \
        | tail -1 \
        | sed -E 's/^.*cd[[:space:]]+//'
}

case "$TOOL" in
    Bash)
        CANDIDATE="$SESSION_CWD"
        CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
        CLONE_LINE=$(printf '%s' "$CMD" | grep -oE '(^|[;&|])[[:space:]]*(git[[:space:]]+clone|gh[[:space:]]+repo[[:space:]]+clone)[[:space:]]+[^;&|]+' | tail -1)
        if [ -n "$CLONE_LINE" ]; then
            LAST=$(printf '%s' "$CLONE_LINE" | awk '{print $NF}')
            case "$LAST" in
                http*|git@*|ssh*|*/) ;;
                *)
                    if [ -d "$SESSION_CWD/$LAST" ]; then
                        CANDIDATE="$SESSION_CWD/$LAST"
                    elif [ -d "$LAST" ]; then
                        CANDIDATE="$LAST"
                    fi
                    ;;
            esac
        fi
        ;;
    Edit|Write|Read|NotebookEdit)
        FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
        [ -n "$FP" ] && CANDIDATE=$(dirname "$FP")
        ;;
    mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file)
        CODE=$(printf '%s' "$INPUT" | jq -r '.tool_input.code // empty' 2>/dev/null)
        TARGET=$(extract_last_cd "$CODE")
        if [ -n "$TARGET" ]; then
            case "$TARGET" in
                /*) CANDIDATE="$TARGET" ;;
                *)  CANDIDATE="$SESSION_CWD/$TARGET" ;;
            esac
        fi
        ;;
    mcp__context-mode__ctx_batch_execute)
        CMDS=$(printf '%s' "$INPUT" | jq -r '.tool_input.commands // [] | map(.command) | join("\n")' 2>/dev/null)
        TARGET=$(extract_last_cd "$CMDS")
        if [ -n "$TARGET" ]; then
            case "$TARGET" in
                /*) CANDIDATE="$TARGET" ;;
                *)  CANDIDATE="$SESSION_CWD/$TARGET" ;;
            esac
        fi
        ;;
    *)
        exit 0
        ;;
esac

[ -z "$CANDIDATE" ] && exit 0
CANDIDATE=$(cd "$CANDIDATE" 2>/dev/null && pwd) || exit 0
[ -z "$CANDIDATE" ] && exit 0

DIR="$CANDIDATE"
REPO=""
while [ "$DIR" != "/" ] && [ -n "$DIR" ]; do
    if [ -d "$DIR/.git" ] || [ -d "$DIR/graphify-out" ]; then
        REPO="$DIR"
        break
    fi
    DIR=$(dirname "$DIR")
done

[ -z "$REPO" ] && exit 0

SENTINEL_DIR="${GRAPHIFY_SENTINEL_DIR:-$HOME/.cache/codeflare-hooks}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true
SENTINEL="$SENTINEL_DIR/graphify-active-cwd"

OLD=$(cat "$SENTINEL" 2>/dev/null || true)
[ "$OLD" = "$REPO" ] && exit 0

printf '%s\n' "$REPO" > "$SENTINEL"
exit 0
