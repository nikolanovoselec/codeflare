#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CF_ACCESS_CLIENT_SECRET:-${OAUTH_E2E_TEST_SECRET:-}}" ]]; then
  echo 'No service-auth secret — skipping KV service-user seed'
  exit 0
fi

SERVICE_EMAIL='e2e-service@codeflare.local'
KV_VALUE="{\"addedBy\":\"deploy\",\"addedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"role\":\"admin\"}"
echo "Seeding service user: ${SERVICE_EMAIL}"

for attempt in 1 2 3; do
  if npx wrangler kv key put "user:${SERVICE_EMAIL}" "$KV_VALUE" --binding KV --remote; then
    exit 0
  fi
  if [[ "$attempt" -lt 3 ]]; then
    echo "::warning::Service-user seed failed (attempt $attempt/3); retrying in 5s"
    sleep 5
  fi
done

echo '::error::Configured service user could not be seeded after 3 attempts' >&2
exit 1
