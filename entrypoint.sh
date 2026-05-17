#!/bin/bash
set -euo pipefail
# Build version: ISO timestamp of container start time
BUILD_VERSION="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Codeflare Container Entrypoint - rclone bisync version
# Health metrics now consolidated into terminal server on port 8080

echo "[entrypoint] ============================================"
echo "[entrypoint] BUILD VERSION: $BUILD_VERSION"
echo "[entrypoint] ============================================"
echo "[entrypoint] Starting codeflare container..."
echo "[entrypoint] Bash version: $BASH_VERSION"
echo "[entrypoint] Date: $(date)"
echo "[entrypoint] PWD: $(pwd)"

# Initialize PID placeholders
TERMINAL_PID=0

echo "[entrypoint] pwd: $(pwd)"
echo "[entrypoint] HOME: $HOME"
echo "[entrypoint] node version: $(node --version)"

# Check R2 environment variables (configured/missing status only)
echo "[entrypoint] === R2 ENV STATUS ===" | tee /tmp/sync.log
echo "R2_BUCKET_NAME: ${R2_BUCKET_NAME:+configured}" | tee -a /tmp/sync.log
echo "R2_ENDPOINT: ${R2_ENDPOINT:+configured}" | tee -a /tmp/sync.log
echo "R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID:+configured}" | tee -a /tmp/sync.log
echo "R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY:+configured}" | tee -a /tmp/sync.log
echo "R2_ACCOUNT_ID: ${R2_ACCOUNT_ID:+configured}" | tee -a /tmp/sync.log
echo "[entrypoint] === END R2 ENV STATUS ===" | tee -a /tmp/sync.log

# Set TERM for proper terminal handling
TERM=xterm-256color
export TERM

# === Fast Start: control auto-update behavior ===
if [ "${FAST_CLI_START:-true}" = "false" ]; then
    # Unset Dockerfile-level vars so tools CAN auto-update
    unset DISABLE_AUTOUPDATER OPENCODE_DISABLE_AUTOUPDATE DISABLE_INSTALLATION_CHECKS
else
    # Ensure all disable vars are set (use bundled versions)
    export DISABLE_AUTOUPDATER=1
    export OPENCODE_DISABLE_AUTOUPDATE=1
    export COPILOT_AUTO_UPDATE=false
fi

# User directories (local disk)
USER_HOME="/home/user"
USER_WORKSPACE="$USER_HOME/workspace"
USER_CLAUDE_DIR="$USER_HOME/.claude"
USER_CLAUDE_JSON="$USER_HOME/.claude.json"

# Create user home directory structure
mkdir -p "$USER_HOME" "$USER_WORKSPACE" "$USER_CLAUDE_DIR"
export HOME="$USER_HOME"

# Force HTML visualization generation regardless of graph size.
# Default graphify limit is 5000 nodes; codeflare repos routinely exceed this.
# Codeflare policy: graph.html is never skipped (user directive).
export GRAPHIFY_VIZ_NODE_LIMIT=100000

# Track sync status
SYNC_STATUS="pending"
SYNC_ERROR=""
SYNC_DAEMON_PID=""

# ============================================================================
# rclone configuration
# ============================================================================
create_rclone_config() {
    echo "[entrypoint] Creating rclone config..."

    # Check required variables
    if [ -z "${R2_ACCESS_KEY_ID:-}" ]; then
        SYNC_ERROR="R2_ACCESS_KEY_ID not set"
        SYNC_STATUS="skipped"
        echo "[entrypoint] WARNING: $SYNC_ERROR"
        return 1
    fi

    if [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
        SYNC_ERROR="R2_SECRET_ACCESS_KEY not set"
        SYNC_STATUS="skipped"
        echo "[entrypoint] WARNING: $SYNC_ERROR"
        return 1
    fi

    if [ -z "${R2_BUCKET_NAME:-}" ]; then
        SYNC_ERROR="R2_BUCKET_NAME not set"
        SYNC_STATUS="skipped"
        echo "[entrypoint] WARNING: $SYNC_ERROR"
        return 1
    fi

    if [ -z "${R2_ENDPOINT:-}" ]; then
        SYNC_ERROR="R2_ENDPOINT not set"
        SYNC_STATUS="skipped"
        echo "[entrypoint] WARNING: $SYNC_ERROR"
        return 1
    fi

    echo "[entrypoint] R2 credentials: configured"

    # Create rclone config directory
    mkdir -p "$USER_HOME/.config/rclone"

    # Write rclone config (quoted heredoc to prevent shell expansion, then substitute)
    cat > "$USER_HOME/.config/rclone/rclone.conf" << 'RCLONE_EOF'
[r2]
type = s3
provider = Cloudflare
access_key_id = PLACEHOLDER_ACCESS_KEY
secret_access_key = PLACEHOLDER_SECRET_KEY
endpoint = PLACEHOLDER_ENDPOINT
acl = private
no_check_bucket = true
disable_checksum = true
RCLONE_EOF
    # Validate credentials before sed substitution (delimiter is |, so | in values would break it)
    if echo "$R2_ACCESS_KEY_ID" | grep -qE '[|]'; then
        echo "[entrypoint] ERROR: R2_ACCESS_KEY_ID contains pipe character, cannot substitute safely" >&2
        return 1
    fi
    if ! echo "$R2_ACCESS_KEY_ID" | grep -qE '^[a-f0-9]+$'; then
        echo "[entrypoint] WARNING: R2_ACCESS_KEY_ID contains unexpected characters (expected hex)" >&2
    fi
    if echo "$R2_SECRET_ACCESS_KEY" | grep -qE '[|]'; then
        echo "[entrypoint] ERROR: R2_SECRET_ACCESS_KEY contains pipe character, cannot substitute safely" >&2
        return 1
    fi
    if ! echo "$R2_SECRET_ACCESS_KEY" | grep -qE '^[a-f0-9]+$'; then
        echo "[entrypoint] WARNING: R2_SECRET_ACCESS_KEY contains unexpected characters (expected hex)" >&2
    fi
    if echo "$R2_ENDPOINT" | grep -qE '[|]'; then
        echo "[entrypoint] ERROR: R2_ENDPOINT contains pipe character, cannot substitute safely" >&2
        return 1
    fi

    sed -i "s|PLACEHOLDER_ACCESS_KEY|${R2_ACCESS_KEY_ID}|" "$USER_HOME/.config/rclone/rclone.conf"
    sed -i "s|PLACEHOLDER_SECRET_KEY|${R2_SECRET_ACCESS_KEY}|" "$USER_HOME/.config/rclone/rclone.conf"
    sed -i "s|PLACEHOLDER_ENDPOINT|${R2_ENDPOINT}|" "$USER_HOME/.config/rclone/rclone.conf"

    # Append SSE-C config for R2 encryption at rest (optional)
    # Uses sse_customer_key_base64 (not sse_customer_key) because ENCRYPTION_KEY is base64-encoded.
    # rclone auto-computes the MD5 when using the base64 variant.
    if [ -n "${ENCRYPTION_KEY:-}" ]; then
        cat >> "$USER_HOME/.config/rclone/rclone.conf" << SSEEOF
sse_customer_key_base64 = ${ENCRYPTION_KEY}
sse_customer_algorithm = AES256
SSEEOF
        echo "[entrypoint] R2 SSE-C encryption configured for rclone"
    fi

    chmod 600 "$USER_HOME/.config/rclone/rclone.conf"
    echo "[entrypoint] rclone config created"
    return 0
}

# ============================================================================
# Sync functions - rclone bisync with newest-wins
# ============================================================================

# Initialize sync log
init_sync_log() {
    echo "=== Sync Log Started: $(date '+%Y-%m-%d %H:%M:%S') ===" > /tmp/sync.log
}

# Rclone config path (set after create_rclone_config)
RCLONE_CONFIG="$USER_HOME/.config/rclone/rclone.conf"

# Shared rclone filter rules (used by all sync functions)
# SYNC_MODE controls what syncs from workspace/:
#   "none"     = do not sync workspace at all
#   "full"     = entire workspace folder (for persistent storage across stop/resume)
#   "metadata" = only agent config files and .claude/ per repo (lightweight, restore later if needed)
SYNC_MODE="${SYNC_MODE:-none}"

# Common exclusions shared by all sync modes
#
# WHAT WE SYNC (and why):
#   .claude.json              - Main Claude Code config: MCP servers, settings, permissions, hooks
#   .claude/.credentials.json - Claude OAuth tokens (login persists across sessions)
#   .claude/settings.json     - User rules, hooks, slash commands, agent config
#   .claude/plugins/          - Installed plugins & marketplace registry (except cache/)
#   .claude/plans/            - Plans from plan mode (may be useful across sessions)
#   .claude/projects/         - Conversation history & project-level context
#   .claude/tasks/            - Task tracking (may be useful for --resume)
#   .claude/todos/            - Todo lists (may be useful for --resume)
#   .codex/auth.json          - Codex OAuth/API credentials
#   .codex/config.toml        - Codex model config, project trust levels
#   .codex/skills/            - Installed Codex skills (skill-installer, skill-creator)
#   .gemini/oauth_creds.json  - Gemini OAuth tokens
#   .gemini/settings.json     - Gemini user settings
#   .gemini/*.json            - Gemini account info, trusted folders, state
#   .config/gh/               - GitHub CLI auth (oauth_token) and config (aliases, protocol)
#   .config/lazygit/          - Lazygit configuration
#   .config/opencode/         - OpenCode plugin config
#   .gitconfig                - Git credential helpers (routes auth through gh)
#   .local/share/opencode/opencode.db - Pre-initialized SQLite (migration state)
#   .local/state/lazygit/     - Lazygit state
#   workspace/**/.git/        - Git history — needed so sessions can git pull without re-cloning
#
# WHAT WE EXCLUDE (and why):
RCLONE_FILTERS_COMMON=(
    # Shell config — regenerated by entrypoint.sh on every container start
    --filter "- .bashrc"
    --filter "- .bash_profile"

    # Package manager caches — regenerated on npm/bun install
    --filter "- .npm/**"
    --filter "- .bun/**"

    # All of ~/.cache/ — includes puppeteer Chrome binaries (~618MB), claude-cli MCP
    # session logs, opencode cache, vscode-ripgrep binary. All regenerated on demand.
    # Previously only .cache/rclone/** was excluded, leaking hundreds of MB to R2.
    --filter "- .cache/**"

    # rclone config — contains R2 secrets, regenerated by create_rclone_config() on startup
    --filter "- .config/rclone/**"

    # Node modules — restored via npm install, often 100s of MB
    --filter "- **/node_modules/**"

    # Claude Code native installer artifacts (removed from build, but exclude leftover data)
    --filter "- .local/share/claude/**"      # native installer version binaries (228MB)

    # Copilot — auto-update binary, session logs, and ephemeral state
    --filter "- .copilot/logs/**"            # session logs
    --filter "- .copilot/pkg/**"             # auto-update binary download (~35MB)
    --filter "- .copilot/session-state/**"   # per-session checkpoints

    # Codex — session recordings and SQLite temp files
    --filter "- .codex/sessions/**"          # TUI session recordings
    --filter "- .codex/state*.sqlite-shm"    # SQLite shared memory (ephemeral, corrupt on restore)
    --filter "- .codex/state*.sqlite-wal"    # SQLite WAL (ephemeral, corrupt on restore)

    # Claude Code — session-specific ephemeral data, regenerated per session
    --filter "- .claude/plugins/marketplaces/**"  # marketplace git clones (ephemeral, re-cloned from remote on demand)
    --filter "- .claude/cache/**"            # changelog cache
    --filter "- .claude/debug/**"            # debug logs
    --filter "- .claude/file-history/**"     # per-session file edit history, grows unbounded
    --filter "- .claude/session-env/**"      # session environment variables
    --filter "- .claude/shell-snapshots/**"  # session shell state snapshots
    --filter "- .claude/stats-cache.json"    # regenerated usage stats
    --filter "- .claude/mcp-*.json"            # MCP auth cache (transient, created/deleted in ms — causes bisync fatal error if listed then deleted before copy)
    --filter "- .claude.json.backup.*"       # auto-generated backups, accumulate endlessly

    # Claude Code — subagent transcripts (results captured in main transcript, never re-read)
    --filter "- .claude/projects/**/subagents/**"

    # Claude Code — tool result artifacts (ephemeral, never re-read, 26MB+ per long session)
    --filter "- .claude/projects/**/tool-results/**"

    # Claude Code — ephemeral session state (regenerated per session)
    --filter "- .claude/usage-data/**"       # insights reports (regenerated on /insights)
    --filter "- .claude/backups/**"          # settings backups (settings.json itself is synced)
    --filter "- .claude/tasks/**"            # task state (ephemeral per session)
    --filter "- .claude/sessions/**"         # session metadata
    --filter "- .claude/history.jsonl"       # command history (nice-to-have, not critical)

    # Codex — ephemeral session data and caches
    --filter "- .codex/log/**"               # TUI session logs
    --filter "- .codex/models_cache.json"    # regenerated model list
    --filter "- .codex/.personality_migration" # one-time migration marker
    --filter "- .codex/shell_snapshots/**"   # session shell snapshots
    --filter "- .codex/tmp/**"               # temp lock files
    --filter "- .codex/.tmp/**"              # plugin clones + sync temp files (17MB+, regenerated)
    --filter "- .codex/version.json"         # version check cache

    # Memory capture - exclude all counter files (ephemeral per-session).
    # ~/.memory/ as a whole survived the MCP-memory removal because the
    # capture-hook gate (memory-capture.sh) still writes counter + .vars
    # files there. No session-*.jsonl files are written any more; legacy
    # ones from pre-vault sessions sit on R2 unread until the user
    # deletes them.
    --filter "- .memory/counter/**"

    # Perl CPAN cache — created by Perl module installs during build, regenerated
    --filter "- .cpan/**"

    # Gemini CLI — tmp contains a downloaded ripgrep binary (~5MB) and session chat logs
    --filter "- .gemini/tmp/**"

    # OpenCode — session logs and SQLite temp files (WAL/SHM cause sync conflicts)
    --filter "- .local/share/opencode/log/**"
    --filter "- .local/share/opencode/opencode.db-shm"
    --filter "- .local/share/opencode/opencode.db-wal"

    # MCP server state — logs and thread history, ephemeral
    --filter "- .local/state/**"

    # Wrangler - deploy logs and per-user state, regenerated. Covers the
    # root-level $HOME/.wrangler/ which is distinct from the XDG-located
    # $HOME/.config/.wrangler/ (the latter is subsumed by the .config/**
    # rule below).
    --filter "- .wrangler/**"

    # ~/.config/** - tool configs that all regenerate on first use:
    # configstore (npm), fish (shell), opencode, uv (Python tooling),
    # wrangler (XDG location), rclone (R2 secrets).
    # No codeflare-managed state lives under .config/ - all of that sits
    # at $HOME root (.claude.json, .claude/, .codex/, .gemini/, .copilot/).
    --filter "- .config/**"

    # Persistent user folders (REQ-MEMORY-100, REQ-FS-010) - the vault and
    # the user-facing Uploads/Temporary trays must sync to R2. The Vault
    # include MUST precede the global graphify-out exclude below: rclone
    # uses first-match, so without this line the vault's own graphify-out/
    # would be caught by the exclude pattern and silently never bisync.
    --filter "+ Vault/**"
    --filter "+ Uploads/**"
    --filter "+ Temporary/**"

    # Global graphify graph is rebuilt at boot from per-project graphs and
    # the vault. Keep it ephemeral; it has no R2 round-trip value.
    --filter "- .graphify/**"

    # graphify (REQ-AGENT-023) - knowledge-graph outputs live in the repo,
    # not in R2. Repo owners commit graphify-out/ to git; the working tree
    # gets them on clone. Repos without push permission keep graphify-out/
    # local and ephemeral. R2 bisync does not touch graphify-out/ either way.
    --filter "- **/graphify-out/**"
)

if [ "$SYNC_MODE" = "metadata" ]; then
    RCLONE_FILTERS=(
        "${RCLONE_FILTERS_COMMON[@]}"
        --filter "+ workspace/**/"
        --filter "+ workspace/CLAUDE.md"
        --filter "+ workspace/**/CLAUDE.md"
        --filter "+ workspace/.claude/**"
        --filter "+ workspace/**/.claude/**"
        --filter "- workspace/**"
    )
elif [ "$SYNC_MODE" = "none" ]; then
    RCLONE_FILTERS=(
        "${RCLONE_FILTERS_COMMON[@]}"
        --filter "- workspace/"
        --filter "- workspace/**"
    )
else
    RCLONE_FILTERS=(
        "${RCLONE_FILTERS_COMMON[@]}"
    )
fi

# ============================================================================
# Recovery filter for vanishing files
# ============================================================================
RECOVERY_FILTER_FILE="/tmp/rclone-recovery-filters.txt"

# Initialize empty recovery filter file (populated on bisync failure)
init_recovery_filters() {
    : > "$RECOVERY_FILTER_FILE"
    echo "[entrypoint] Recovery filter initialized: $RECOVERY_FILTER_FILE"
}

# Parse rclone output for vanishing file errors and add to recovery filter.
# Returns 0 if recoverable files found (caller should retry), 1 if not.
recover_vanished_files() {
    local output="$1"
    local recovered=0

    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local file_path
        file_path=$(echo "$line" | grep -oP '(?<=lstat /home/user/)\S+(?=: no such file)' || true)
        [ -z "$file_path" ] && continue

        # Workspace files are user code — don't exclude, but still flag as recoverable (triggers retry)
        if [[ "$file_path" == workspace/* ]]; then
            echo "[sync-recovery] Workspace file vanished: $file_path (will retry without excluding)" | tee -a /tmp/sync.log
            recovered=1
            continue
        fi

        # Check if already excluded
        if grep -qF "- $file_path" "$RECOVERY_FILTER_FILE" 2>/dev/null; then
            continue
        fi

        echo "- $file_path" >> "$RECOVERY_FILTER_FILE"
        echo "[sync-recovery] Excluded vanished file: $file_path" | tee -a /tmp/sync.log
        recovered=1
    done <<< "$(echo "$output" | grep 'failed to open source object.*no such file')"

    return $((1 - recovered))  # 0 = recoverable, 1 = nothing to recover
}

init_recovery_filters

# Step 1: One-way sync FROM R2 TO local (restore user data)
# This ensures existing credentials, plugins, etc. are restored BEFORE anything else runs
# Workspace sync controlled by SYNC_MODE (none, full, or metadata-only)
# IMPORTANT: Uses timeout to prevent infinite hangs on network issues
initial_sync_from_r2() {
    local SYNC_TIMEOUT=120  # 2 minutes max for initial sync
    echo "[entrypoint] Step 1: One-way sync R2 → local (max ${SYNC_TIMEOUT}s)..." | tee -a /tmp/sync.log

    if timeout $SYNC_TIMEOUT rclone sync "r2:$R2_BUCKET_NAME/" "$USER_HOME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --fast-list \
        --size-only \
        --min-size 1B \
        --multi-thread-streams 4 \
        --transfers 32 \
        --checkers 32 \
        --contimeout 10s \
        --timeout 30s \
        -v 2>&1 | tee -a /tmp/sync.log; then
        SYNC_RESULT=0
    else
        SYNC_RESULT=$?
    fi
    if [ $SYNC_RESULT -eq 0 ]; then
        echo "[entrypoint] Step 1 complete: User data restored from R2"
        return 0
    elif [ $SYNC_RESULT -eq 124 ]; then
        SYNC_ERROR="rclone sync timed out after ${SYNC_TIMEOUT}s"
        echo "[entrypoint] WARNING: $SYNC_ERROR (continuing anyway)"
        return 0  # Don't block startup
    else
        SYNC_ERROR="rclone sync R2→local failed with code $SYNC_RESULT"
        echo "[entrypoint] WARNING: $SYNC_ERROR"
        return 1
    fi
}

# Step 2: Establish bisync baseline (after data is restored)
# IMPORTANT: Uses timeout to prevent infinite hangs
# Recovery: if a vanishing file causes failure, excludes it and retries (max 3 attempts)
establish_bisync_baseline() {
    local BISYNC_TIMEOUT=600  # 10 minutes max for baseline (large buckets with many files)
    local MAX_RECOVERY=3

    for recovery_attempt in $(seq 1 $MAX_RECOVERY); do
        echo "[entrypoint] Step 2: Establishing bisync baseline (max ${BISYNC_TIMEOUT}s, attempt $recovery_attempt/$MAX_RECOVERY)..." | tee -a /tmp/sync.log

        BASELINE_OUTPUT=$(mktemp)
        if timeout $BISYNC_TIMEOUT rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
            --config "$RCLONE_CONFIG" \
            "${RCLONE_FILTERS[@]}" \
            --filter-from "$RECOVERY_FILTER_FILE" \
            --resync \
            --fast-list \
            --min-size 1B \
            --conflict-resolve newer \
            --resilient \
            --recover \
            --check-sync=false \
            --ignore-checksum \
            --s3-upload-cutoff 0 \
            --max-delete 100 \
            --retries 3 --retries-sleep 10s \
            --transfers 32 --checkers 32 -v > "$BASELINE_OUTPUT" 2>&1; then
            SYNC_RESULT=0
        else
            SYNC_RESULT=$?
        fi
        cat "$BASELINE_OUTPUT" >> /tmp/sync.log
        cat "$BASELINE_OUTPUT" >&2

        if [ $SYNC_RESULT -eq 0 ]; then
            rm -f "$BASELINE_OUTPUT"
            echo "[entrypoint] Step 2 complete: Bisync baseline established" | tee -a /tmp/sync.log
            touch /tmp/.bisync-initialized
            SYNC_STATUS="success"
            return 0
        elif [ $SYNC_RESULT -eq 124 ]; then
            rm -f "$BASELINE_OUTPUT"
            echo "[entrypoint] WARNING: Bisync baseline timed out after ${BISYNC_TIMEOUT}s" | tee -a /tmp/sync.log >&2
            touch /tmp/.bisync-initialized
            SYNC_STATUS="timeout"
            return 0  # Don't fail, just skip daemon
        fi

        # Check if vanishing file caused the failure — recover and retry
        if recover_vanished_files "$(cat "$BASELINE_OUTPUT")"; then
            rm -f "$BASELINE_OUTPUT"
            echo "[sync-recovery] Baseline attempt $recovery_attempt: excluded vanished file(s), retrying..." | tee -a /tmp/sync.log
            rm -f "$HOME/.cache/rclone/bisync"/*.lck 2>/dev/null
            continue
        fi

        # Non-recoverable error
        rm -f "$BASELINE_OUTPUT"
        break
    done

    SYNC_ERROR="rclone bisync --resync failed with code $SYNC_RESULT"
    SYNC_STATUS="failed"
    echo "[entrypoint] ERROR: $SYNC_ERROR" | tee -a /tmp/sync.log >&2
    return 1
}

# Regular bisync (after baseline is established)
# Syncs config, credentials. Workspace included when SYNC_MODE=full; caches always excluded.
bisync_with_r2() {
    local verbose_flag="${1:--v}"  # Default to -v (verbose); pass "" for quiet
    local verbose_args=()
    if [ -n "$verbose_flag" ]; then
        verbose_args=("$verbose_flag")
    fi
    echo "[sync] Running bidirectional sync..." | tee -a /tmp/sync.log

    # Clear stale bisync lock if no bisync is running
    local LOCK_FILE="/home/user/.cache/rclone/bisync/home_user..r2_${R2_BUCKET_NAME}.lck"
    local BISYNC_RUNNING=0
    if pgrep -f "rclone bisync" >/dev/null 2>&1; then
        BISYNC_RUNNING=1
    fi
    if [ -f "$LOCK_FILE" ] && [ "$BISYNC_RUNNING" -eq 0 ]; then
        echo "[sync] Removing stale bisync lock: $LOCK_FILE" | tee -a /tmp/sync.log
        rclone deletefile "$LOCK_FILE" 2>/dev/null || rm -f "$LOCK_FILE"
    fi

    # Write output to known location so daemon can read it for recovery
    SYNC_OUTPUT="/tmp/last-bisync-output.txt"

    # Run bisync (includes recovery filter for dynamically excluded vanished files)
    if rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --filter-from "$RECOVERY_FILTER_FILE" \
        --fast-list \
        --min-size 1B \
        --conflict-resolve newer \
        --resilient \
        --recover \
        --check-sync=false \
        --ignore-checksum \
        --s3-upload-cutoff 0 \
        --max-delete 100 \
        --retries 3 --retries-sleep 10s \
        --transfers 32 --checkers 32 "${verbose_args[@]}" > "$SYNC_OUTPUT" 2>&1; then
        RESULT=0
    else
        RESULT=$?
    fi
    cat "$SYNC_OUTPUT" >> /tmp/sync.log
    cat "$SYNC_OUTPUT"

    # Note: SYNC_OUTPUT (/tmp/last-bisync-output.txt) is NOT deleted here.
    # The daemon reads it for vanishing-file recovery. It's overwritten each invocation.

    # Auto-clean conflict artifacts after successful bisync
    if [ $RESULT -eq 0 ]; then
        find /home/user -name "*.conflict*" -type f -delete 2>/dev/null || true
    fi
    return $RESULT
}

# ============================================================================
# Cleanup old Claude Code session transcripts — keep only the 5 most recent
# ============================================================================
cleanup_old_transcripts() {
    local PROJECTS_DIR="$USER_HOME/.claude/projects"
    local KEEP_COUNT=5

    # Find all session transcript JSONL files across all project dirs
    local ALL_TRANSCRIPTS
    ALL_TRANSCRIPTS=$(find "$PROJECTS_DIR" -maxdepth 2 -name "*.jsonl" -not -path "*/subagents/*" 2>/dev/null | sort -t/ -k6) || true
    local COUNT
    COUNT=$(echo "$ALL_TRANSCRIPTS" | grep -c . 2>/dev/null) || COUNT=0

    if [ "$COUNT" -le "$KEEP_COUNT" ]; then
        return 0
    fi

    # Sort by modification time (newest first), delete all but the newest KEEP_COUNT
    local TO_DELETE
    TO_DELETE=$(echo "$ALL_TRANSCRIPTS" | xargs ls -t 2>/dev/null | tail -n +$((KEEP_COUNT + 1))) || true

    [ -z "$TO_DELETE" ] && return 0

    local DELETED=0
    for transcript in $TO_DELETE; do
        [ -f "$transcript" ] || continue
        rm -f "$transcript"
        DELETED=$((DELETED + 1))
    done

    if [ "$DELETED" -gt 0 ]; then
        echo "[sync-daemon] Cleaned up $DELETED old session transcript(s), kept newest $KEEP_COUNT" | tee -a /tmp/sync.log
    fi
}

# ============================================================================
# Background sync daemon - bisync every 60 seconds
# ============================================================================
start_sync_daemon() {
    echo "[entrypoint] Starting background bisync daemon (every 60s)..."
    local CONSECUTIVE_FAILURES=0

    while true; do
        sleep 60

        # Rotate sync log if too large (keep last 256KB when exceeding 512KB)
        if [ -f /tmp/sync.log ] && [ "$(stat -c%s /tmp/sync.log 2>/dev/null || echo 0)" -gt 524288 ]; then
            tail -c 262144 /tmp/sync.log > /tmp/sync.log.tmp && mv /tmp/sync.log.tmp /tmp/sync.log
            echo "[sync-daemon] Log rotated (exceeded 512KB)" | tee -a /tmp/sync.log
        fi

        # Cleanup old session transcripts before sync (sequential — no race with bisync).
        # Run in subshell to prevent set -e from killing the daemon on cleanup failure.
        (cleanup_old_transcripts) || true

        echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Running periodic bisync..." | tee -a /tmp/sync.log

        # Use bisync for true bidirectional sync with newest-wins (quiet mode for periodic runs)
        if bisync_with_r2 ""; then
            SYNC_RESULT=0
        else
            SYNC_RESULT=$?
        fi

        if [ $SYNC_RESULT -eq 0 ]; then
            CONSECUTIVE_FAILURES=0
            echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Bisync completed successfully" | tee -a /tmp/sync.log
            update_sync_status "success" "null"
        else
            # Try vanishing-file recovery before counting as failure
            if recover_vanished_files "$(cat /tmp/last-bisync-output.txt 2>/dev/null)"; then
                echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Vanished file recovered, retrying immediately..." | tee -a /tmp/sync.log
                rm -f "$HOME/.cache/rclone/bisync"/*.lck 2>/dev/null
                if bisync_with_r2 ""; then
                    CONSECUTIVE_FAILURES=0
                    echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Recovery bisync succeeded" | tee -a /tmp/sync.log
                    update_sync_status "success" "null"
                    continue
                fi
            fi

            CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
            echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Bisync failed with exit code $SYNC_RESULT (failure $CONSECUTIVE_FAILURES/3)" | tee -a /tmp/sync.log
            update_sync_status "failed" "Bisync exit code $SYNC_RESULT"

            # Exit code 7 with missing listing files = no prior bisync state exists.
            # Skip straight to --resync instead of waiting for 3 failures.
            local LISTING_GLOB="/home/user/.cache/rclone/bisync/home_user..r2_${R2_BUCKET_NAME}.path*.lst"
            local HAS_LISTINGS=false
            # shellcheck disable=SC2086
            ls $LISTING_GLOB >/dev/null 2>&1 && HAS_LISTINGS=true

            if [ "$HAS_LISTINGS" = "false" ] && [ $SYNC_RESULT -eq 7 ]; then
                echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') No listing files found — immediate resync" | tee -a /tmp/sync.log
                CONSECUTIVE_FAILURES=3  # force resync path below
            fi

            # After 3 consecutive failures (each with 3 internal retries = 9 total attempts),
            # fall back to --resync to re-establish clean bisync state.
            # This merges both sides (files on only one side get copied to the other).
            if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
                echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') 3 consecutive failures — falling back to --resync" | tee -a /tmp/sync.log >&2
                update_sync_status "failed" "Resync fallback triggered"
                if establish_bisync_baseline; then
                    echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Resync fallback succeeded — resuming normal sync" | tee -a /tmp/sync.log >&2
                    CONSECUTIVE_FAILURES=0
                else
                    local LAST_ERRORS
                    LAST_ERRORS=$(grep -i 'error\|fatal\|failed' /tmp/sync.log | tail -3)
                    echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') RESYNC FAILED — will retry next cycle. Recent errors:" | tee -a /tmp/sync.log >&2
                    echo "$LAST_ERRORS" | tee -a /tmp/sync.log >&2
                    CONSECUTIVE_FAILURES=2  # retry resync after 1 more failure instead of 3
                fi
            fi
        fi
    done &

    SYNC_DAEMON_PID=$!
    echo "$SYNC_DAEMON_PID" > /tmp/sync-daemon.pid
    echo "[entrypoint] Bisync daemon started with PID $SYNC_DAEMON_PID"
}

# ============================================================================
# Vault-monitor daemon (REQ-MEMORY-102)
#
# Polls Vault/ every 60s for user edits (curated notes, pasted
# files) and signals the UserPromptSubmit hook by writing a marker file.
# The hook spawns a background sonnet that runs graphify extraction on
# the changed files and merges them into the global graph.
#
# Two-marker design avoids the "daemon advances mtime before extractor
# reads it" race:
#   vault-monitor.tick   - heartbeat, touched every loop (diagnostics).
#   vault-extract.last   - high-water mark, touched ONLY by the extract
#                          sonnet after successful global-graph merge.
#                          Daemon's find -newer compares against this.
#   vault-extract.vars   - trigger file. Daemon writes when find returns
#                          non-empty; hook deletes on pickup.
#
# If extraction fails the marker stays old; next tick re-discovers the
# same files (eventual consistency, no work lost).
#
# Excluded paths: raw/sessions/ (agent-owned, written by capture hook
# which already merges), graphify-out/ (derived), .silverbullet/ (config
# + cache, no semantic content), index.md at vault root (SilverBullet
# rewrites it on every supervisor boot when its "empty space" heuristic
# fires, so every container restart / SB crash + restart would otherwise
# bump the marker and spawn an extract sonnet for boilerplate content).
# ============================================================================
start_vault_monitor_daemon() {
    local VAULT_ROOT="$HOME/Vault"
    local HOOK_CACHE="$HOME/.cache/codeflare-hooks"
    local TICK_MARKER="$HOOK_CACHE/vault-monitor.tick"
    local LAST_MARKER="$HOOK_CACHE/vault-extract.last"
    local VARS_FILE="$HOOK_CACHE/vault-extract.vars"

    mkdir -p "$HOOK_CACHE"

    echo "[entrypoint] Starting vault-monitor daemon (every 60s)..."

    while true; do
        sleep 60

        # Heartbeat first so a hung find/loop is visible from outside.
        touch "$TICK_MARKER" 2>/dev/null || true

        # Vault may not exist yet (init_user_vault still racing on
        # cold boot). Skip silently — next tick will find it.
        [ -d "$VAULT_ROOT" ] || continue

        # Don't re-trigger while a previous extraction is still pending.
        # Hook deletes vars on pickup; sonnet touches last on success.
        if [ -f "$VARS_FILE" ]; then
            continue
        fi

        # find -newer requires the reference file to exist. Seeded by
        # init_user_vault on boot but guard anyway.
        [ -f "$LAST_MARKER" ] || touch "$LAST_MARKER"

        # Look for any user-touched markdown/asset under the vault that
        # is newer than the high-water mark. Excludes agent-owned and
        # derived subtrees.
        local CHANGED
        CHANGED=$(find "$VAULT_ROOT" \
            \( -path "$VAULT_ROOT/raw/sessions" -o \
               -path "$VAULT_ROOT/graphify-out" -o \
               -path "$VAULT_ROOT/.silverbullet" \) -prune -o \
            -type f \
            -not -path "$VAULT_ROOT/index.md" \
            -newer "$LAST_MARKER" -print 2>/dev/null | head -n 50)

        if [ -n "$CHANGED" ]; then
            # Write the trigger atomically (mv from tmp avoids the hook
            # reading a half-written file).
            local TMP="$VARS_FILE.tmp.$$"
            {
                printf 'VAULT_ROOT=%s\n' "$VAULT_ROOT"
                printf 'TRIGGERED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
                printf 'CHANGED_FILES<<EOF\n%s\nEOF\n' "$CHANGED"
            } > "$TMP" 2>/dev/null
            mv "$TMP" "$VARS_FILE" 2>/dev/null || rm -f "$TMP"
            echo "[vault-monitor] $(date '+%Y-%m-%d %H:%M:%S') Detected vault changes, marker written" | tee -a /tmp/sync.log >/dev/null
        fi
    done &

    VAULT_MONITOR_PID=$!
    echo "$VAULT_MONITOR_PID" > /tmp/vault-monitor.pid
    echo "[entrypoint] Vault-monitor daemon started with PID $VAULT_MONITOR_PID"
}

# ============================================================================
# SilverBullet supervisor (REQ-MEMORY-103)
#
# Runs the SilverBullet markdown editor server on 127.0.0.1:3030 against
# the persistent vault. Localhost-only — the Worker proxy at
# /api/vault/:sid/ is the auth boundary (verified-tier + rate-limited).
#
# Supervised by a restart loop because the server is the user-facing
# editor; a crash mid-session must not require a container restart.
# 5s backoff matches the existing terminal-server crash-restart pattern.
# ============================================================================
start_silverbullet_supervisor() {
    # The vault MUST live at a non-hidden path. SilverBullet's disk walker
    # (server/disk_space_primitives.go FetchFileList) aborts on the walk
    # root when its basename starts with `.` (the `SkipDir` guard fires on
    # the root entry itself), so any vault under a dotfile-prefixed path
    # (e.g. `~/.user_vault/`, the previous location) returns an empty file
    # listing and the SB UI shows no notes even though files exist on
    # disk. Keeping the canonical name `Vault` keeps that guard satisfied
    # without a symlink shim.
    local VAULT_ROOT="$HOME/Vault"
    local SB_BIN="${SILVERBULLET_BIN:-/usr/local/bin/silverbullet}"
    local SB_PORT="${SILVERBULLET_PORT:-3030}"
    local SB_HOST="${SILVERBULLET_HOST:-127.0.0.1}"

    if [ ! -x "$SB_BIN" ]; then
        echo "[entrypoint] WARNING: silverbullet binary not found at $SB_BIN; vault editor will be unreachable" >&2
        return 0
    fi

    echo "[entrypoint] Starting SilverBullet supervisor on $SB_HOST:$SB_PORT (vault=$VAULT_ROOT)..."

    # setsid unconditionally creates a new session + process group so the
    # shutdown handler can kill the supervisor AND its silverbullet child
    # in one `kill -- -PID` call. Was `set -m` previously, but bash
    # silently ignores job control in non-interactive subshells, leaving
    # silverbullet orphaned and binding port 3030 against the next session.
    setsid bash -c '
        VAULT_ROOT="$1"
        SB_BIN="$2"
        SB_HOST="$3"
        SB_PORT="$4"
        while true; do
            # Vault may not exist on first boot if baseline+init are still
            # racing. Wait it out instead of crash-looping; the daemon
            # itself will not start cleanly with a missing space dir.
            if [ ! -d "$VAULT_ROOT" ]; then
                sleep 5
                continue
            fi
            "$SB_BIN" --hostname "$SB_HOST" --port "$SB_PORT" "$VAULT_ROOT" \
                >> /tmp/silverbullet.log 2>&1
            echo "[silverbullet] $(date '"'"'+%Y-%m-%d %H:%M:%S'"'"') exited (code $?), restarting in 5s..." | tee -a /tmp/silverbullet.log
            sleep 5
        done
    ' silverbullet-supervisor "$VAULT_ROOT" "$SB_BIN" "$SB_HOST" "$SB_PORT" \
        >> /tmp/silverbullet.log 2>&1 &

    SILVERBULLET_SUPERVISOR_PID=$!
    echo "$SILVERBULLET_SUPERVISOR_PID" > /tmp/silverbullet.pid
    echo "[entrypoint] SilverBullet supervisor started with PID $SILVERBULLET_SUPERVISOR_PID"
}

# ============================================================================
# Shutdown handler - final bisync on SIGTERM/SIGINT/EXIT
# ============================================================================
shutdown_handler() {
    SHUTDOWN_STARTED_AT=$(date +%s)
    echo "[entrypoint] Received shutdown signal, performing final bisync..."

    # Kill background daemons via PID file. Walk the descendant tree so
    # rclone/silverbullet grandchildren die alongside the supervising
    # subshell - signalling the subshell alone would leave them orphaned
    # and (for silverbullet) holding port 3030, breaking the next session.
    walk_kill() {
        local sig="$1" root="$2"
        [ -z "$root" ] && return 0
        local descendants
        descendants=$(pgrep -P "$root" 2>/dev/null)
        kill "-${sig}" "$root" 2>/dev/null || true
        for child in $descendants; do
            walk_kill "$sig" "$child"
        done
    }
    kill_pidfile_subtree() {
        local pidfile="$1"
        local pid
        pid="$(cat "$pidfile" 2>/dev/null)"
        [ -z "$pid" ] && return 0
        walk_kill TERM "$pid"
    }
    kill_pidfile_subtree /tmp/sync-daemon.pid
    kill_pidfile_subtree /tmp/vault-monitor.pid
    kill_pidfile_subtree /tmp/silverbullet.pid

    # Perform final bisync to R2 (only if baseline was established).
    # Wrap in `timeout 60` so the DO's destroy() SIGKILL budget (75s,
    # set in src/container/index.ts) always lands AFTER we either
    # finished or gave up cleanly — never mid-write to R2.
    #
    # Pre-vault history: shutdown bisync had no timeout, the DO killed
    # after 25s, and a long bisync of last-minute edits left R2 in a
    # partial state. The next session loaded that partial state and
    # looked stale, forcing the user to delete the session manually.
    # See bundled fix in vault PR.
    echo "[entrypoint] Final bisync to R2 (60s budget)..."
    if [ -f /tmp/.bisync-initialized ]; then
        # Background bisync + watchdog that hard-kills at 60s. Cannot use
        # `timeout(1)` directly because bisync_with_r2 is a shell function;
        # timeout's bash -c child would not see it without `export -f` +
        # propagating every env var it reads.
        #
        # We need the watchdog to kill the rclone child too (not just the
        # subshell). `kill -TERM "$BISYNC_PID"` alone only signals the
        # wrapping subshell - rclone keeps running and the half-uploaded
        # files land in R2 anyway.
        #
        # bisync_with_r2 is a shell function that depends on multiple
        # global arrays (RCLONE_FILTERS) and helper functions, so we
        # cannot exec it under setsid via `bash -c` without recreating
        # the whole environment. Instead, we recursively walk the
        # descendant tree with pgrep at signal time. Two levels covers
        # rclone's typical depth (subshell -> bash -> rclone -> child).
        ( bisync_with_r2 ) &
        BISYNC_PID=$!
        # SIGTERM-then-SIGKILL grace pattern. 50s budget for normal bisync,
        # 10s additional after SIGTERM for rclone to flush + abort pending
        # multipart uploads cleanly (2s was previously too tight - rclone
        # needs more headroom to avoid leaving partial uploads in R2).
        # Total 60s, matching the budget the DO destroy() leaves us.
        kill_subtree() {
            local sig="$1" root="$2"
            [ -z "$root" ] && return 0
            local descendants
            descendants=$(pgrep -P "$root" 2>/dev/null)
            kill "-${sig}" "$root" 2>/dev/null
            for child in $descendants; do
                kill_subtree "$sig" "$child"
            done
        }
        ( sleep 50
          kill_subtree TERM "$BISYNC_PID"
          sleep 10
          kill_subtree KILL "$BISYNC_PID"
        ) &
        WATCHDOG_PID=$!
        wait "$BISYNC_PID" 2>/dev/null
        BISYNC_RC=$?
        kill "$WATCHDOG_PID" 2>/dev/null
        wait "$WATCHDOG_PID" 2>/dev/null
        # Bash reports 143 (128 + SIGTERM) or 137 (128 + SIGKILL) when
        # the watchdog fired - surface that as a timeout in the log.
        if [ "$BISYNC_RC" -eq 0 ]; then
            echo "[entrypoint] Final bisync completed successfully"
        elif [ "$BISYNC_RC" -eq 143 ] || [ "$BISYNC_RC" -eq 137 ]; then
            echo "[entrypoint] Final bisync TIMED OUT after 60s - last writes may not have synced. Increase budget if this is frequent."
        else
            echo "[entrypoint] Final bisync failed with rc=$BISYNC_RC"
        fi
    else
        echo "[entrypoint] Skipping final bisync - baseline never established"
    fi

    # Kill child processes
    if [ -n "$TERMINAL_PID" ]; then
        kill "$TERMINAL_PID" 2>/dev/null || true
    fi

    SHUTDOWN_ELAPSED=$(( $(date +%s) - SHUTDOWN_STARTED_AT ))
    echo "[entrypoint] Shutdown complete (elapsed: ${SHUTDOWN_ELAPSED}s)"
    exit 0
}

# Set up shutdown trap
trap shutdown_handler SIGTERM SIGINT EXIT

# ============================================================================
# Helper function to update sync status file (read by health server)
# ============================================================================
update_sync_status() {
    # Args: status, error (raw string or "null")
    local error_val="$2"
    if [ "$error_val" = "null" ]; then
        jq -n --arg status "$1" --arg userPath "$USER_HOME" \
            '{status: $status, error: null, userPath: $userPath}' > /tmp/sync-status.json
    else
        jq -n --arg status "$1" --arg error "$error_val" --arg userPath "$USER_HOME" \
            '{status: $status, error: $error, userPath: $userPath}' > /tmp/sync-status.json
    fi
}

# ============================================================================
# Configure tab auto-start in .bashrc
# ============================================================================
configure_tab_autostart() {
    BASHRC_FILE="$USER_HOME/.bashrc"
    BASH_PROFILE="$USER_HOME/.bash_profile"
    AUTOSTART_MARKER="# terminal-autostart"

    # Ensure .bash_profile sources .bashrc (for login shells)
    if [ ! -f "$BASH_PROFILE" ] || ! grep -q "source.*bashrc\|\..*bashrc" "$BASH_PROFILE" 2>/dev/null; then
        echo "[entrypoint] Creating .bash_profile to source .bashrc..."
        cat > "$BASH_PROFILE" << 'PROFILE_EOF'
# .bash_profile - source .bashrc for login shells
if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
fi
PROFILE_EOF
        echo "[entrypoint] .bash_profile created"
    fi

    # Check if already configured (safe now that .bashrc is excluded from R2 sync)
    if grep -q "$AUTOSTART_MARKER" "$BASHRC_FILE" 2>/dev/null; then
        echo "[entrypoint] Tab auto-start already configured in .bashrc"
        return 0
    fi

    echo "[entrypoint] Adding tab auto-start to .bashrc..."

    # Create .bashrc if it doesn't exist
    touch "$BASHRC_FILE"

    # If TAB_CONFIG is not set, fall back to original hardcoded behavior
    if [ -z "${TAB_CONFIG:-}" ]; then
        echo "[entrypoint] No TAB_CONFIG set, using default tab layout"
        cat >> "$BASHRC_FILE" << 'BASHRC_EOF'

# terminal-autostart
# Start different apps based on terminal tab ID:
# Tab 1: Claude Code
# Tab 2: htop (system monitor)
# Tab 3: yazi (file manager)
# Tab 4-6: Plain bash terminal in workspace
if [ -t 1 ] && [ -z "$TERMINAL_APP_STARTED" ]; then
    export TERMINAL_APP_STARTED=1
    export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

    cd "$HOME/workspace" 2>/dev/null || cd "$HOME"

    # Skip autostart for manually created tabs (user clicked "+")
    if [ -n "$MANUAL_TAB" ]; then
        export TERMINAL_APP_STARTED=1
    else
    case "${TERMINAL_ID:-1}" in
        1)
            # Tab 1: Claude Code (official CLI)
            # IS_SANDBOX=1 allows --dangerously-skip-permissions as root
            # DISABLE_AUTOUPDATER controls whether the CLI auto-updates (Fast Start setting)
            claude --dangerously-skip-permissions
            # If claude exits, drop to bash (don't use exec so PTY survives)
            ;;
        2)
            # Tab 2: htop (system monitor)
            # Run in loop so it restarts after exit (e.g., pressing 'q')
            while true; do
                htop
                echo "htop exited. Press Enter to restart, or Ctrl+C for bash..."
                read -t 3 || true
            done
            ;;
        3)
            # Tab 3: yazi (file manager)
            # Run in loop so it restarts after exit (e.g., pressing 'q')
            while true; do
                yazi
                echo "yazi exited. Press Enter to restart, or Ctrl+C for bash..."
                read -t 3 || true
            done
            ;;
        *)
            # Tabs 4-6: Plain bash terminal
            # Just continue to normal bash prompt
            ;;
    esac
    fi
fi
BASHRC_EOF
    else
        echo "[entrypoint] TAB_CONFIG set, generating dynamic tab layout"

        # Start the .bashrc block
        cat >> "$BASHRC_FILE" << 'BASHRC_HEADER'

# terminal-autostart
# Dynamic tab layout from TAB_CONFIG env var
if [ -t 1 ] && [ -z "$TERMINAL_APP_STARTED" ]; then
    export TERMINAL_APP_STARTED=1
    export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

    cd "$HOME/workspace" 2>/dev/null || cd "$HOME"

    # Skip autostart for manually created tabs (user clicked "+")
    if [ -z "$MANUAL_TAB" ]; then
    case "${TERMINAL_ID:-1}" in
BASHRC_HEADER

        # Parse TAB_CONFIG JSON and generate case entries
        # TAB_CONFIG format: [{"id":"1","command":"claude --dangerously-skip-permissions","label":"claude"},{"id":"2","command":"","label":"bash"},...]
        local tab_count
        tab_count=$(echo "$TAB_CONFIG" | jq -r 'length')

        for key in $(echo "$TAB_CONFIG" | jq -r '.[].id' | sort -n); do
            # Validate tab ID is a single digit 1-6 to prevent injection
            [[ "$key" =~ ^[1-6]$ ]] || continue

            local cmd
            cmd=$(echo "$TAB_CONFIG" | jq -r --arg id "$key" '.[] | select(.id == $id) | .command')

            case "$cmd" in
                claude\ --dangerously-skip-permissions|claude)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # Claude Code (official CLI with sandbox permission bypass)
            claude --dangerously-skip-permissions
            ;;
CASE_EOF
                    ;;
                htop|yazi|lazygit)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # ${cmd} (TUI app with restart loop)
            while true; do
                ${cmd}
                echo "${cmd} exited. Press Enter to restart, or Ctrl+C for bash..."
                read -t 3 || true
            done
            ;;
CASE_EOF
                    ;;
                codex|opencode|copilot*)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # ${cmd} (bash stays as session leader for TTY stability)
            ${cmd}
            ;;
CASE_EOF
                    ;;
                gemini*)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # ${cmd} (bash stays as session leader for TTY stability)
            ${cmd}
            ;;
CASE_EOF
                    ;;
                bash|"")
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # Plain bash terminal
            ;;
CASE_EOF
                    ;;
                *)
                    echo "[entrypoint] WARNING: Unknown command in TAB_CONFIG: $cmd (tab $key), skipping"
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # Unknown command: ${cmd} - falling back to bash
            ;;
CASE_EOF
                    ;;
            esac
        done

        # Close the case statement and if block
        cat >> "$BASHRC_FILE" << 'BASHRC_FOOTER'
        *)
            # Unconfigured tabs: plain bash
            ;;
    esac
    fi
fi
BASHRC_FOOTER
    fi

    echo "configured" > /tmp/claude-autostart-status.txt
    echo "[entrypoint] Tab auto-start configured"
    return 0
}

# ============================================================================
# Vault skeleton init (REQ-MEMORY-100, REQ-MEMORY-105)
# ============================================================================
# Idempotent on every boot. Creates the Vault/ skeleton if absent, copies
# preseeded SilverBullet config + (best-effort) Atlas plug from
# /opt/silverbullet-preseed/, seeds the global graphify graph with the vault,
# and initializes the vault-monitor two-marker filesystem state so the daemon
# (started later in this entrypoint) has sensible baselines.
#
# Also creates the persistent user folders Uploads/ and Temporary/ alongside
# the vault. All three folders bisync to R2 (see RCLONE_FILTERS_COMMON).
#
# Called after establish_bisync_baseline so we never overwrite R2-restored
# content with an empty skeleton on returning sessions.
# ============================================================================
init_user_vault() {
    local VAULT="$USER_HOME/Vault"
    local PRESEED_DIR=/opt/silverbullet-preseed
    local HOOK_CACHE="$USER_HOME/.cache/codeflare-hooks"

    # Always ensure hook cache dir exists (used by daemons + hooks below).
    mkdir -p "$HOOK_CACHE"

    # Persistent user folders. The Vault block below handles skeleton+preseed
    # for ~/Vault; these two are plain mkdir-p (no skeleton, no preseed) so
    # the user sees empty Uploads/ and Temporary/ folders ready to drop into.
    # Bisync filters in RCLONE_FILTERS_COMMON include both prefixes, so any
    # file dropped here round-trips to R2 and is visible in the storage panel.
    mkdir -p "$USER_HOME/Uploads" "$USER_HOME/Temporary"

    if [ ! -d "$VAULT" ]; then
        echo "[entrypoint] Initializing vault skeleton at $VAULT"
        mkdir -p "$VAULT/raw/sessions" "$VAULT/raw/pasted" "$VAULT/notes" \
                 "$VAULT/graphify-out" "$VAULT/.silverbullet/_plug"

        cat > "$VAULT/README.md" <<'VAULT_README_EOF'
# Vault

Persistent memory across codeflare sessions. Edit anything here in
SilverBullet (Vault button in the codeflare header). Two hooks keep the
unified graphify graph fresh:

- **Transcript capture** fires every 15 chat prompts; the background sonnet
  writes session observations to `raw/sessions/` and re-extracts them into
  the vault graph.
- **Vault monitor** watches everything outside `raw/sessions/` for user
  edits (60s polling) and re-extracts on the next chat prompt when
  changes are detected.

## Structure

- `raw/sessions/`  agent-written session captures; do not hand-edit.
- `raw/pasted/`    drag-zone for PDFs, screenshots, anything.
- `notes/`         curated, organised prose.
- `graphify-out/`  the vault project graph (regenerated automatically).
- `.silverbullet/` SilverBullet config + plugs.

## First-time

The vault starts empty. Captures begin landing after roughly 15 prompts
in your first session. Cross-session memory becomes useful from session
two onward.
VAULT_README_EOF

        printf '{"directed":true,"multigraph":false,"graph":{},"nodes":[],"links":[]}' \
            > "$VAULT/graphify-out/graph.json"

        # SilverBullet preseed config — always present.
        if [ -f "$PRESEED_DIR/config.yaml" ]; then
            cp "$PRESEED_DIR/config.yaml" "$VAULT/.silverbullet/config.yaml"
        fi
        # Atlas plug — best-effort. Absence is fine; graph viz falls back
        # to graphify-out/graph.html.
        if [ -f "$PRESEED_DIR/atlas.plug.js" ]; then
            cp "$PRESEED_DIR/atlas.plug.js" "$VAULT/.silverbullet/_plug/atlas.plug.js"
        else
            echo "[entrypoint] Atlas plug absent from preseed; vault visualisation will fall back to graphify-out/graph.html"
        fi

        echo "[entrypoint] Vault skeleton initialized"
    fi

    # Idempotent preseed-config sync on every boot (skeleton block above is
    # gated on a missing vault, so existing R2-restored vaults never received
    # the config otherwise). Overwrites user hand-edits to .silverbullet/;
    # the vault rule marks .silverbullet/ as editor config that should be
    # changed via the codeflare preseed, not in place.
    mkdir -p "$VAULT/.silverbullet/_plug"
    if [ -f "$PRESEED_DIR/config.yaml" ] \
       && ! cmp -s "$PRESEED_DIR/config.yaml" "$VAULT/.silverbullet/config.yaml" 2>/dev/null; then
        cp "$PRESEED_DIR/config.yaml" "$VAULT/.silverbullet/config.yaml"
        echo "[entrypoint] Vault config.yaml synced from preseed"
    fi
    if [ -f "$PRESEED_DIR/atlas.plug.js" ] \
       && ! cmp -s "$PRESEED_DIR/atlas.plug.js" "$VAULT/.silverbullet/_plug/atlas.plug.js" 2>/dev/null; then
        cp "$PRESEED_DIR/atlas.plug.js" "$VAULT/.silverbullet/_plug/atlas.plug.js"
    fi

    # Preseeded plugs land under Library/Codeflare/ (codeflare-managed
    # namespace, overwrite-on-boot). User plugs in other Library/ subdirs
    # are untouched. nullglob makes the loop a no-op when no plug files
    # match (instead of iterating the literal glob string).
    if [ -d "$PRESEED_DIR/plugs" ]; then
        mkdir -p "$VAULT/Library/Codeflare"
        local PLUG_FILE
        shopt -s nullglob
        for PLUG_FILE in "$PRESEED_DIR/plugs"/*/*.plug.js; do
            if ! cmp -s "$PLUG_FILE" "$VAULT/Library/Codeflare/$(basename "$PLUG_FILE")" 2>/dev/null; then
                cp "$PLUG_FILE" "$VAULT/Library/Codeflare/"
                echo "[entrypoint] Preseeded plug synced: $(basename "$PLUG_FILE")"
            fi
        done
        shopt -u nullglob
    fi

    # Seed the global graph with the vault. Hash-keyed idempotent - safe to
    # re-run on every boot. Best-effort: if graphify global isn't available
    # (e.g. graphify plugin disabled), continue.
    if command -v graphify >/dev/null 2>&1; then
        flock /tmp/graphify-global.lock graphify global add \
            "$VAULT/graphify-out/graph.json" --as user_vault 2>/dev/null \
            || echo "[entrypoint] vault global-add deferred (graphify not ready)"
    fi

    # Initialize vault-monitor two-marker state (see daemon section). Only
    # seed vault-extract.last if absent — re-seeding on every boot would
    # mask user-curated changes made since the last extraction in a prior
    # session that didn't complete extraction before shutdown.
    [ -f "$HOOK_CACHE/vault-extract.last" ] || touch "$HOOK_CACHE/vault-extract.last"
    [ -f "$HOOK_CACHE/vault-monitor.tick" ] || touch "$HOOK_CACHE/vault-monitor.tick"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

# Create rclone config (may fail if R2 vars missing, that's OK)
if create_rclone_config; then
    RCLONE_CONFIG_RESULT=0
else
    RCLONE_CONFIG_RESULT=1
fi

# Initialize sync log
init_sync_log

# ============================================================================
# Start terminal server EARLY so port 8080 binds before Cloudflare's container
# port-wait timeout (~10-15s) elapses. The server will not begin PTY pre-warm
# until /tmp/codeflare-init-complete is written at the end of this script —
# this preserves the existing readiness contract (loading screen still waits
# for sync + prewarm) while moving the slow init work off the port-wait path.
# ============================================================================
export CODEFLARE_INIT_FLAG_FILE=/tmp/codeflare-init-complete
rm -f "$CODEFLARE_INIT_FLAG_FILE"

echo "[entrypoint] Starting terminal server on port 8080..."
# Subshell-scope the cd so the rest of the entrypoint's cwd is unchanged.
(cd /app/host && HOME="$USER_HOME" TERMINAL_PORT=8080 \
    CODEFLARE_INIT_FLAG_FILE="$CODEFLARE_INIT_FLAG_FILE" \
    node dist/server.js) &
TERMINAL_PID=$!
echo "$TERMINAL_PID" > /tmp/terminal.pid
echo "[entrypoint] Terminal server started with PID $TERMINAL_PID (prewarm gated on $CODEFLARE_INIT_FLAG_FILE)"

# Probe port 8080 (not just kill -0): a live node process that hasn't reached
# server.listen() yet would pass the old check but fail Cloudflare's port-wait.
# /health is auth-exempt (host/src/server.ts authExemptPaths), so this works
# before CONTAINER_AUTH_TOKEN is wired up. Poll up to 5s; fail-open if not
# bound (host server may still come up while the rest of init runs).
PORT_BOUND=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null --max-time 1 http://127.0.0.1:8080/health 2>/dev/null; then
        PORT_BOUND=1
        break
    fi
    sleep 0.5
done
if [ "$PORT_BOUND" = "1" ]; then
    echo "[entrypoint] Terminal server is listening on port 8080"
elif kill -0 "$TERMINAL_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: Terminal server alive (PID $TERMINAL_PID) but port 8080 not bound after 5s"
else
    echo "[entrypoint] WARNING: Terminal server process died before binding port 8080!"
fi

# ============================================================================
# R2 SYNC STARTUP
# ============================================================================
# Note: Claude Code consent is pre-accepted via bypassPermissionsModeAccepted in .claude.json.

if [ $RCLONE_CONFIG_RESULT -eq 0 ]; then
    # Step 1: One-way sync FROM R2 to restore user data (credentials, plugins, etc.)
    update_sync_status "syncing" "null"
    initial_sync_from_r2 &
    SYNC_PID=$!
    echo "[entrypoint] R2 sync started in background (PID $SYNC_PID)"

    # Wait for R2 sync to complete (needed before bisync baseline)
    # Use && / || to prevent set -e from killing the script on non-zero exit
    wait $SYNC_PID && STEP1_RESULT=0 || STEP1_RESULT=$?

    if [ $STEP1_RESULT -eq 0 ]; then
        # Ensure workspace directory exists after sync
        mkdir -p "$USER_WORKSPACE"
        update_sync_status "success" "null"
    else
        update_sync_status "failed" "$SYNC_ERROR"
        # Continue anyway - servers should still start
    fi
else
    update_sync_status "skipped" "$SYNC_ERROR"
fi

# Pre-accept Claude Code's bypass permissions consent
# Claude Code stores this in ~/.claude.json (bypassPermissionsModeAccepted field)
# This prevents the interactive "WARNING: Claude Code running in Bypass Permissions mode" prompt
if [ -f "$USER_CLAUDE_JSON" ]; then
    # Merge into existing config (rclone may have restored it from R2)
    TMP_JSON=$(mktemp)
    jq '. + {"bypassPermissionsModeAccepted": true}' "$USER_CLAUDE_JSON" > "$TMP_JSON" 2>/dev/null && \
        mv "$TMP_JSON" "$USER_CLAUDE_JSON" || \
        echo '{"bypassPermissionsModeAccepted":true}' > "$USER_CLAUDE_JSON"
    rm -f "$TMP_JSON"
else
    echo '{"bypassPermissionsModeAccepted":true}' > "$USER_CLAUDE_JSON"
fi
echo "[entrypoint] Claude Code bypass permissions consent pre-accepted"

# Counter directory used by the memory-capture UserPromptSubmit hook
# (the hook fires every N prompts to trigger vault capture; the MCP memory server
# itself was removed — vault is now the persistent memory store).
if [ -n "${SESSION_ID:-}" ]; then
    mkdir -p "$USER_HOME/.memory/counter"
fi

# Configure consult-llm-mcp MCP server when LLM API keys are present
if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ]; then
    # Build env object with only the keys that are set
    LLM_ENV="{}"
    if [ -n "${OPENAI_API_KEY:-}" ]; then
        LLM_ENV=$(echo "$LLM_ENV" | jq --arg k "$OPENAI_API_KEY" '. + {"OPENAI_API_KEY": $k}')
    fi
    if [ -n "${GEMINI_API_KEY:-}" ]; then
        LLM_ENV=$(echo "$LLM_ENV" | jq --arg k "$GEMINI_API_KEY" '. + {"GEMINI_API_KEY": $k}')
    fi

    LLM_MCP_CONFIG=$(jq -n --argjson env "$LLM_ENV" '{"mcpServers":{"consult-llm":{"command":"npx","args":["-y","consult-llm-mcp"],"env":$env}}}')
    if [ -f "$USER_CLAUDE_JSON" ]; then
        TMP_JSON=$(mktemp)
        if jq --argjson mcp "$LLM_MCP_CONFIG" '. * $mcp' "$USER_CLAUDE_JSON" > "$TMP_JSON" 2>/dev/null; then
            mv "$TMP_JSON" "$USER_CLAUDE_JSON"
        else
            echo "[entrypoint] WARNING: Could not merge consult-llm MCP config (malformed .claude.json?)"
            rm -f "$TMP_JSON"
        fi
    else
        echo "$LLM_MCP_CONFIG" | jq '.' > "$USER_CLAUDE_JSON"
    fi
    echo "[entrypoint] consult-llm MCP server configured for Claude Code"
fi

# Configure context-mode MCP server. (Implements REQ-AGENT-005)
# context-mode (https://github.com/mksglu/context-mode) ships in two layers:
#   1. MCP server (ctx_* tools) - registered for ALL users on every session
#      so the agent always has the helper tools available. The package is
#      installed globally at Docker build time and lives at
#      /usr/local/bin/context-mode. Build time also patches the esbuild
#      ESM bundles with a createRequire shim (see codeflare#309) so
#      ctx_execute / ctx_batch_execute work; without the patch the bundles
#      throw `Dynamic require of "node:fs" is not supported` on first
#      execute call under both Node and Bun ESM loaders.
#   2. Plugin folder (hooks + any plugin-bound rules) - ONLY delivered to
#      unlimited (Custom) tier in Pro session mode via the R2 seed filter
#      at src/lib/r2-seed.ts. The hooks auto-route tool calls and are the
#      premium behavior change; the MCP tools are always available manually.
# The MCP and hook commands invoke `context-mode` directly (no version
# arg) - the global install IS the pinned version. Version bumps land
# as a Dependabot PR that updates plugin.json AND triggers a Docker
# rebuild (the Dockerfile reads plugin.json at build time).
#
# License posture (ELv2): context-mode is licensed under Elastic License
# 2.0, which prohibits providing the software as a hosted/managed service.
# Codeflare's posture is:
#   - We do NOT redistribute context-mode source. The npm registry is
#     the canonical source; our Docker build pulls from there exactly
#     as `npx -y context-mode` would at runtime.
#   - Commercial (non-Custom) users get the MCP server registered, but
#     NO skill, rule, agent definition, or hook in our preseed instructs
#     the agent to invoke ctx_* tools. The agent's tool-selection is its
#     own, exactly as for any other listed MCP tool.
#   - The Custom (unlimited) tier with auto-routing hooks is admin-only
#     personal use, which ELv2 fully permits.
# A future contributor who adds a SessionStart-style ctx_* nudge for
# commercial users would push us over the ELv2 line. Don't do that
# without revisiting AD49 first.
CONTEXT_MODE_VERSION="1.0.118"
CONTEXT_MODE_MANIFEST="$USER_HOME/.claude/plugins/context-mode/.claude-plugin/plugin.json"
if [ -f "$CONTEXT_MODE_MANIFEST" ]; then
    # Surface the manifest version in the entrypoint log so a mismatch
    # against the build-time-installed binary (= /usr/local/bin/context-mode
    # --version output) is visible. Bumping plugin.json without a Docker
    # rebuild is a deploy ordering issue caught by this log line.
    CONTEXT_MODE_VERSION=$(jq -r '.version // "1.0.118"' "$CONTEXT_MODE_MANIFEST" 2>/dev/null || echo "1.0.118")
fi
# MCP server registration: always register the context-mode MCP server in
# ~/.claude.json (mirrors how codeflare-memory's `memory` MCP server is wired).
# The plugin folder + bare plugin.json + enabledPlugins entry mark "this
# plugin is enabled"; the actual MCP wiring is in ~/.claude.json and the
# hook wiring is in ~/.claude/settings.json. This matches the pattern used
# by codeflare-memory and codeflare-hooks (both have bare plugin.json with
# no mcpServers / no hooks blocks).
CONTEXT_MODE_MCP_CONFIG=$(jq -n '{mcpServers:{"context-mode":{command:"context-mode",args:[]}}}')
if [ -f "$USER_CLAUDE_JSON" ]; then
    TMP_JSON=$(mktemp)
    if jq --argjson mcp "$CONTEXT_MODE_MCP_CONFIG" '. * $mcp' "$USER_CLAUDE_JSON" > "$TMP_JSON" 2>/dev/null; then
        mv "$TMP_JSON" "$USER_CLAUDE_JSON"
    else
        echo "[entrypoint] WARNING: Could not merge context-mode MCP config (malformed .claude.json?)"
        rm -f "$TMP_JSON"
    fi
else
    echo "$CONTEXT_MODE_MCP_CONFIG" | jq '.' > "$USER_CLAUDE_JSON"
fi
echo "[entrypoint] context-mode MCP server registered in .claude.json (version $CONTEXT_MODE_VERSION)"

# ---------------------------------------------------------------------------
# Configure graphify MCP server. (Implements REQ-AGENT-023)
#
# graphify is installed at build time at /root/.local/bin/graphify (uv tool
# install graphifyy[mcp,sql,pdf]). The MCP server is invoked as
# `python3 -m graphify.serve`; the server discovers graphify-out/graph.json
# from cwd per-invocation, so no graph path is registered here.
#
# Unlike context-mode, graphify is NOT tier-gated:
#   - Plugin folder ships to ALL session modes (Standard + Pro)
#   - MCP server is registered unconditionally on session mode (capability
#     is ambient; only the SKILL + RULE + hooks that teach the agent to use
#     it are advanced-mode-only via manifest.json gating)
#
# Plays cleanly with and without context-mode: graphify's own subagent
# chunking handles main-context bounding when context-mode is absent (non-
# Custom tiers); when context-mode is present, subagent Read/Grep during
# /graphify extraction route through ctx_execute for bonus token savings.
# ---------------------------------------------------------------------------
GRAPHIFY_MANIFEST="$USER_HOME/.claude/plugins/graphify/.claude-plugin/plugin.json"
GRAPHIFY_VERSION="unknown"
if [ -f "$GRAPHIFY_MANIFEST" ]; then
    GRAPHIFY_VERSION=$(jq -r '.version // "unknown"' "$GRAPHIFY_MANIFEST" 2>/dev/null || echo "unknown")
fi
# Use the uv-isolated venv's python, not system python3. `uv tool install`
# (Dockerfile) installs graphifyy into /root/.local/share/uv/tools/graphifyy/
# and only exposes the `graphify` CLI shim on PATH - the package is invisible
# to system python3, so `python3 -m graphify.serve` would die with
# ModuleNotFoundError. Pointing the MCP server at the venv's own interpreter
# is the supported way to reach internal modules of a uv-installed tool.
#
# Run via the graphify-mcp-lazy.py wrapper rather than `-m graphify.serve`
# directly. Upstream graphify.serve sys.exit(1)s if graphify-out/graph.json
# is missing at startup; in Codeflare sessions there's no clean way to
# restart Claude Code (killing the session kills the container), so the
# server has to come up against a missing graph and hot-reload when one
# appears. The wrapper subclasses nx.DiGraph and watches the file mtime;
# tool list stays static (always 7 tools), only G's contents swap.
GRAPHIFY_PY="/root/.local/share/uv/tools/graphifyy/bin/python"
GRAPHIFY_WRAPPER="$USER_HOME/.claude/plugins/graphify/scripts/graphify-mcp-lazy.py"
# Defensive self-heal: ensure the graphify CLI shim is on the system PATH.
# The Dockerfile creates this symlink, but older images (or any container
# whose /usr/local/bin was overwritten by a bisync round-trip) will be
# missing it. Without the symlink, every bash subshell launched by a hook
# (graphify-active-repo.sh, memory-capture sonnet, vault-extract sonnet)
# sees `command -v graphify` return false and silently noops the global-add
# step, leaving ~/.graphify/global-graph.json unseeded.
GRAPHIFY_BIN_SRC="/root/.local/share/uv/tools/graphifyy/bin/graphify"
GRAPHIFY_BIN_DST="/usr/local/bin/graphify"
if [ -x "$GRAPHIFY_BIN_SRC" ] && [ ! -e "$GRAPHIFY_BIN_DST" ]; then
    ln -sf "$GRAPHIFY_BIN_SRC" "$GRAPHIFY_BIN_DST"
fi
GRAPHIFY_MCP_CONFIG=$(jq -n --arg py "$GRAPHIFY_PY" --arg wrap "$GRAPHIFY_WRAPPER" '{mcpServers:{"graphify":{command:$py,args:[$wrap]}}}')
if [ -f "$USER_CLAUDE_JSON" ]; then
    TMP_JSON=$(mktemp)
    if jq --argjson mcp "$GRAPHIFY_MCP_CONFIG" '. * $mcp' "$USER_CLAUDE_JSON" > "$TMP_JSON" 2>/dev/null; then
        mv "$TMP_JSON" "$USER_CLAUDE_JSON"
    else
        echo "[entrypoint] WARNING: Could not merge graphify MCP config (malformed .claude.json?)"
        rm -f "$TMP_JSON"
    fi
else
    echo "$GRAPHIFY_MCP_CONFIG" | jq '.' > "$USER_CLAUDE_JSON"
fi
echo "[entrypoint] graphify MCP server registered in .claude.json (version $GRAPHIFY_VERSION)"

# Configure Claude Code settings.json with hooks (advanced) or just settings (default)
PLUGIN_DIR="$USER_HOME/.claude/plugins"
if [ "${SESSION_MODE:-default}" = "advanced" ]; then
    # PreToolUse: block-attributed-commits fires on git * and gh * to catch
    #   AI attribution in commits/PRs/issues/releases.
    # PostToolUse: git-push-review-reminder.sh fires on every Bash call (no
    #   `if` prefix gate — those silently miss chained pipelines like
    #   `git add . && git commit && git push`, see #243). The script's
    #   in-process case statement filters by command pattern. Classifies
    #   the trigger as PR-OPEN (gh pr create), PR-SYNC (git push to a
    #   branch with an open PR), or DEFERRED (push to a branch with no
    #   PR — review fires when the PR opens). Only fires if sdd/ is
    #   bootstrapped (vibe-coding gate). Cached at .git/sdd-pr-cache
    #   (60s for OPEN, 10s for empty/transient results).
    # Stop: enforce-review-spawn (v5) blocks turn-end if the SDD review
    #   agents weren't spawned after the most recent PR-tracked push.
    #   Checkpoint at .git/sdd-last-ack-pr-head (PR HEAD SHA). Only fires
    #   if sdd/ is bootstrapped. Three USER-ONLY bypass methods (sentinel
    #   file, "skip review" / "skip verification" phrase, 3-strike circuit
    #   breaker) preserve user agency. Direct pushes to main are not
    #   special-cased here — the project should rely on GitHub branch
    #   protection to require PRs into main; see common/git-workflow.md.
    # Base advanced-mode hooks (codeflare-memory + codeflare-hooks).
    #
    # Issue #317 / #319: both review-reminder (PostToolUse) AND
    # block-attributed-commits (PreToolUse) are registered on BOTH the Bash
    # matcher AND the MCP shell-tool matcher (mcp__context-mode__ctx_execute,
    # mcp__context-mode__ctx_batch_execute). The MCP entries are added
    # unconditionally — not gated on context-mode plugin presence — so the
    # configuration is uniform across users with and without context-mode:
    #
    #   - Users WITHOUT context-mode: the MCP matcher exists in settings.json
    #     but the MCP tools themselves are never invoked, so the entry is
    #     inert. Adds zero overhead and zero behavior change.
    #   - Users WITH context-mode: when enforce-ctx-mode.sh denies `gh pr
    #     create` / `gh pr merge` in Bash and forces them through
    #     ctx_execute, the review-reminder still fires from the MCP matcher
    #     AND block-attributed-commits still catches attribution lines in
    #     `gh pr create --body "...Co-Authored-By..."` redirected through
    #     ctx_execute. Closes the silent-bypass discovered in ai-news-digest
    #     PR #247 and the matching bug-class flagged by issue #319 in the
    #     enforce-review-spawn Stop hook.
    SETTINGS_CONFIG='{"skipDangerousModePermissionPrompt":true,"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"if":"Bash(git *)","type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/block-attributed-commits.sh"},{"if":"Bash(gh *)","type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/block-attributed-commits.sh"}]},{"matcher":"mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute","hooks":[{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/block-attributed-commits.sh"}]}],"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/git-push-review-reminder.sh"}]},{"matcher":"mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute","hooks":[{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/git-push-review-reminder.sh"}]}],"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-hooks/scripts/enforce-review-spawn.sh"}]}],"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-memory/scripts/memory-capture.sh"},{"type":"command","command":"bash '"$PLUGIN_DIR"'/codeflare-vault/scripts/vault-monitor-hook.sh"}]}]}}'
    # context-mode hooks (Custom tier only, gated on plugin manifest presence).
    # Implements REQ-AGENT-005. Same four hooks the upstream context-mode
    # plugin would self-register via hooks.json — we wire them through
    # settings.json instead so it follows the same pattern as the other
    # plugins (bare plugin.json, real wiring in entrypoint).
    if [ -f "$CONTEXT_MODE_MANIFEST" ]; then
        CTX_ENFORCE="$PLUGIN_DIR/context-mode/scripts/enforce-ctx-mode.sh"
        CTX_HOOKS=$(jq -n --arg enforce "$CTX_ENFORCE" '{
          PreToolUse: [
            {matcher:"Bash|Read|WebFetch|Grep|Glob|Agent",hooks:[{type:"command",command:"context-mode hook claude-code pretooluse"}]},
            {matcher:"Bash|WebFetch|Grep",hooks:[{type:"command",command:("bash " + $enforce)}]}
          ],
          PostToolUse: [{matcher:"Bash|Read|WebFetch|Grep|Glob",hooks:[{type:"command",command:"context-mode hook claude-code posttooluse"}]}],
          PreCompact: [{matcher:"",hooks:[{type:"command",command:"context-mode hook claude-code precompact"}]}],
          SessionStart: [{matcher:"",hooks:[{type:"command",command:"context-mode hook claude-code sessionstart"}]}]
        }')
        SETTINGS_CONFIG=$(echo "$SETTINGS_CONFIG" | jq --argjson ctx "$CTX_HOOKS" '
          .hooks as $h | .hooks = (
            ($h | keys) + ($ctx | keys) | unique |
            map(. as $k | {key: $k, value: (($h[$k] // []) + ($ctx[$k] // []))}) |
            from_entries
          )
        ')
        echo "[entrypoint] Advanced mode: context-mode hooks added to settings.json (version $CONTEXT_MODE_VERSION)"
    fi
    # graphify hooks (advanced session mode + plugin manifest present).
    # Implements REQ-AGENT-023 AC3 + AC4:
    #   - SessionStart (matcher "startup") injects context if a graph
    #     exists in cwd, or a build-suggestion reminder for code repos
    #     without a graph. Never auto-builds.
    #   - PostToolUse on Bash + the two MCP shell tools detects
    #     `git clone` / `gh repo clone` and injects an AskUserQuestion
    #     triage directive. Idempotent per cloned dir.
    #   - PreToolUse on Grep|Glob (non-custom tier) and on the two ctx
    #     grep-equivalents ctx_search|ctx_batch_execute (custom tier)
    #     injects a soft nudge to use mcp__graphify__* when a graph
    #     exists in cwd. Never blocks - the use/don't-use call requires
    #     semantic judgment a hook can't reliably make.
    # The MCP server itself is registered above unconditionally; these
    # hooks are the load-bearing discipline pieces, gated on advanced.
    if [ -f "$GRAPHIFY_MANIFEST" ]; then
        # active-repo hook: tracks current repo for the MCP wrapper.
        # Ships to ADVANCED ONLY (per AD52 / REQ-AGENT-023: MCP server +
        # wrapper register in both modes, but all hooks - including this
        # one - stay in advanced). Matchers cover Bash, Edit/Write/Read/
        # NotebookEdit (universal across tiers), and the three ctx_execute
        # variants (custom-tier users where `cd` happens inside ctx_execute
        # shells that Claude Code's session cwd never sees).
        GRAPHIFY_HOOKS=$(jq -n --arg dir "$PLUGIN_DIR" '{
          SessionStart: [
            {matcher:"startup",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graphify-session-start.sh")}]}
          ],
          PostToolUse: [
            {matcher:"Bash",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graphify-clone-prompt.sh")}]},
            {matcher:"mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graphify-clone-prompt.sh")}]},
            {matcher:"Bash|Edit|Write|Read|NotebookEdit",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graphify-active-repo.sh")}]},
            {matcher:"mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file|mcp__context-mode__ctx_batch_execute",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graphify-active-repo.sh")}]}
          ],
          PreToolUse: [
            {matcher:"Grep|Glob",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graph-first-nudge.sh")}]},
            {matcher:"mcp__context-mode__ctx_search|mcp__context-mode__ctx_batch_execute",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/graph-first-nudge.sh")}]},
            {matcher:"Grep|Bash",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/enforce-graphify.sh")}]},
            {matcher:"mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file|mcp__context-mode__ctx_batch_execute",hooks:[{type:"command",command:("bash " + $dir + "/graphify/scripts/enforce-graphify.sh")}]}
          ]
        }')
        SETTINGS_CONFIG=$(echo "$SETTINGS_CONFIG" | jq --argjson gf "$GRAPHIFY_HOOKS" '
          .hooks as $h | .hooks = (
            ($h | keys) + ($gf | keys) | unique |
            map(. as $k | {key: $k, value: (($h[$k] // []) + ($gf[$k] // []))}) |
            from_entries
          )
        ')
        echo "[entrypoint] Advanced mode: graphify hooks added (SessionStart + PostToolUse on clone + PreToolUse graph-first nudge)"
    fi
    # Hardening: validate SETTINGS_CONFIG is well-formed JSON before it
    # reaches the settings.json merge below. The literal heredoc-style
    # quoting on line ~1163 uses interleaved `'"$PLUGIN_DIR"'` insertions —
    # a single typo (missing close-quote, stray comma) produces a string
    # bash accepts but Claude Code silently rejects at runtime, hooks just
    # never fire. Fail loudly here instead.
    if ! printf '%s' "$SETTINGS_CONFIG" | jq empty 2>/dev/null; then
        echo "[entrypoint] FATAL: SETTINGS_CONFIG is not valid JSON after assembly" >&2
        echo "[entrypoint] First 200 chars: $(printf '%s' "$SETTINGS_CONFIG" | cut -c1-200)" >&2
        exit 1
    fi
    echo "[entrypoint] Advanced mode: configuring settings.json with hooks"
else
    SETTINGS_CONFIG='{"skipDangerousModePermissionPrompt":true}'
    echo "[entrypoint] Default mode: configuring settings.json without hooks"
fi

SETTINGS_FILE="$USER_CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    TMP_SETTINGS=$(mktemp)
    JQ_ERR=$(mktemp)
    # Implements REQ-AGENT-008
    # Merge non-hooks settings with *, rebuild hooks separately to avoid
    # jq array-replace destroying user-added hooks or leaving stale managed hooks.
    # "Managed" = command path contains plugins/(codeflare-(hooks|memory|
    # vault)|graphify)/scripts/ (anchored on the literal `plugins/` segment
    # so unrelated future directories with the same basename cannot match),
    # references enforce-ctx-mode.sh (both the legacy ~/.claude/hooks/ path
    # and the current ~/.claude/plugins/context-mode/scripts/ path), OR is
    # a context-mode hook invocation (any of: bare `context-mode`,
    # `bunx context-mode@*`, or `npx -y context-mode@*` for legacy compat
    # with sessions that still have stale settings.json from before the
    # build-time install landed). Adding to MANAGED_HOOKS_REGEX must
    # happen here AND in any other place that prunes managed hooks.
    if jq --argjson cfg "$SETTINGS_CONFIG" '
      . as $orig |
      (del(.hooks) * ($cfg | del(.hooks))) +
      {hooks: (
        (($orig.hooks // {}) | keys) + (($cfg.hooks // {}) | keys) | unique |
        map(. as $type |
          ($orig.hooks[$type] // []) as $existArr |
          ($cfg.hooks[$type] // []) as $cfgArr |
          {key: $type, value: (
            [($existArr[] | .matcher // ""), ($cfgArr[] | .matcher // "")] | unique |
            map(. as $m |
              [$existArr[] | select((.matcher // "") == $m) | (.hooks // [])[] |
                select((.command // "") | test("plugins/(codeflare-(hooks|memory|vault)|graphify)/scripts/|enforce-ctx-mode\\.sh|(^context-mode |(bunx|npx) (-y )?context-mode@.* hook claude-code)") | not)
              ] as $user |
              [$cfgArr[] | select((.matcher // "") == $m) | (.hooks // [])[]] as $mgr |
              {matcher: $m, hooks: ($user + $mgr)}
            ) | map(select(.hooks | length > 0))
          )}
        ) | from_entries |
        with_entries(select(.value | length > 0))
      )}
    ' "$SETTINGS_FILE" > "$TMP_SETTINGS" 2>"$JQ_ERR"; then
        mv "$TMP_SETTINGS" "$SETTINGS_FILE"
    else
        echo "[entrypoint] WARNING: Could not merge settings config: $(cat "$JQ_ERR")"
        rm -f "$TMP_SETTINGS"
    fi
    rm -f "$JQ_ERR"
else
    echo "$SETTINGS_CONFIG" | jq '.' > "$SETTINGS_FILE"
fi

# Ensure any .mjs hook files in ~/.claude/hooks/ are executable. The CLI
# self-installs context-mode-cache-heal.mjs as a SessionStart hook with mode
# 0644, then calls it via shebang (#!/usr/bin/env node). /bin/sh refuses to
# exec a non-executable file with "Permission denied", which surfaces in the
# UI as "SessionStart:resume hook error". Defensive chmod every entrypoint
# run so the bug cannot survive a bisync round-trip.
if [ -d "$USER_CLAUDE_DIR/hooks" ]; then
    find "$USER_CLAUDE_DIR/hooks" -maxdepth 2 -name '*.mjs' -type f -exec chmod 0755 {} +
fi

# Enable plugins (silently skipped if plugin files absent in default mode).
# context-mode and graphify are conditionally enabled via the preseed-plugin gates.
if [ -f "$CONTEXT_MODE_MANIFEST" ]; then
    PLUGINS_CONFIG='{"enabledPlugins":{"codeflare-memory":true,"codeflare-hooks":true,"context-mode":true}}'
    echo "[entrypoint] context-mode plugin enabled (preseed manifest present)"
else
    PLUGINS_CONFIG='{"enabledPlugins":{"codeflare-memory":true,"codeflare-hooks":true}}'
fi
if [ -f "$GRAPHIFY_MANIFEST" ]; then
    PLUGINS_CONFIG=$(echo "$PLUGINS_CONFIG" | jq '.enabledPlugins["graphify"] = true')
    echo "[entrypoint] graphify plugin enabled (preseed manifest present)"
fi
if [ -f "$USER_CLAUDE_JSON" ]; then
    TMP_PLUGINS=$(mktemp)
    if jq --argjson cfg "$PLUGINS_CONFIG" '. * $cfg' "$USER_CLAUDE_JSON" > "$TMP_PLUGINS" 2>/dev/null; then
        mv "$TMP_PLUGINS" "$USER_CLAUDE_JSON"
    else
        echo "[entrypoint] WARNING: Could not merge plugin enablement (malformed .claude.json?)"
        rm -f "$TMP_PLUGINS"
    fi
else
    echo "$PLUGINS_CONFIG" | jq '.' > "$USER_CLAUDE_JSON"
fi
echo "[entrypoint] codeflare-memory and codeflare-hooks plugins enabled in .claude.json"

# Configure git credential helper for pre-configured deploy tokens
if [ -n "${GH_TOKEN:-}" ]; then
    git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
    echo "[entrypoint] Git credential helper configured for GH_TOKEN"
fi

# === Fast Start: tool-specific config files ===
if [ "${FAST_CLI_START:-true}" != "false" ]; then
    # Gemini: merge enableAutoUpdate:false into settings (file may be synced via rclone)
    mkdir -p "$USER_HOME/.gemini"
    if [ -f "$USER_HOME/.gemini/settings.json" ]; then
        jq '. * {"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}' \
            "$USER_HOME/.gemini/settings.json" > /tmp/gemini-settings.json 2>/dev/null && \
            mv /tmp/gemini-settings.json "$USER_HOME/.gemini/settings.json"
    else
        echo '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}' \
            > "$USER_HOME/.gemini/settings.json"
    fi

    # Codex: dismiss version notification (excluded from rclone sync)
    mkdir -p "$USER_HOME/.codex"
    echo '{"dismissed_version":"999.0.0"}' > "$USER_HOME/.codex/version.json"
fi

# Configure tab auto-start
configure_tab_autostart

# Step 2: Establish bisync baseline IN BACKGROUND (don't block startup)
# Runs AFTER all file modifications (.claude.json, .claude/settings.json, .gemini/settings.json,
# .codex/version.json, .bashrc tab autostart) to avoid hash mismatches from files changing during --resync.
if [ $RCLONE_CONFIG_RESULT -eq 0 ] && [ "${STEP1_RESULT:-1}" -eq 0 ]; then
    (
        echo "[entrypoint] Establishing bisync baseline in background..."
        if establish_bisync_baseline; then
            echo "[entrypoint] Bisync baseline established, starting daemon..."
        else
            echo "[entrypoint] WARNING: Bisync baseline failed — starting daemon anyway (daemon has its own recovery)" | tee -a /tmp/sync.log
        fi
        # ----------------------------------------------------------------------
        # Vault skeleton + global graph seed (REQ-MEMORY-100, REQ-MEMORY-105)
        # Runs AFTER baseline so we never overwrite R2-restored vault content
        # with an empty skeleton on returning sessions.
        # Idempotent: skip if vault directory already present.
        # ----------------------------------------------------------------------
        (init_user_vault) || echo "[entrypoint] WARNING: vault init failed; continuing"
        # Always start daemons — even if baseline failed.
        # Each daemon has its own retry + recovery; a dead daemon means
        # zero sync (or zero vault ingestion) for the entire session.
        start_sync_daemon
        start_vault_monitor_daemon
        start_silverbullet_supervisor
    ) &
    BISYNC_INIT_PID=$!
    echo "[entrypoint] Bisync init running in background (PID $BISYNC_INIT_PID)"
fi

# ============================================================================
# Init complete — release the terminal server's PTY pre-warm.
# The server has been listening on port 8080 since the top of MAIN EXECUTION;
# it has been polling for this flag file before spawning the tab-1 PTY so
# that pre-warm reads the final .claude.json / .bashrc rather than pre-sync
# state.
# ============================================================================
touch "$CODEFLARE_INIT_FLAG_FILE"
echo "[entrypoint] Init complete — wrote $CODEFLARE_INIT_FLAG_FILE (releasing PTY pre-warm)"

echo "[entrypoint] Startup complete. Servers running:"
echo "[entrypoint]   - Terminal server (port 8080): PID $TERMINAL_PID"
SYNC_PID=$(cat /tmp/sync-daemon.pid 2>/dev/null || echo '')
if [ -n "$SYNC_PID" ]; then
    echo "[entrypoint]   - Sync daemon: PID $SYNC_PID"
fi

# Keep container alive by waiting for terminal server
wait $TERMINAL_PID
