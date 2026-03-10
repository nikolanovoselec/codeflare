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
    unset CLAUDE_UNLEASHED_NO_UPDATE CLAUDE_UNLEASHED_CHANNEL OPENCODE_DISABLE_AUTOUPDATE DISABLE_INSTALLATION_CHECKS
else
    # Ensure all disable vars are set
    export CLAUDE_UNLEASHED_NO_UPDATE=1
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
    --filter "- .claude/plugins/marketplaces/**/.git/**"  # marketplace git clones (~2MB each, reinstalled from remote)
    --filter "- .claude/cache/**"            # changelog cache
    --filter "- .claude/debug/**"            # debug logs
    --filter "- .claude/file-history/**"     # per-session file edit history, grows unbounded
    --filter "- .claude/session-env/**"      # session environment variables
    --filter "- .claude/shell-snapshots/**"  # session shell state snapshots
    --filter "- .claude/stats-cache.json"    # regenerated usage stats
    --filter "- .claude.json.backup.*"       # auto-generated backups, accumulate endlessly

    # Codex — ephemeral session data and caches
    --filter "- .codex/log/**"               # TUI session logs
    --filter "- .codex/models_cache.json"    # regenerated model list
    --filter "- .codex/.personality_migration" # one-time migration marker
    --filter "- .codex/shell_snapshots/**"   # session shell snapshots
    --filter "- .codex/tmp/**"               # temp lock files
    --filter "- .codex/version.json"         # version check cache

    # Memory capture — persist counter files (2 lines each, needed for --resume), exclude ephemeral lock/vars
    --filter "- .memory/counter/*.lock"
    --filter "- .memory/counter/*.vars"

    # Perl CPAN cache — created by Perl module installs during build, regenerated
    --filter "- .cpan/**"

    # Gemini CLI — tmp contains a downloaded ripgrep binary (~5MB) and session chat logs
    --filter "- .gemini/tmp/**"

    # OpenCode — session logs and SQLite temp files (WAL/SHM cause sync conflicts)
    --filter "- .local/share/opencode/log/**"
    --filter "- .local/share/opencode/opencode.db-shm"
    --filter "- .local/share/opencode/opencode.db-wal"
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
establish_bisync_baseline() {
    local BISYNC_TIMEOUT=180  # 3 minutes max for baseline
    echo "[entrypoint] Step 2: Establishing bisync baseline (max ${BISYNC_TIMEOUT}s)..." | tee -a /tmp/sync.log

    BASELINE_OUTPUT=$(mktemp)
    if timeout $BISYNC_TIMEOUT rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --resync \
        --fast-list \
        --conflict-resolve newer \
        --resilient \
        --recover \
        --check-sync=false \
        --ignore-checksum \
        --max-delete 100 \
        --retries 3 --retries-sleep 10s \
        --transfers 32 --checkers 32 -v > "$BASELINE_OUTPUT" 2>&1; then
        SYNC_RESULT=0
    else
        SYNC_RESULT=$?
    fi
    cat "$BASELINE_OUTPUT" >> /tmp/sync.log
    cat "$BASELINE_OUTPUT"
    rm -f "$BASELINE_OUTPUT"
    if [ $SYNC_RESULT -eq 0 ]; then
        echo "[entrypoint] Step 2 complete: Bisync baseline established"
        touch /tmp/.bisync-initialized
        SYNC_STATUS="success"
        return 0
    elif [ $SYNC_RESULT -eq 124 ]; then
        echo "[entrypoint] WARNING: Bisync baseline timed out after ${BISYNC_TIMEOUT}s"
        touch /tmp/.bisync-initialized
        SYNC_STATUS="timeout"
        return 0  # Don't fail, just skip daemon
    else
        SYNC_ERROR="rclone bisync --resync failed with code $SYNC_RESULT"
        SYNC_STATUS="failed"
        echo "[entrypoint] ERROR: $SYNC_ERROR"
        return 1
    fi
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

    # Write output to temp file so we can capture exit code AND log it
    SYNC_OUTPUT=$(mktemp)

    # Run bisync
    if rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --fast-list \
        --conflict-resolve newer \
        --resilient \
        --recover \
        --check-sync=false \
        --ignore-checksum \
        --max-delete 100 \
        --retries 3 --retries-sleep 10s \
        --transfers 32 --checkers 32 "${verbose_args[@]}" > "$SYNC_OUTPUT" 2>&1; then
        RESULT=0
    else
        RESULT=$?
    fi
    cat "$SYNC_OUTPUT" >> /tmp/sync.log
    cat "$SYNC_OUTPUT"

    rm -f "$SYNC_OUTPUT"

    # Auto-clean conflict artifacts after successful bisync
    if [ $RESULT -eq 0 ]; then
        find /home/user -name "*.conflict*" -type f -delete 2>/dev/null || true
    fi
    return $RESULT
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
            CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
            echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Bisync failed with exit code $SYNC_RESULT (failure $CONSECUTIVE_FAILURES/3)" | tee -a /tmp/sync.log
            update_sync_status "failed" "Bisync exit code $SYNC_RESULT"

            # After 3 consecutive failures (each with 3 internal retries = 9 total attempts),
            # fall back to --resync to re-establish clean bisync state.
            # This merges both sides (files on only one side get copied to the other).
            if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
                echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') 3 consecutive failures — falling back to --resync" | tee -a /tmp/sync.log
                update_sync_status "failed" "Resync fallback triggered"
                establish_bisync_baseline
                CONSECUTIVE_FAILURES=0
            fi
        fi
    done &

    SYNC_DAEMON_PID=$!
    echo "$SYNC_DAEMON_PID" > /tmp/sync-daemon.pid
    echo "[entrypoint] Bisync daemon started with PID $SYNC_DAEMON_PID"
}

# ============================================================================
# Shutdown handler - final bisync on SIGTERM/SIGINT/EXIT
# ============================================================================
shutdown_handler() {
    echo "[entrypoint] Received shutdown signal, performing final bisync..."

    # Kill sync daemon via PID file
    kill "$(cat /tmp/sync-daemon.pid 2>/dev/null)" 2>/dev/null || true

    # Perform final bisync to R2 (only if baseline was established)
    echo "[entrypoint] Final bisync to R2..."
    if [ -f /tmp/.bisync-initialized ]; then
        if bisync_with_r2; then
            echo "[entrypoint] Final bisync completed successfully"
        else
            echo "[entrypoint] Final bisync failed!"
        fi
    else
        echo "[entrypoint] Skipping final bisync - baseline never established"
    fi

    # Kill child processes
    if [ -n "$TERMINAL_PID" ]; then
        kill "$TERMINAL_PID" 2>/dev/null || true
    fi

    echo "[entrypoint] Shutdown complete"
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
# Tab 1: Claude Code (cu)
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
            # Tab 1: Claude Code (via claude-unleashed)
            # Auto-start: silent + no-consent for non-interactive boot
            # Updates enabled (Fast Start is OFF -- tools will check for updates on launch)
            # Manual re-run: just `cu` or `claude-unleashed`
            cu --silent --no-consent
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
        # TAB_CONFIG format: [{"id":"1","command":"cu","label":"claude"},{"id":"2","command":"","label":"bash"},...]
        local tab_count
        tab_count=$(echo "$TAB_CONFIG" | jq -r 'length')

        for key in $(echo "$TAB_CONFIG" | jq -r '.[].id' | sort -n); do
            # Validate tab ID is a single digit 1-6 to prevent injection
            [[ "$key" =~ ^[1-6]$ ]] || continue

            local cmd
            cmd=$(echo "$TAB_CONFIG" | jq -r --arg id "$key" '.[] | select(.id == $id) | .command')

            case "$cmd" in
                cu|claude-unleashed)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # Claude Code (via claude-unleashed)
            ${cmd} --silent --no-consent
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
# Memory file merge/cleanup for persistent memory across sessions
# ============================================================================
merge_memory_files() {
    local MEMORY_DIR="$USER_HOME/.memory"
    local SESSION_FILE="$MEMORY_DIR/session-${SESSION_ID}.jsonl"
    mkdir -p "$MEMORY_DIR"

    local FILES=()
    while IFS= read -r -d '' f; do FILES+=("$f"); done \
        < <(find "$MEMORY_DIR" -name "session-*.jsonl" -type f -print0 2>/dev/null)

    if [ ${#FILES[@]} -eq 0 ]; then
        echo "[entrypoint] No memory files to merge"; return 0
    fi
    if [ ${#FILES[@]} -eq 1 ] && [ "${FILES[0]}" = "$SESSION_FILE" ]; then
        echo "[entrypoint] Single memory file already matches current session"; return 0
    fi

    echo "[entrypoint] Merging ${#FILES[@]} memory files into $SESSION_FILE"
    cat "${FILES[@]}" | node -e "
        const lines = require('fs').readFileSync('/dev/stdin','utf8').split('\n').filter(l=>l.trim());
        const entities = new Map(); const relations = new Set();
        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (item.type === 'entity') {
                    const existing = entities.get(item.name);
                    if (existing) {
                        const obs = new Set([...existing.observations, ...item.observations]);
                        existing.observations = [...obs];
                    } else { entities.set(item.name, {...item}); }
                } else if (item.type === 'relation') { relations.add(JSON.stringify(item)); }
            } catch {}
        }
        const out = [...entities.values(), ...[...relations].map(r=>JSON.parse(r))];
        console.log(out.map(o=>JSON.stringify(o)).join('\n'));
    " > "$SESSION_FILE.tmp"
    mv "$SESSION_FILE.tmp" "$SESSION_FILE"
    # Old session files are NOT deleted here — cleanup_old_memory_files() runs
    # after bisync baseline so deletions propagate correctly to R2.
    # Direct R2 deletion is unsafe: concurrent sessions would lose their active file
    # when bisync propagates the deletion to the other container.
    echo "[entrypoint] Memory merge complete (old files kept for bisync baseline)"
}

cleanup_old_memory_files() {
    local MEMORY_DIR="$USER_HOME/.memory"
    local KEEP=10
    local count=0

    # Keep the 10 newest session files (by mtime), delete the rest.
    # 10 >= MAX_SESSIONS_ADMIN, so no active session's file is ever deleted.
    # Bisync propagates local deletions to R2 on the next cycle.
    while IFS= read -r f; do
        rm -f "$f"
        count=$((count + 1))
    done < <(find "$MEMORY_DIR" -name "session-*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)

    if [ $count -gt 0 ]; then
        echo "[entrypoint] Cleaned up $count old memory files (kept $KEEP newest)"
    fi
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
# R2 SYNC STARTUP
# ============================================================================
# Note: claude-unleashed (cu --silent --no-consent) handles consent automatically,
# no pre-seeding needed.

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

# Merge memory files from previous sessions (after R2 sync pulls them down)
# Old files kept — cleanup happens after bisync baseline (Phase 2)
if [ -n "${SESSION_ID:-}" ]; then
    merge_memory_files
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

# Configure memory MCP server for Claude Code
# MCP servers are configured in ~/.claude.json (not ~/.claude/settings.json)
# See: https://code.claude.com/docs/en/mcp — "User and local scope: ~/.claude.json"
if [ -n "${SESSION_ID:-}" ]; then
    MEMORY_MCP_CONFIG="{\"mcpServers\":{\"memory\":{\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-memory\"],\"env\":{\"MEMORY_FILE_PATH\":\"${USER_HOME}/.memory/session-${SESSION_ID}.jsonl\"}}}}"
    if [ -f "$USER_CLAUDE_JSON" ]; then
        # Recursive merge — preserves ALL existing config (bypass consent, other MCP servers, etc.)
        # jq `*` merges objects recursively: only mcpServers.memory is added/updated
        TMP_JSON=$(mktemp)
        if jq --argjson mcp "$MEMORY_MCP_CONFIG" '. * $mcp' "$USER_CLAUDE_JSON" > "$TMP_JSON" 2>/dev/null; then
            mv "$TMP_JSON" "$USER_CLAUDE_JSON"
        else
            # jq failed (malformed JSON?) — do NOT overwrite, skip instead
            echo "[entrypoint] WARNING: Could not merge memory MCP config (malformed .claude.json?)"
            rm -f "$TMP_JSON"
        fi
    else
        echo "$MEMORY_MCP_CONFIG" | jq '.' > "$USER_CLAUDE_JSON"
    fi
    echo "[entrypoint] Memory MCP server configured for Claude Code"

    # Create counter directory for memory capture hook
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

# Configure Claude Code hooks in ~/.claude/settings.json
# Hooks: PreToolUse (block attributed commits), UserPromptSubmit (memory capture)
HOOKS_CONFIG='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash '"$USER_HOME"'/.claude/hooks/block-attributed-commits.sh"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"bash '"$USER_HOME"'/.claude/hooks/memory-capture.sh"}]}]}}'
SETTINGS_FILE="$USER_CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    TMP_SETTINGS=$(mktemp)
    if jq --argjson cfg "$HOOKS_CONFIG" '. * $cfg' "$SETTINGS_FILE" > "$TMP_SETTINGS" 2>/dev/null; then
        mv "$TMP_SETTINGS" "$SETTINGS_FILE"
    else
        echo "[entrypoint] WARNING: Could not merge hooks config (malformed settings.json?)"
        rm -f "$TMP_SETTINGS"
    fi
else
    echo "$HOOKS_CONFIG" | jq '.' > "$SETTINGS_FILE"
fi
echo "[entrypoint] Claude Code hooks configured in settings.json"

# Plugins: enable context7 + superpowers for advanced mode (detected by presence of rules/common/)
# ECC plugin removed — agents, commands, skills are preseeded directly to ~/.claude/ via agent-seed
if [ -d "$USER_CLAUDE_DIR/rules/common" ]; then
    PLUGINS_CONFIG='{"enabledPlugins":{"context7@claude-plugins-official":true,"superpowers@claude-plugins-official":true}}'
    TMP_SETTINGS=$(mktemp)
    if jq --argjson plugins "$PLUGINS_CONFIG" '. * $plugins' "$SETTINGS_FILE" > "$TMP_SETTINGS" 2>/dev/null; then
        mv "$TMP_SETTINGS" "$SETTINGS_FILE"
    else
        rm -f "$TMP_SETTINGS"
    fi

    echo "[entrypoint] Plugins enabled (context7, superpowers), cherry-picked agents/commands/skills preseeded"

    # Fix superpowers plugin SessionStart hook quoting bug (5.0.0+)
    # Upstream uses single quotes around ${CLAUDE_PLUGIN_ROOT} which prevents variable expansion
    for hooks_json in "$USER_HOME/.claude/plugins/cache/claude-plugins-official/superpowers"/*/hooks/hooks.json; do
        [ -f "$hooks_json" ] || continue
        if grep -q "'\${CLAUDE_PLUGIN_ROOT}" "$hooks_json" 2>/dev/null; then
            sed -i "s|'\${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd'|bash \"\${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\"|g" "$hooks_json"
            echo "[entrypoint] Fixed superpowers hook quoting in $(dirname "$hooks_json")"
        fi
    done
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
            # Cleanup old memory files AFTER baseline — bisync will propagate deletions to R2
            if [ -n "${SESSION_ID:-}" ]; then
                cleanup_old_memory_files
            fi
            echo "[entrypoint] Bisync baseline established, starting daemon..."
            start_sync_daemon
        else
            echo "[entrypoint] Bisync baseline failed, daemon not started"
        fi
    ) &
    BISYNC_INIT_PID=$!
    echo "[entrypoint] Bisync init running in background (PID $BISYNC_INIT_PID)"
fi

# ============================================================================
# Start servers AFTER initial sync completes
# ============================================================================

echo "[entrypoint] Starting terminal server on port 8080..."
cd /app/host && HOME="$USER_HOME" TERMINAL_PORT=8080 node server.js &
TERMINAL_PID=$!
echo "$TERMINAL_PID" > /tmp/terminal.pid
echo "[entrypoint] Terminal server started with PID $TERMINAL_PID"

sleep 0.5

if kill -0 "$TERMINAL_PID" 2>/dev/null; then
    echo "[entrypoint] Terminal server is running"
else
    echo "[entrypoint] WARNING: Terminal server failed to start!"
fi

# Terminal server now handles all endpoints (health metrics consolidated)
echo "[entrypoint] Startup complete. Servers running:"
echo "[entrypoint]   - Terminal server (port 8080): PID $TERMINAL_PID"
SYNC_PID=$(cat /tmp/sync-daemon.pid 2>/dev/null || echo '')
if [ -n "$SYNC_PID" ]; then
    echo "[entrypoint]   - Sync daemon: PID $SYNC_PID"
fi

# Keep container alive by waiting for terminal server
wait $TERMINAL_PID
