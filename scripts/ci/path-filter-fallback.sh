#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
for sha in "$BASE_SHA" "$HEAD_SHA"; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git -c credential.helper='!gh auth git-credential' fetch --no-tags --depth=1 origin "$sha"
  fi
  git cat-file -e "${sha}^{commit}"
done

mkdir -p "$RUNNER_TEMP"
changed_files="$RUNNER_TEMP/changed-files.txt"
git diff --name-only "$BASE_SHA" "$HEAD_SHA" > "$changed_files"
printf '::warning::Path-filter API failed; selecting every lane from the verified local %s..%s diff (%s files).\n' \
  "$BASE_SHA" "$HEAD_SHA" "$(wc -l < "$changed_files")"
for lane in backend webui landing host pi ide workflows dependencies; do
  printf '%s=true\n' "$lane" >> "$GITHUB_OUTPUT"
done
