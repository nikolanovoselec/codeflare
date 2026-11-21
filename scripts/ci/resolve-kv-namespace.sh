#!/usr/bin/env bash
set -eo pipefail

KV_TITLE="${WORKER_NAME:?Worker name is required}-kv"

if ! LIST=$(npx wrangler kv namespace list); then
  echo '::error::Could not list KV namespaces — refusing to guess.' >&2
  exit 1
fi

# Read exactly one complete inventory. Only a valid list with no matching
# title may authorize creation; empty stdout is not an empty inventory.
if ! KV_ID=$(jq -ser --arg title "$KV_TITLE" '
  if length != 1 or (.[0] | type) != "array" then error("expected one namespace array") else .[0] end
  | if all(.[]; type == "object" and (.title | type == "string" and test("\\S"))
      and (.id | type == "string" and length == 32 and test("^[a-f0-9]{32}$")))
    then map(select(.title == $title)) else error("invalid namespace record") end
  | if length > 1 then error("duplicate matching namespace titles") else (.[0].id // "") end
' <<< "$LIST"); then
  echo '::error::KV namespace list is unusable — refusing to create or rebind.' >&2
  exit 1
fi

if [ -z "$KV_ID" ]; then
  echo "Creating KV namespace: $KV_TITLE"
  KV_ID=$(npx wrangler kv namespace create "$KV_TITLE" 2>&1 \
    | grep -oP '"[a-f0-9]{32}"' | tr -d '"' | head -1)
fi

if [ -z "$KV_ID" ]; then
  echo '::error::Failed to resolve KV namespace ID' >&2
  exit 1
fi

echo "KV namespace ID: $KV_ID"
sed -i "s/id = \"placeholder\"/id = \"$KV_ID\"/" wrangler.toml
