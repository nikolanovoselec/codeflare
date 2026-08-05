#!/usr/bin/env bash
set -euo pipefail

REGISTRY=${REGISTRY:-}
DIGEST=${DIGEST:-}
REPOSITORY=${REPOSITORY:-}
SIGNER_WORKFLOW=${SIGNER_WORKFLOW:-}
OUTPUT_PATH=${GITHUB_OUTPUT:-}

if [[ -z "$OUTPUT_PATH" ]]; then
  echo 'GITHUB_OUTPUT is required for container reuse selection' >&2
  exit 1
fi

case "$REGISTRY" in
  dockerhub) IMAGE_REPO="docker.io/${DOCKERHUB_USER:-}/${IMAGE_NAME:-}" ;;
  cloudflare)
    IMAGE_REPO="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID:-}/${IMAGE_NAME:-}"
    trap 'docker logout registry.cloudflare.com >/dev/null 2>&1 || true' EXIT
    ;;
  *) echo 'Unsupported container registry' >&2; exit 1 ;;
esac

PINNED_URI="${IMAGE_REPO}@${DIGEST}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if "$SCRIPT_DIR/verify-container-provenance.sh" "$PINNED_URI" "$REPOSITORY" "$SIGNER_WORKFLOW"; then
  echo 'reused=true' >> "$OUTPUT_PATH"
  echo "Identical-input image and provenance verified: ${PINNED_URI} — skipping build/scan/push"
else
  echo '::warning::Existing image has no valid Codeflare build provenance — building fresh'
fi
