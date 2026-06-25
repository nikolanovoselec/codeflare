/**
 * REQ-VAULT-021: stable, opaque per-bucket vault token.
 *
 * SilverBullet derives its IndexedDB names (client `sb_data_*`, service-worker
 * `sb_files_*`) by hashing the vault's directory URL together with the encryption
 * key. Serving the SB app under a per-SESSION URL (`/api/vault/<sid>/`) therefore
 * produced a brand-new IndexedDB every session and forced a full re-index on every
 * open. We instead serve the SB app under a bucket-stable URL
 * (`/api/vault/b/<token>/`) so the DB names are identical across sessions for the
 * same user and the persisted index/cache survives.
 *
 * The token is a truncated SHA-256 of the R2 bucket name. The bucket name embeds the
 * sanitized email (see `getBucketName`), so we hash it rather than expose it: the URL
 * carries no PII, and the value is deterministic per bucket (the property the DB-name
 * stability depends on). The actual session id is carried out-of-band in the
 * `cf_vault_sid` cookie, never in this URL, so `location.href` stays bucket-stable.
 */

const TOKEN_SALT = 'codeflare-vault-bucket-token';

/** Matches the 32-hex-char token produced by getVaultBucketToken. */
export const VAULT_BUCKET_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export async function getVaultBucketToken(bucketName: string): Promise<string> {
  const data = new TextEncoder().encode(`${TOKEN_SALT}:${bucketName}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
