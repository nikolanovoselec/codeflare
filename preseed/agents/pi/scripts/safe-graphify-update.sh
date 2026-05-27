#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET"

# Pi-owned bounded AST update wrapper. Keeps interactive Pi graph builds local,
# bounded, and free of headless LLM/API-key extraction.
export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-2}"
export GRAPHIFY_NO_SEMANTIC="${GRAPHIFY_NO_SEMANTIC:-1}"

timeout "${GRAPHIFY_UPDATE_TIMEOUT:-120}" graphify update .
