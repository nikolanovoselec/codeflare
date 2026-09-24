#!/bin/sh
set -eu

selector="$(dirname "$0")/coding-agent-selection.mjs"
selection="$(node "$selector" resolve "$3")"

if cmp -s "$1" "$2"; then
  exit 0
else
  status=$?
fi

if [ "$status" -ne 1 ]; then
  printf 'ERROR: npm tool manifest comparison failed (status %s)\n' "$status" >&2
  exit "$status"
fi

# npm ci already installed the integrity-checked tree. npm prune fails while
# re-resolving its reduced Pi selection, so remove only omitted agent roots and
# launchers; leave shared and selected packages untouched.
for entry in \
  claude-code:@anthropic-ai/claude-code:claude \
  codex:@openai/codex:codex \
  copilot:@github/copilot:copilot \
  opencode:opencode-ai:opencode \
  pi:@earendil-works/pi-coding-agent:pi; do
  agent="${entry%%:*}"
  package="${entry#*:}"
  package="${package%:*}"
  bin="${entry##*:}"
  if node "$selector" has "$selection" "$agent"; then
    continue
  fi
  rm -rf -- "node_modules/$package"
  rm -f -- "node_modules/.bin/$bin"
  case "$agent" in
    claude-code) payloads='node_modules/@anthropic-ai/claude-code-' ;;
    codex) payloads='node_modules/@openai/codex-' ;;
    copilot) payloads='node_modules/@github/copilot-' ;;
    opencode) payloads='node_modules/opencode-' ;;
    pi) payloads='node_modules/@earendil-works/pi-coding-agent-' ;;
  esac
  for payload in "${payloads}"*; do
    [ -e "$payload" ] || [ -L "$payload" ] || continue
    rm -rf -- "$payload"
  done
  if [ "$agent" = copilot ]; then
    for platform_bin in node_modules/.bin/copilot-*; do
      [ -e "$platform_bin" ] || [ -L "$platform_bin" ] || continue
      rm -f -- "$platform_bin"
    done
  fi
done
