#!/usr/bin/env bash
set -euo pipefail

validate_release_source() {
  if [[ "${EVENT_NAME:-}" == "workflow_dispatch" && "${SOURCE_REF:-}" != "refs/heads/main" ]]; then
    echo "recovery signing must be dispatched from main" >&2
    return 1
  fi
  if [[ ! "${RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release tag must match vMAJOR.MINOR.PATCH" >&2
    return 1
  fi
  local release_json release_commit
  release_json="$(gh release view "$RELEASE_TAG" --json tagName,isDraft)"
  jq -e --arg tag "$RELEASE_TAG" \
    '.tagName == $tag and .isDraft == false' <<< "$release_json" >/dev/null
  release_commit="$(git rev-parse "$RELEASE_TAG^{commit}")"
  git fetch --no-tags origin main:refs/remotes/origin/main
  if ! git merge-base --is-ancestor "$release_commit" origin/main; then
    echo "$RELEASE_TAG does not identify a commit reachable from main" >&2
    return 1
  fi
  printf 'RELEASE_COMMIT=%s\n' "$release_commit" >> "${GITHUB_ENV:?GITHUB_ENV is required}"
}

build_release_assets() {
  : "${RELEASE_TAG:?RELEASE_TAG is required}"
  : "${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
  mkdir -p release-assets
  local archive="release-assets/codeflare-$RELEASE_TAG.tar.gz"
  git archive --format=tar --prefix="codeflare-$RELEASE_TAG/" "$RELEASE_COMMIT" | gzip -n > "$archive"
  (
    cd release-assets
    sha256sum "codeflare-$RELEASE_TAG.tar.gz" > SHA256SUMS
  )
}

sign_release_assets() {
  : "${RELEASE_TAG:?RELEASE_TAG is required}"
  local asset
  for asset in "release-assets/codeflare-$RELEASE_TAG.tar.gz" release-assets/SHA256SUMS; do
    test -f "$asset"
    cosign sign-blob --yes --bundle "$asset.sigstore.json" "$asset"
  done
}

upload_release_assets() {
  : "${RELEASE_TAG:?RELEASE_TAG is required}"
  gh release upload "$RELEASE_TAG" release-assets/* --clobber
}

case "${1:-}" in
  validate) validate_release_source ;;
  build) build_release_assets ;;
  sign) sign_release_assets ;;
  upload) upload_release_assets ;;
  *)
    echo "usage: $0 {validate|build|sign|upload}" >&2
    exit 2
    ;;
esac
