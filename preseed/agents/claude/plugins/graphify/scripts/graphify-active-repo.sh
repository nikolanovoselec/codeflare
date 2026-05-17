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
#
# NOTE: this script intentionally does NOT use `set -e` plus a `trap ERR`.
# That combination interacts badly with `cond && action` idioms - a false
# `cond` exits status 1 at the statement level, fires the ERR trap, and
# silently kills the script with exit 0, dropping subsequent writes. We
# instead use explicit `|| true` on lines that tolerate failure and let
# unhandled errors surface in stderr.

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ -z "$TOOL" ] && exit 0

CANDIDATE=""
SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)

# Last `cd <target>` in a shell snippet, anchored on start / shell separator
# to skip false positives like `echo "cd x"`. Strips surrounding quotes so
# `cd "/path with spaces"` resolves correctly.
extract_last_cd() {
    local raw
    raw=$(printf '%s' "$1" \
        | grep -oE '(^|[;&|]|\n)[[:space:]]*cd[[:space:]]+("[^"]+"|'\''[^'\'']+'\''|[^;&|[:space:]]+)' \
        | tail -1 \
        | sed -E 's/^.*cd[[:space:]]+//')
    # Strip surrounding quotes
    raw="${raw%\"}"; raw="${raw#\"}"
    raw="${raw%\'}"; raw="${raw#\'}"
    printf '%s' "$raw"
}

# Pick the cloned target dir out of a `git clone` / `gh repo clone` line.
# Robust against flags like `-b BRANCH`, `--depth 1`, `--recurse-submodules`.
# Returns empty string if no explicit target found (caller falls back to
# session cwd, which is the right answer when clone uses the default name).
extract_clone_target() {
    local line="$1"
    # Drop the verb so we can scan flags + positional args
    line=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*(git[[:space:]]+clone|gh[[:space:]]+repo[[:space:]]+clone)[[:space:]]+//')

    local target=""
    local positional_seen=0
    # Split on whitespace; track positional args, skip flags (and their values
    # for the small set we know take values).
    set -- $line 2>/dev/null || true
    while [ $# -gt 0 ]; do
        case "$1" in
            -b|--branch|--depth|-o|--origin|--reference|-c|--config)
                shift; shift 2>/dev/null || break
                ;;
            -*)
                shift
                ;;
            *)
                positional_seen=$((positional_seen + 1))
                # Positional 1 is URL/owner-repo. Positional 2 is the target dir.
                if [ "$positional_seen" -eq 2 ]; then
                    target="$1"
                fi
                shift
                ;;
        esac
    done

    # If only one positional (URL with no explicit target), gh/git uses the
    # last URL segment as the dir name; let the caller handle that case.
    printf '%s' "$target"
}

case "$TOOL" in
    Bash)
        CANDIDATE="$SESSION_CWD"
        CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
        CLONE_LINE=$(printf '%s' "$CMD" | grep -oE '(^|[;&|])[[:space:]]*(git[[:space:]]+clone|gh[[:space:]]+repo[[:space:]]+clone)[[:space:]]+[^;&|]+' | tail -1 || true)
        if [ -n "$CLONE_LINE" ]; then
            CLONE_DIR=$(extract_clone_target "$CLONE_LINE")
            if [ -n "$CLONE_DIR" ]; then
                if [ -d "$SESSION_CWD/$CLONE_DIR" ]; then
                    CANDIDATE="$SESSION_CWD/$CLONE_DIR"
                elif [ -d "$CLONE_DIR" ]; then
                    CANDIDATE="$CLONE_DIR"
                fi
            fi
        fi
        ;;
    Edit|Write|Read|NotebookEdit)
        FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || true)
        [ -n "$FP" ] && CANDIDATE=$(dirname "$FP")
        ;;
    mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file)
        CODE=$(printf '%s' "$INPUT" | jq -r '.tool_input.code // empty' 2>/dev/null || true)
        TARGET=$(extract_last_cd "$CODE")
        if [ -n "$TARGET" ]; then
            case "$TARGET" in
                /*) CANDIDATE="$TARGET" ;;
                *)  CANDIDATE="$SESSION_CWD/$TARGET" ;;
            esac
        fi
        ;;
    mcp__context-mode__ctx_batch_execute)
        CMDS=$(printf '%s' "$INPUT" | jq -r '.tool_input.commands // [] | map(.command) | join("\n")' 2>/dev/null || true)
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

# Resolve. `cd` to the candidate may fail (e.g. spaces with bad quoting,
# dir does not exist); tolerate explicitly with `|| exit 0`.
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

# Vault is always-on in the global graph under the tag `user_vault`,
# seeded by init_user_vault() at boot. The vault has its own
# graphify-out/ subdir, so the walk-up loop above would otherwise treat
# $HOME/.user_vault as a "repo" and re-tag it with its basename
# (.user_vault) on every tool call that touches a vault file. That
# duplicates entries in the global manifest and lets the prune-on-switch
# logic later remove the basename-tag, leaving only the stale entrypoint
# snapshot. Exit silently when the resolved REPO is the vault root.
#
# Two guards: REPO is already canonicalized via `cd ... && pwd`, so we
# canonicalize $HOME the same way (symlinks, trailing slashes, mount
# differences). Basename check is belt-and-suspenders in case a symlink
# points at the vault from outside $HOME.
HOME_RESOLVED=$(cd "$HOME" 2>/dev/null && pwd)
# `[ -n "$HOME_RESOLVED" ] &&` guard: if $HOME is unset or unreadable, the
# canonicalized compare would degrade to `[ "$REPO" = "/.user_vault" ]`
# (silently inert). The basename fallback still catches the common case.
if { [ -n "$HOME_RESOLVED" ] && [ "$REPO" = "$HOME_RESOLVED/.user_vault" ]; } || [ "$(basename "$REPO")" = ".user_vault" ]; then
    exit 0
fi

SENTINEL_DIR="${GRAPHIFY_SENTINEL_DIR:-$HOME/.cache/codeflare-hooks}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true
SENTINEL="$SENTINEL_DIR/graphify-active-cwd"

OLD=$(cat "$SENTINEL" 2>/dev/null || true)
GRAPH_JSON="$REPO/graphify-out/graph.json"
GLOBAL_MANIFEST="${GRAPHIFY_GLOBAL_MANIFEST:-$HOME/.graphify/global-manifest.json}"

# Cheap fast-path: same repo as last fire AND graph.json hasn't been
# rebuilt since we last touched the sentinel -> nothing to do. Without
# this, every Bash/Edit/Write/ctx_execute call would spawn graphify
# (hundreds of MB of Python imports). The sentinel's mtime is the
# implicit "last reconciled at" timestamp; we touch it whenever we
# finish a global-graph update below.
SENTINEL_MTIME=$(stat -c '%Y' "$SENTINEL" 2>/dev/null || echo 0)
GRAPH_MTIME=$(stat -c '%Y' "$GRAPH_JSON" 2>/dev/null || echo 0)
if [ "$OLD" = "$REPO" ] && [ "$GRAPH_MTIME" -le "$SENTINEL_MTIME" ]; then
    exit 0
fi

# Writer-must-write-newline contract: the reader in enforce-graphify.sh
# uses `read -r ACTIVE_REPO < $SENTINEL || ACTIVE_REPO=""`. read -r
# returns non-zero when the input ends without a newline (EOF on first
# line), which trips the `||` clause and clobbers the value. Keep the
# `\n` in printf so the reader's contract holds.
printf '%s\n' "$REPO" > "$SENTINEL"

# Single-active-repo model: when the user switches FROM repo A's tree
# INTO repo B's tree, A's nodes should not linger in the global graph -
# subsequent mcp__graphify__* queries would otherwise return symbols
# from a project the user is no longer in. Prune A by tag (basename)
# before adding B.
#
# Same-tag case (two clones with the same basename, or branch switch
# within the same repo - which fires through the GRAPH_MTIME path
# above): skip the remove; the add below replaces the existing entry
# via graphify's source_hash dedup.
#
# flock serialises against the capture + vault-extract sonnets which
# also write the global graph.
if [ -n "$OLD" ] && [ "$OLD" != "$REPO" ] && command -v graphify >/dev/null 2>&1; then
    OLD_BASENAME=$(basename "$OLD")
    NEW_BASENAME=$(basename "$REPO")
    if [ "$OLD_BASENAME" != "$NEW_BASENAME" ] && [ -f "$GLOBAL_MANIFEST" ]; then
        # `.repos | has($tag)` returns a clean true/false; using `length`
        # on `.repos[$tag] // empty` would also return 0 for a present-
        # but-empty entry, falsely skipping the remove.
        STILL_PRESENT=$(jq -r --arg tag "$OLD_BASENAME" '.repos | has($tag)' "$GLOBAL_MANIFEST" 2>/dev/null || true)
        if [ "$STILL_PRESENT" = "true" ]; then
            # -w 5: bounded wait so a stuck capture / vault-extract sonnet
            # holding the global-graph lock cannot hang the user's tool
            # call indefinitely. Lock-acquire failure is swallowed by the
            # outer `|| true`; the next active-repo fire will retry.
            (flock -w 5 /tmp/graphify-global.lock graphify global remove "$OLD_BASENAME" >/dev/null 2>&1) || true
        fi
    fi
fi

# Add NEW to global graph (if it has one). Skips when the manifest
# already records this tag with a matching content hash, avoiding the
# graphify spawn on no-op fires. The graphify CLI itself also dedups
# via source_hash, so this pre-check is a perf optimisation, not a
# correctness gate.
if [ -f "$GRAPH_JSON" ] && command -v graphify >/dev/null 2>&1; then
    REPO_BASENAME=$(basename "$REPO")
    NEED_ADD=1
    if [ -f "$GLOBAL_MANIFEST" ]; then
        STORED_HASH=$(jq -r --arg tag "$REPO_BASENAME" '.repos[$tag].source_hash // empty' "$GLOBAL_MANIFEST" 2>/dev/null || true)
        # graphify stores the first 16 hex chars of the file SHA-256.
        # Length sanity check: if the manifest format ever changes (full
        # 64-char hash, base64, salted), refuse the optimisation and
        # force re-add - graphify's own source_hash dedup will then run
        # at the CLI level and either no-op or correctly replace.
        if [ -n "$STORED_HASH" ] && [ "${#STORED_HASH}" -eq 16 ]; then
            CURRENT_HASH=$(sha256sum "$GRAPH_JSON" 2>/dev/null | awk '{print substr($1,1,16)}')
            [ "$CURRENT_HASH" = "$STORED_HASH" ] && NEED_ADD=0
        fi
    fi
    if [ "$NEED_ADD" = "1" ]; then
        # -w 5 bound: same rationale as the remove above.
        (flock -w 5 /tmp/graphify-global.lock graphify global add "$GRAPH_JSON" --as "$REPO_BASENAME" >/dev/null 2>&1) || true
    fi
fi

# Bump sentinel mtime so the GRAPH_MTIME fast-path can skip subsequent
# fires until the next graph rebuild.
touch "$SENTINEL" 2>/dev/null || true

exit 0
