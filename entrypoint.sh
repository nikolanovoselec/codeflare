#!/bin/bash
set -euo pipefail
# Build: 2026-02-04.8 - Single port (8080) for all services
BUILD_VERSION="2026-02-04.8"
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
#   "metadata" = only CLAUDE.md and .claude/ per repo (lightweight, restore later if needed)
SYNC_MODE="${SYNC_MODE:-none}"

if [ "$SYNC_MODE" = "metadata" ]; then
    RCLONE_FILTERS=(
        --filter "- .bashrc"
        --filter "- .bash_profile"
        --filter "- .config/rclone/**"
        --filter "- .cache/rclone/**"
        --filter "- .npm/**"
        --filter "- .claude/plugins/cache/**"
        --filter "- .claude/debug/**"
        --filter "- **/node_modules/**"
        --filter "+ workspace/**/"
        --filter "+ workspace/CLAUDE.md"
        --filter "+ workspace/**/CLAUDE.md"
        --filter "+ workspace/.claude/**"
        --filter "+ workspace/**/.claude/**"
        --filter "- workspace/**"
    )
elif [ "$SYNC_MODE" = "none" ]; then
    RCLONE_FILTERS=(
        --filter "- .bashrc"
        --filter "- .bash_profile"
        --filter "- .config/rclone/**"
        --filter "- .cache/rclone/**"
        --filter "- .npm/**"
        --filter "- .claude/plugins/cache/**"
        --filter "- .claude/debug/**"
        --filter "- **/node_modules/**"
        --filter "- workspace/"
        --filter "- workspace/**"
    )
else
    RCLONE_FILTERS=(
        --filter "- .bashrc"
        --filter "- .bash_profile"
        --filter "- .config/rclone/**"
        --filter "- .cache/rclone/**"
        --filter "- .npm/**"
        --filter "- .claude/plugins/cache/**"
        --filter "- .claude/debug/**"
        --filter "- **/node_modules/**"
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

    if timeout $BISYNC_TIMEOUT rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --resync \
        --fast-list \
        --conflict-resolve newer \
        --resilient \
        --recover \
        --contimeout 10s \
        --timeout 30s \
        --transfers 32 --checkers 32 -v 2>&1 | tee -a /tmp/sync.log; then
        SYNC_RESULT=0
    else
        SYNC_RESULT=$?
    fi
    if [ $SYNC_RESULT -eq 0 ]; then
        echo "[entrypoint] Step 2 complete: Bisync baseline established"
        touch /tmp/.bisync-initialized
        SYNC_STATUS="success"
        return 0
    elif [ $SYNC_RESULT -eq 124 ]; then
        echo "[entrypoint] WARNING: Bisync baseline timed out after ${BISYNC_TIMEOUT}s"
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
# Syncs config, credentials - excludes caches and workspace
bisync_with_r2() {
    echo "[sync] Running bidirectional sync..." | tee -a /tmp/sync.log

    # Clear stale bisync lock if no bisync is running
    local LOCK_FILE="/home/user/.cache/rclone/bisync/home_user..r2_${R2_BUCKET_NAME}.lck"
    local BISYNC_RUNNING=0
    if command -v pgrep >/dev/null 2>&1; then
        if pgrep -f "rclone bisync" >/dev/null 2>&1; then
            BISYNC_RUNNING=1
        fi
    else
        if ps -ef | grep -v grep | grep -q "rclone bisync"; then
            BISYNC_RUNNING=1
        fi
    fi
    if [ -f "$LOCK_FILE" ] && [ "$BISYNC_RUNNING" -eq 0 ]; then
        echo "[sync] Removing stale bisync lock: $LOCK_FILE" | tee -a /tmp/sync.log
        rclone deletefile "$LOCK_FILE" 2>/dev/null || rm -f "$LOCK_FILE"
    fi

    # Write output to temp file so we can capture exit code AND log it
    SYNC_OUTPUT=$(mktemp)

    # First try normal bisync (capture exit code without triggering set -e)
    if rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
        --config "$RCLONE_CONFIG" \
        "${RCLONE_FILTERS[@]}" \
        --fast-list \
        --conflict-resolve newer \
        --resilient \
        --recover \
        --transfers 32 --checkers 32 -v 2>&1 > "$SYNC_OUTPUT"; then
        RESULT=0
    else
        RESULT=$?
    fi
    cat "$SYNC_OUTPUT" >> /tmp/sync.log
    cat "$SYNC_OUTPUT"

    # If bisync failed (especially due to empty listing), try with --resync
    if [ $RESULT -ne 0 ]; then
        echo "[sync] Normal bisync failed (exit $RESULT), attempting --resync..." | tee -a /tmp/sync.log
        if rclone bisync "$USER_HOME/" "r2:$R2_BUCKET_NAME/" \
            --config "$RCLONE_CONFIG" \
            "${RCLONE_FILTERS[@]}" \
            --conflict-resolve newer \
            --resync \
            --resilient \
            --recover \
            --transfers 32 --checkers 32 -v 2>&1 > "$SYNC_OUTPUT"; then
            RESULT=0
        else
            RESULT=$?
        fi
        cat "$SYNC_OUTPUT" >> /tmp/sync.log
        cat "$SYNC_OUTPUT"
    fi

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

    while true; do
        sleep 60
        echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Running periodic bisync..." | tee -a /tmp/sync.log

        # Use bisync for true bidirectional sync with newest-wins
        if bisync_with_r2; then
            SYNC_RESULT=0
        else
            SYNC_RESULT=$?
        fi

        if [ $SYNC_RESULT -eq 0 ]; then
            echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Bisync completed successfully" | tee -a /tmp/sync.log
        else
            echo "[sync-daemon] $(date '+%Y-%m-%d %H:%M:%S') Bisync failed with exit code $SYNC_RESULT (will retry in 60s)" | tee -a /tmp/sync.log
        fi
    done &

    SYNC_DAEMON_PID=$!
    echo "$SYNC_DAEMON_PID" > /tmp/sync-daemon.pid
    echo "[entrypoint] Bisync daemon started with PID $SYNC_DAEMON_PID"
}

# ============================================================================
# Shutdown handler - final bisync on SIGTERM
# ============================================================================
shutdown_handler() {
    echo "[entrypoint] Received shutdown signal, performing final bisync..."

    # Kill sync daemon (try PID file first, then variable fallback)
    kill "$(cat /tmp/sync-daemon.pid 2>/dev/null)" 2>/dev/null || true
    if [ -n "$SYNC_DAEMON_PID" ]; then
        kill "$SYNC_DAEMON_PID" 2>/dev/null || true
    fi

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
trap shutdown_handler SIGTERM SIGINT

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
# Tab 1: Claude Code (unleashed mode)
# Tab 2: htop (system monitor)
# Tab 3: yazi (file manager)
# Tab 4-6: Plain bash terminal in workspace
if [ -t 1 ] && [ -z "$TERMINAL_APP_STARTED" ]; then
    export TERMINAL_APP_STARTED=1
    export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

    cd "$HOME/workspace" 2>/dev/null || cd "$HOME"

    case "${TERMINAL_ID:-1}" in
        1)
            # Tab 1: Claude Code (via claude-unleashed)
            # Auto-start: silent + no-consent for non-interactive boot
            # Updates enabled — pre-patched at build time, so update check is fast (~2s)
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
                codex|claude|opencode)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # ${cmd} (direct exec)
            exec ${cmd}
            ;;
CASE_EOF
                    ;;
                gemini)
                    cat >> "$BASHRC_FILE" << CASE_EOF
        ${key})
            # ${cmd} (direct exec, suppress punycode deprecation warning)
            exec env NODE_OPTIONS="--disable-warning=DEP0040" ${cmd}
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
BASHRC_FOOTER
    fi

    echo "configured" > /tmp/claude-autostart-status.txt
    echo "[entrypoint] Tab auto-start configured"
    return 0
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

        # Step 2: Establish bisync baseline IN BACKGROUND (don't block startup)
        (
            echo "[entrypoint] Establishing bisync baseline in background..."
            if establish_bisync_baseline; then
                echo "[entrypoint] Bisync baseline established, starting daemon..."
                start_sync_daemon
            else
                echo "[entrypoint] Bisync baseline failed, daemon not started"
            fi
        ) &
        BISYNC_INIT_PID=$!
        echo "[entrypoint] Bisync init running in background (PID $BISYNC_INIT_PID)"
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

# Configure tab auto-start
configure_tab_autostart

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
