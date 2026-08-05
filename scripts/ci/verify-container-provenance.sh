#!/usr/bin/env bash
set -euo pipefail

IMAGE_URI=${1:-}
REPOSITORY=${2:-}
SIGNER_WORKFLOW=${3:-}

if [[ ! "$IMAGE_URI" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "Invalid digest-pinned container image URI" >&2
  exit 1
fi
if [[ ! "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid GitHub repository identity" >&2
  exit 1
fi
if [[ "$SIGNER_WORKFLOW" != "$REPOSITORY/.github/workflows/container-image.yml" ]]; then
  echo "Unexpected container provenance signer" >&2
  exit 1
fi

gh attestation verify "oci://${IMAGE_URI}" \
  --repo "$REPOSITORY" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --predicate-type 'https://slsa.dev/provenance/v1' \
  >/dev/null
