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
# Resolution: walks up from the candidate dir until a checkout (.git) is
# found. If none, exit 0 silently. Sentinel is only rewritten on change (no
# mtime churn).
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
    mcp__context-mode__ctx_batch|mcp__context-mode__ctx_batch_execute)
        CMDS=$(printf '%s' "$INPUT" | jq -r '.tool_input.commands // [] | map(if type == "string" then . else .command end) | join("\n")' 2>/dev/null || true)
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
    # A checkout is identified by .git and nothing else. Accepting a bare
    # graphify-out/ here let any directory that happened to hold graph output
    # mint a repo tag from its basename, and since that tag is what the
    # reconcile below adds and removes, a stray graphify-out/ next to the
    # clones was enough to evict the real repo from the global graph.
    # .git is a directory in a normal clone and a file in a worktree or
    # submodule; both are checkouts.
    if [ -e "$DIR/.git" ]; then
        REPO="$DIR"
        break
    fi
    DIR=$(dirname "$DIR")
done

[ -z "$REPO" ] && exit 0

# Vault is always-on in the global graph under the tag `user_vault`,
# seeded by init_user_vault() at boot and refreshed by the capture and
# vault-extract pipelines. It is never the active repo. A `git init` in
# the vault would otherwise make the walk-up resolve $HOME/Vault as a
# checkout and re-tag it with its basename (Vault) on every tool call
# that touches a vault file, duplicating the vault in the global manifest
# under a tag the reconcile below is free to remove. Exit silently when
# the resolved REPO is the vault root.
#
# Two guards: REPO is already canonicalized via `cd ... && pwd`, so we
# canonicalize $HOME the same way (symlinks, trailing slashes, mount
# differences). Basename check is belt-and-suspenders in case a symlink
# points at the vault from outside $HOME.
HOME_RESOLVED=$(cd "$HOME" 2>/dev/null && pwd)
# `[ -n "$HOME_RESOLVED" ] &&` guard: if $HOME is unset or unreadable, the
# canonicalized compare would degrade to `[ "$REPO" = "/Vault" ]`
# (silently inert). The basename fallback still catches the common case.
if { [ -n "$HOME_RESOLVED" ] && [ "$REPO" = "$HOME_RESOLVED/Vault" ]; } || [ "$(basename "$REPO")" = "Vault" ]; then
    exit 0
fi

SENTINEL_DIR="${GRAPHIFY_SENTINEL_DIR:-$HOME/.cache/codeflare-hooks}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true
SENTINEL="$SENTINEL_DIR/graphify-active-cwd"
# Second sentinel, because the first one's format is a contract: the MCP
# wrapper reads its first line as the active repo path.
STATE_SENTINEL="$SENTINEL_DIR/graphify-active-state"

OLD=$(cat "$SENTINEL" 2>/dev/null || true)
GRAPH_JSON="$REPO/graphify-out/graph.json"
GLOBAL_MANIFEST="${GRAPHIFY_GLOBAL_MANIFEST:-$HOME/.graphify/global-manifest.json}"

# Current branch, read straight out of HEAD rather than by shelling out to
# git, which the fast path exists to avoid. Detached HEAD yields the raw SHA,
# which is fine: it only has to differ when the checkout differs.
#
# In a worktree or submodule, .git is a file holding `gitdir: <path>` and HEAD
# lives at that path, so resolving it is what makes the branch compare work
# for those checkouts at all. An empty BRANCH compares equal to an empty
# OLD_BRANCH, so failing to resolve here would silently disable the branch
# trigger rather than fall back to reconciling.
GIT_DIR="$REPO/.git"
if [ -f "$GIT_DIR" ]; then
    GITDIR_LINE=$(cat "$GIT_DIR" 2>/dev/null || true)
    case "$GITDIR_LINE" in
        "gitdir: "*)
            GIT_DIR="${GITDIR_LINE#gitdir: }"
            # A relative gitdir is relative to the checkout that named it.
            case "$GIT_DIR" in
                /*) ;;
                *) GIT_DIR="$REPO/$GIT_DIR" ;;
            esac
            ;;
    esac
fi

BRANCH=""
if [ -f "$GIT_DIR/HEAD" ]; then
    HEAD_REF=$(cat "$GIT_DIR/HEAD" 2>/dev/null || true)
    case "$HEAD_REF" in
        "ref: refs/heads/"*) BRANCH="${HEAD_REF#ref: refs/heads/}" ;;
        *) BRANCH="$HEAD_REF" ;;
    esac
fi

# What the checkout looks like now, versus what it looked like when we last
# reconciled. Tab-separated because git forbids control characters in ref
# names, so a branch name can never contain the separator.
if [ -f "$GRAPH_JSON" ]; then
    GRAPH_STATE="graph"
else
    GRAPH_STATE="nograph"
fi
TAB=$(printf '\t')
OLD_STATE=$(cat "$STATE_SENTINEL" 2>/dev/null || true)
OLD_BRANCH="${OLD_STATE%%"$TAB"*}"
OLD_GRAPH_STATE="${OLD_STATE#*"$TAB"}"
STATE="${BRANCH}${TAB}${GRAPH_STATE}"

# Cheap fast-path: same repo as last fire, same branch, graph still in the
# same presence state, AND graph.json hasn't been rebuilt since we last
# touched the sentinel -> nothing to do. Without this, every
# Bash/Edit/Write/ctx_execute call would spawn graphify (hundreds of MB of
# Python imports). The sentinel's mtime is the implicit "last reconciled at"
# timestamp; we touch it whenever we finish a global-graph update below.
#
# Branch and graph-presence are here because mtime alone cannot see either.
# A branch switch is a reconcile trigger, not a rebuild trigger: it re-runs
# the invariant below so a branch whose graph is absent stops publishing the
# previous branch's nodes, while rebuilding the graph itself stays manual per
# REQ-VAULT-004. A graph deleted in place moves mtime backwards to 0, which
# compares as "not rebuilt" and would otherwise leave the dead tag published
# forever.
SENTINEL_MTIME=$(stat -c '%Y' "$SENTINEL" 2>/dev/null || echo 0)
GRAPH_MTIME=$(stat -c '%Y' "$GRAPH_JSON" 2>/dev/null || echo 0)
if [ "$OLD" = "$REPO" ] && [ "$GRAPH_MTIME" -le "$SENTINEL_MTIME" ] \
   && [ "$OLD_BRANCH" = "$BRANCH" ] && [ "$OLD_GRAPH_STATE" = "$GRAPH_STATE" ]; then
    exit 0
fi

# Manifest/hash decisions and their writes share one bounded writer lock.
# A timeout or failed transaction leaves the prior sentinel retryable.
RECONCILED=1
REPO_BASENAME=$(basename "$REPO")
if command -v graphify >/dev/null 2>&1; then
    if ! flock -w 5 /run/codeflare/locks/graphify-global.lock bash -s -- "$GRAPH_JSON" "$REPO_BASENAME" "$GLOBAL_MANIFEST" <<'RECONCILE'
set -e
graph_json="$1"
repo_tag="$2"
manifest="$3"
command -v graphify >/dev/null 2>&1 || exit 127
keep_tag=""
need_add=0
current_hash=""
if [ -f "$graph_json" ]; then
    keep_tag="$repo_tag"
    need_add=1
    current_hash=$(sha256sum "$graph_json" | awk '{print substr($1,1,16)}')
    if [ -f "$manifest" ]; then
        stored_hash=$(jq -r --arg tag "$repo_tag" '.repos[$tag].source_hash // empty' "$manifest")
        stored_path=$(jq -r --arg tag "$repo_tag" '.repos[$tag].source_path // empty' "$manifest")
        if [ "$stored_hash" = "$current_hash" ] && [ "$stored_path" = "$graph_json" ]; then
            need_add=0
        fi
    fi
fi
# Decide from the manifest ONLY AFTER acquiring the shared writer lock.
STALE_TAGS=()
if [ -f "$manifest" ]; then
    stale=$(jq -r --arg keep "$keep_tag" '.repos // {} | keys[] | select(. != "user_vault" and . != $keep)' "$manifest")
    while IFS= read -r tag; do
        [ -z "$tag" ] || STALE_TAGS+=("$tag")
    done <<< "$stale"
fi
for tag in "${STALE_TAGS[@]}"; do
    graphify global remove "$tag" >/dev/null 2>&1 || exit 1
done
if [ "$need_add" = "1" ]; then
    graphify global add "$graph_json" --as "$repo_tag" >/dev/null 2>&1 || exit 1
    # Upstream global_add returns on equal hash before updating source_path.
    # Compatibility repair: identical bytes need only atomic provenance rebinding,
    # never removal/re-addition or a graph rebuild. Preserve every other field.
    if [ -f "$manifest" ] && jq -e --arg tag "$repo_tag" --arg hash "$current_hash" --arg path "$graph_json" \
        '.repos[$tag].source_hash == $hash and .repos[$tag].source_path != $path' "$manifest" >/dev/null; then
        temporary=$(mktemp "${manifest}.tmp.XXXXXX")
        trap 'rm -f -- "$temporary"' EXIT
        jq --arg tag "$repo_tag" --arg path "$graph_json" '.repos[$tag].source_path = $path' "$manifest" > "$temporary"
        chmod --reference="$manifest" "$temporary"
        mv -f -- "$temporary" "$manifest"
    fi
fi
RECONCILE
    then
        RECONCILED=0
    fi
fi

if [ "$RECONCILED" = "1" ]; then
    # Writer-must-write-newline contract: `read -r` readers treat an unterminated
    # first line as failure and otherwise clobber the active path.
    printf '%s\n' "$REPO" > "$SENTINEL"
    printf '%s\n' "$STATE" > "$STATE_SENTINEL"
    # Bump mtime only after the global graph and sentinel describe the same state.
    touch "$SENTINEL" 2>/dev/null || true
fi

exit 0
