#!/usr/bin/env bash
# Source once in the sync owner. Call after each transfer attempt, with its exact roots
# and captured exit status. The caller owns locking and routes stderr to its sync log.
cleanup_rclone_conflicts() {
    local local_root="${1%/}" remote_root="${2%/}" sync_result="${3:-0}"
    local cleanup_result=0 result
    local budget="${4:-30}" started=$SECONDS remaining

    if [ -z "$local_root" ] || [ ! -d "$local_root" ] || [ -L "$local_root" ] || [[ "$local_root" != /* ]] || [[ "$remote_root" != r2:?* ]] || [[ ! "$budget" =~ ^-?[0-9]+$ ]]; then
        echo "[sync] Conflict-copy cleanup failed: invalid sync roots" >&2
        cleanup_result=1
    else
        # -P never follows symlinks; -type f preserves directories and symlinks.
        # Do not inherit transfer filters: those deliberately exclude some conflicts.
        # Prune restricted operator roots before examining files. Do not use -delete:
        # it implies -depth, which would defeat -prune.
        if find -P "$local_root" \( -path "$local_root/Operators" -o -path "$local_root/.codeflare/operators" \) -prune -o \
            -type f -name '*.conflict*' -exec rm -f -- {} +; then
            :
        else
            cleanup_result=$?
            echo "[sync] Local conflict-copy cleanup failed ($cleanup_result)" >&2
        fi
        # A slash-free rclone glob matches basenames at every depth, including dots.
        # delete leaves directories intact, unlike purge (or delete --rmdirs).
        remaining=$((budget - (SECONDS - started)))
        if [ "$remaining" -gt 30 ]; then remaining=30; fi
        if [ "$remaining" -le 0 ]; then
            [ "$cleanup_result" -ne 0 ] || cleanup_result=124
            echo "[sync] Remote conflict-copy cleanup skipped: sync deadline exhausted" >&2
        elif timeout "$remaining" rclone delete "$remote_root" \
            --config "$RCLONE_CONFIG" \
            --filter '- /Operators/**' \
            --filter '- /.codeflare/operators/**' \
            --filter '+ *.conflict*' \
            --filter '- **' --fast-list --contimeout 10s --timeout 30s; then
            :
        else
            result=$?
            [ "$cleanup_result" -ne 0 ] || cleanup_result=$result
            echo "[sync] Remote conflict-copy cleanup failed ($result)" >&2
        fi
    fi

    # Never replace the original transfer error with cleanup's result.
    [ "$sync_result" -eq 0 ] || return "$sync_result"
    return "$cleanup_result"
}
